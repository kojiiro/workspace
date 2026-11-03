import { useEffect, useRef, useState } from "react";
import type { ChatMessage, EventEnvelope, GatewayError, NpcDescriptor, SendChatResponse } from "@glc/shared";
import { mountHeadquarters } from "./game";
import type { HeadquartersBridge } from "./game";

type UIMessage = Pick<ChatMessage, "role" | "content">;
function errorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: GatewayError }).error;
    if (err?.message) return err.message;
  }
  return "The local gateway could not complete this request.";
}

function App() {
  const world = useRef<HTMLDivElement>(null);
  const worldBridge = useRef<HeadquartersBridge | null>(null);
  const selectNpcRef = useRef<(id:string)=>void>(()=>{});
  const [npcs, setNpcs] = useState<NpcDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState("john");
  const selectedIdRef = useRef("john");
  const npc = npcs.find(item => item.id === selectedId) ?? null;
  const [menu, setMenu] = useState(false);
  const [chat, setChat] = useState(false);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState("");

  // A single EventSource is maintained for the lifetime of the component.
  // Events can arrive before POST /api/chat returns its runId: buffer those.
  const eventSource = useRef<EventSource | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const awaitingAckRef = useRef(false);
  const bufferedRef = useRef<Map<string, EventEnvelope[]>>(new Map());
  const currentStream = useRef("");
  const submittedText = useRef("");
  const timerRef = useRef<number | null>(null);
  const failRef = useRef<(reason: string) => void>(() => {});
  const handleEventRef = useRef<(envelope: EventEnvelope) => void>(() => {});

  function clearWatchdog() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function failCurrent(reason: string) {
    if (!activeRunRef.current && !awaitingAckRef.current) return;
    clearWatchdog();
    // A failed message was never committed to server history, so remove
    // the optimistic user bubble and restore the text for retry.
    const attempted = submittedText.current;
    setMessages(previous => {
      const last = previous.at(-1);
      return last?.role === "user" && last.content === attempted ? previous.slice(0, -1) : previous;
    });
    setText(previous => previous || attempted);
    currentStream.current = "";
    bufferedRef.current.clear();
    awaitingAckRef.current = false;
    activeRunRef.current = null;
    setStream("");
    setBusy(false);
    setRunId(undefined);
    setError(reason);
  }
  failRef.current = failCurrent;

  function applyEvent(envelope: EventEnvelope) {
    const ev = envelope.event;
    if (ev.type === "npc.status") {
      setNpcs(previous => previous.map(item => item.id === ev.npcId ? { ...item, status: ev.status } : item));
      return;
    }
    if (!("runId" in ev)) return;
    if (ev.runId !== activeRunRef.current) {
      if (awaitingAckRef.current) {
        const batch = bufferedRef.current.get(ev.runId) ?? [];
        if (batch.length < 300) batch.push(envelope);
        bufferedRef.current.set(ev.runId, batch);
      }
      return;
    }
    if (ev.type === "run.delta") {
      currentStream.current += ev.text;
      setStream(currentStream.current);
    } else if (ev.type === "run.completed") {
      const answer = currentStream.current;
      setMessages(previous => [...previous, { role: "assistant", content: answer || "(empty response)" }]);
      currentStream.current = "";
      bufferedRef.current.clear();
      activeRunRef.current = null;
      clearWatchdog();
      setStream("");
      setRunId(undefined);
      setBusy(false);
      setError("");
    } else if (ev.type === "run.failed" || ev.type === "run.cancelled") {
      failCurrent(ev.type === "run.failed" ? ev.error.message : "Mission cancelled.");
    }
  }
  handleEventRef.current = applyEvent;

  useEffect(() => {
    let mounted = true;
    fetch("/api/npcs")
      .then(response => response.ok ? response.json() : Promise.reject(new Error("NPC registry unavailable")))
      .then((list: NpcDescriptor[]) => {
        if (!mounted) return;
        setNpcs(list);
      })
      .catch(() => {});

    const events = new EventSource("/api/events");
    eventSource.current = events;
    events.onopen = () => {
      if (!mounted) return;
      setStatus("online");
      setError(previous => previous.startsWith("Event stream") ? "" : previous);
    };
    events.onmessage = message => {
      try { handleEventRef.current(JSON.parse(message.data) as EventEnvelope); }
      catch { /* malformed gateway event is ignored, watchdog handles missing completions */ }
    };
    events.onerror = () => {
      if (!mounted) return;
      if (events.readyState === EventSource.CLOSED) {
        setStatus("offline");
        failRef.current("Event stream closed. Please restart the local gateway.");
      } else {
        setStatus("connecting");
        if (activeRunRef.current) setError("Event stream interrupted. Reconnecting…");
      }
    };
    return () => {
      mounted = false;
      events.close();
      eventSource.current = null;
    };
  }, []);

  function selectNpc(id: string) {
    if (activeRunRef.current || awaitingAckRef.current) {
      setError("Finish or cancel the current mission before changing personnel.");
      return;
    }
    if (!npcs.some(item => item.id === id)) return;
    if (selectedIdRef.current !== id) {
      // Each NPC owns its own conversation. Until multi-conversation storage is
      // implemented, selecting another character resets the local chat view.
      setMessages([]);
      setConversationId(undefined);
      setText("");
      setError("");
      setStream("");
    }
    selectedIdRef.current = id;
    setSelectedId(id);
    setChat(false);
    setMenu(true);
  }

  selectNpcRef.current = selectNpc;
  const isRegistryReady = npcs.length > 0;
  // Mount Phaser only once. Changing an NPC's health/status must not reset
  // camera, animations, or scene assets.
  useEffect(() => {
    const node=world.current;
    if (!node || !isRegistryReady) return;
    const bridge=mountHeadquarters(node, npcs, id=>selectNpcRef.current(id));
    worldBridge.current=bridge;
    return () => {
      worldBridge.current=null;
      bridge.destroy();
    };
  }, [isRegistryReady]);

  useEffect(() => {
    worldBridge.current?.updateNpcs(npcs);
  }, [npcs]);

  useEffect(() => () => { clearWatchdog(); }, []);

  async function send() {
    const content = text.trim();
    if (!content || busy || status !== "online" || !npc?.capabilities.some(c => c.id === "chat")) return;
    setError("");
    setText("");
    setMenu(false);
    setMessages(previous => [...previous, { role: "user", content }]);
    setStream("");
    currentStream.current = "";
    submittedText.current = content;
    bufferedRef.current.clear();
    awaitingAckRef.current = true;
    setBusy(true);
    clearWatchdog();
    timerRef.current = window.setTimeout(() => {
      if (!awaitingAckRef.current && !activeRunRef.current) return;
      const active = activeRunRef.current;
      if (active) void fetch("/api/runs/" + active + "/cancel", { method: "POST" }).catch(() => {});
      failRef.current("The stream did not complete in time. Please try again.");
    }, 32_000);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ npcId: npc.id, conversationId, text: content })
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        // The gateway stores conversations in memory in v0.1. Restarting it
        // invalidates the previous ID, so automatically release the stale ID.
        const gatewayError =
          data && typeof data === "object" && "error" in data
            ? (data as { error?: GatewayError }).error
            : undefined;
        if (response.status === 404 && conversationId &&
            gatewayError?.code === "unavailable" &&
            gatewayError.message === "Conversation not found.") {
          setConversationId(undefined);
          // Old bubbles no longer represent messages stored by the gateway.
          // failCurrent will restore the most recent unsent text for a retry.
          setMessages([]);
          throw new Error("The previous conversation was lost after the gateway restarted. Your message was restored; send it again to start a new conversation.");
        }
        throw new Error(errorText(data));
      }
      const payload = data as SendChatResponse;
      setConversationId(payload.conversationId);
      activeRunRef.current = payload.runId;
      awaitingAckRef.current = false;
      setRunId(payload.runId);
      const queued = bufferedRef.current.get(payload.runId) ?? [];
      bufferedRef.current.clear();
      for (const item of queued) applyEvent(item);
    } catch (reason) {
      failRef.current(reason instanceof Error ? reason.message : "Network error");
    }
  }

  async function cancel() {
    if (!runId) return;
    try {
      const response = await fetch("/api/runs/" + runId + "/cancel", { method: "POST" });
      if (!response.ok) setError("Could not cancel the current mission.");
    } catch {
      setError("Could not reach gateway to cancel.");
    }
  }

  return <div className="shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◉</span>
        <span><strong>GREEN LANTERN CORPS</strong><small>COMMAND CENTER / LOCAL WORKSPACE</small></span>
      </div>
      <div className="topbar-right"><span className="version">PROTOTYPE 0.2 / REGISTRY</span><span className={`connection ${status}`}><i />{status==="online"?"GATEWAY ONLINE":status==="offline"?"GATEWAY OFFLINE":"CONNECTING"}</span></div>
    </header>
    <div className="layout">
      <aside className="sidebar">
        <div className="side-title">HEADQUARTERS</div>
        <button className="side-link active" onClick={()=>{setChat(false);setMenu(false);}}>◈ <span>Command Hall</span></button>
        <div className="side-title space">CORPS PERSONNEL</div>
        {npcs.map(member => <button
          className={`personnel ${member.id === selectedId ? "selected" : ""} ${member.status === "ready" ? "" : "pending"}`}
          key={member.id}
          onClick={() => selectNpc(member.id)}>
          <span className={`avatar ${member.status === "ready" ? "" : "ghost"}`}>{member.displayName.split(" ").map(part => part[0]).join("").slice(0,2)}</span>
          <span><b>{member.displayName}</b><small>{member.represents}</small></span>
          {member.status === "ready" ? <span className="online-dot" title="Available"/> : <span className="lock" title="Not configured">◇</span>}
        </button>)}
        {npcs.length === 0 && <div className="registry-loading">Connect the gateway to load Corps personnel.</div>}
        <div className="sidebar-bottom"><div className="callout"><b>TRAINING SIMULATION</b><p>Mock chat remains local. External AI and messaging integrations are not enabled.</p></div></div>
      </aside>
      <main className="main">
        <div className="world-head"><div><div className="eyebrow">SECTOR 2814 / OA</div><h1>Command Hall</h1><p>Your Corps is standing by for assignments.</p></div><span className="world-badge">● HEADQUARTERS ACTIVE</span></div>
        <div className="world-frame">
          <div ref={world} className="phaser-stage" aria-label="Isometric Green Lantern headquarters. Click any character to open their menu."/>
          <div className="hud-left"><span className="hud-light"/> LIVE WORLD <span className="separator">/</span> {npcs.length} REGISTERED PERSONNEL</div>
          <div className="hud-right">SCROLL TO ZOOM · DRAG TO PAN · CLICK AN NPC</div>
          {error&&!chat&&<div className="world-notice" role="alert">
            <span>{error}</span><button type="button" onClick={()=>setError("")} aria-label="Dismiss notification">×</button>
          </div>}
          {menu&&!chat&&npc&&<div className="npc-menu">
            <div className="menu-header"><div><small>GREEN LANTERN / AI REPRESENTATIVE</small><h2>{npc.displayName}</h2><p>{npc.represents} · {npc.status === "ready" ? "Available" : "Not configured"}</p></div><button className="icon-button" aria-label="Close interaction menu" onClick={()=>setMenu(false)}>×</button></div>
            {npc.capabilities.map(cap => cap.id === "chat" ? (
              <button className="action" key={cap.id} onClick={()=>{setChat(true);setMenu(false);}}>
                ◈ <span><b>{cap.label}</b><small>{npc.adapterId==="mock"?"Local mock conversation · No API charges":"AI provider connection"}</small></span><span>↗</span>
              </button>
            ) : <div className="action disabled" key={cap.id}>
              <span>◇</span><span><b>{cap.label}</b><small>Not yet implemented</small></span>
            </div>)}
            {npc.capabilities.length === 0 && <div className="npc-offline-note">
              This character is registered in the headquarters, but its {npc.represents} integration is not connected yet.
              Its presence and animation are simulated locally without API calls.
            </div>}
          </div>}
          {chat&&npc&&npc.capabilities.some(cap => cap.id === "chat")&&<section className="chat-panel" aria-label={npc.displayName + " chat"}>
            <div className="chat-header"><span className="avatar">{npc.displayName.split(" ").map(part=>part[0]).join("").slice(0,2)}</span><div><strong>{npc.displayName}</strong><small>{npc.adapterId==="mock"?"MOCK AI · NO API KEY REQUIRED":npc.represents.toUpperCase()}</small></div><button className="icon-button" aria-label="Close chat" onClick={()=>setChat(false)}>×</button></div>
            <div className="chat-body" aria-live="polite">
              {messages.length===0&&<div className="welcome"><div className="welcome-symbol">◉</div><h3>Lantern, your orders?</h3><p>{npc.adapterId==="mock"?"I'm ready for a test mission. This is a local mock response, not a live AI.":"This NPC connects through its configured AI provider."}</p></div>}
              {messages.map((m,i)=><div className={`bubble ${m.role}`} key={i}><span className="bubble-label">{m.role==="user"?"COMMANDER":npc.displayName.toUpperCase()}</span>{m.content}</div>)}
              {stream&&<div className="bubble assistant"><span className="bubble-label">{npc.displayName.toUpperCase()} · TRANSMITTING</span>{stream}</div>}
              {busy&&!stream&&<div className="typing">{npc.displayName} is responding…</div>}
              {error&&<div className="error" role="alert">{error}</div>}
            </div>
            <form className="compose" onSubmit={e=>{e.preventDefault();void send();}}>
              <input aria-label={"Message "+npc.displayName} placeholder={"Give "+npc.displayName+" a mission..."} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={busy||status!=="online"}/>
              {busy?<button type="button" onClick={()=>void cancel()}>Cancel</button>:<button type="submit" disabled={!text.trim()||status!=="online"}>Send ↗</button>}
            </form>
          </section>}
        </div>
        <div className="underworld"><div><b>01 / COMMAND HALL</b><span>{npcs.length} characters registered · Only John Stewart has mock chat enabled.</span></div><button onClick={()=>selectNpc("john")}>INTERACT WITH JOHN ↗</button></div>
      </main>
    </div>
  </div>;
}
export default App;
