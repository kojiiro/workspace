import { useEffect, useRef, useState } from "react";
import type { ChatMessage, EventEnvelope, GatewayError, NpcDescriptor, SendChatResponse } from "@glc/shared";
import { mountHeadquarters } from "./game";

const NPC_PLACEHOLDERS = [
  { name: "Hal Jordan", role: "Gemini", tag: "COMING SOON" },
  { name: "Kyle Rayner", role: "Claude", tag: "COMING SOON" },
  { name: "Guy Gardner", role: "Additional AI", tag: "PLANNED" },
  { name: "Sinestro", role: "WhatsApp", tag: "PLANNED" },
  { name: "Kilowog", role: "Discord", tag: "PLANNED" }
];

type UIMessage = Pick<ChatMessage, "role" | "content">;
function errorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as {error?: GatewayError}).error;
    if (err?.message) return err.message;
  }
  return "The local gateway could not complete this request.";
}
function App() {
  const world = useRef<HTMLDivElement>(null);
  const [npc, setNpc] = useState<NpcDescriptor | null>(null);
  const [menu, setMenu] = useState(false);
  const [chat, setChat] = useState(false);
  const [status, setStatus] = useState<"connecting"|"online"|"offline">("connecting");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState("");
  const currentStream = useRef("");
  const eventSource = useRef<EventSource | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/health").then(async r=> {
      if (!r.ok) throw new Error("Gateway unavailable");
      return r.json();
    }).then(() => { if(alive)setStatus("online"); }).catch(() => { if(alive)setStatus("offline"); });
    fetch("/api/npcs").then(r=>r.ok?r.json():Promise.reject()).then((list:NpcDescriptor[])=>{
      if(alive)setNpc(list.find(n=>n.id==="john") ?? null);
    }).catch(()=>{});
    return()=>{alive=false;};
  },[]);
  useEffect(() => {
    const node=world.current;
    if(!node)return;
    return mountHeadquarters(node,()=>setMenu(true));
  },[]);
  useEffect(()=>()=>eventSource.current?.close(),[]);

  async function send() {
    const content = text.trim();
    if(!content || busy || status!=="online")return;
    setError("");setText("");setMenu(false);
    setMessages(previous=>[...previous,{role:"user",content}]);setStream("");currentStream.current="";
    setBusy(true);
    try {
      const response = await fetch("/api/chat",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({npcId:"john",conversationId,text:content})
      });
      const data = await response.json();
      if(!response.ok)throw new Error(errorText(data));
      const payload=data as SendChatResponse;
      setConversationId(payload.conversationId);
      setRunId(payload.runId);
      eventSource.current?.close();
      const events=new EventSource("/api/events");
      eventSource.current=events;
      events.onmessage=(incoming)=>{
        let envelope:EventEnvelope;
        try { envelope=JSON.parse(incoming.data) as EventEnvelope; }catch{return;}
        const ev=envelope.event;
        if(!("runId" in ev)||ev.runId!==payload.runId)return;
        if(ev.type==="run.delta"){
          currentStream.current+=ev.text;setStream(currentStream.current);
        } else if(ev.type==="run.completed") {
          const answer=currentStream.current;
          setMessages(prev=>[...prev,{role:"assistant",content:answer||"(empty response)"}]);
          setStream("");setBusy(false);setRunId(undefined);events.close();
        } else if(ev.type==="run.failed"||ev.type==="run.cancelled"){
          setError(ev.type==="run.failed"?ev.error.message:"Mission cancelled.");
          if(currentStream.current) setMessages(prev=>[...prev,{role:"assistant",content:currentStream.current}]);
          setStream("");setBusy(false);setRunId(undefined);events.close();
        }
      };
      events.onerror=()=>{setError("Stream interrupted. Reconnecting…");};
    }catch(reason){
      setBusy(false);setError(reason instanceof Error?reason.message:"Network error");
    }
  }
  async function cancel(){
    if(!runId)return;
    try{await fetch(`/api/runs/${runId}/cancel`,{method:"POST"});}catch{setError("Could not reach gateway to cancel.");}
  }
  return <div className="shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◉</span>
        <span><strong>GREEN LANTERN CORPS</strong><small>COMMAND CENTER / LOCAL WORKSPACE</small></span>
      </div>
      <div className="topbar-right"><span className="version">PROTOTYPE 0.1</span><span className={`connection ${status}`}><i />{status==="online"?"GATEWAY ONLINE":status==="offline"?"GATEWAY OFFLINE":"CONNECTING"}</span></div>
    </header>
    <div className="layout">
      <aside className="sidebar">
        <div className="side-title">HEADQUARTERS</div>
        <button className="side-link active" onClick={()=>{setChat(false);setMenu(false);}}>◈ <span>Command Hall</span></button>
        <div className="side-title space">CORPS PERSONNEL</div>
        <button className="personnel" onClick={()=>setMenu(true)}>
          <span className="avatar">JS</span><span><b>John Stewart</b><small>ChatGPT · Mock</small></span><span className="online-dot"/>
        </button>
        {NPC_PLACEHOLDERS.map(p=><div className="personnel muted" key={p.name} title="Not implemented in prototype 0.1"><span className="avatar ghost">?</span><span><b>{p.name}</b><small>{p.role}</small></span><span className="lock">◇</span></div>)}
        <div className="sidebar-bottom"><div className="callout"><b>TRAINING SIMULATION</b><p>No paid AI requests. Nothing leaves your local gateway except dependency installation.</p></div></div>
      </aside>
      <main className="main">
        <div className="world-head"><div><div className="eyebrow">SECTOR 2814 / OA</div><h1>Command Hall</h1><p>Your Corps is standing by for assignments.</p></div><span className="world-badge">● HEADQUARTERS ACTIVE</span></div>
        <div className="world-frame">
          <div ref={world} className="phaser-stage" aria-label="Isometric Green Lantern headquarters. Click John Stewart to open his menu."/>
          <div className="hud-left"><span className="hud-light"/> LIVE WORLD <span className="separator">/</span> 1 ACTIVE LANTERN</div>
          <div className="hud-right">SCROLL TO ZOOM · DRAG TO PAN · CLICK AN NPC</div>
          {menu&&!chat&&<div className="npc-menu">
            <div className="menu-header"><div><small>GREEN LANTERN / AI REPRESENTATIVE</small><h2>John Stewart</h2><p>ChatGPT — Local training mode</p></div><button className="icon-button" aria-label="Close interaction menu" onClick={()=>setMenu(false)}>×</button></div>
            <button className="action" onClick={()=>{setChat(true);setMenu(false);}}>◈ <span><b>Talk to John</b><small>Open a simulated AI conversation</small></span><span>↗</span></button>
            <div className="action disabled"><span>▣</span><span><b>Assign a mission</b><small>Coming in a later version</small></span></div>
            <div className="action disabled"><span>◎</span><span><b>View AI abilities</b><small>Real providers not connected yet</small></span></div>
          </div>}
          {chat&&<section className="chat-panel" aria-label="John Stewart chat">
            <div className="chat-header"><span className="avatar">JS</span><div><strong>John Stewart</strong><small>MOCK AI · NO API KEY REQUIRED</small></div><button className="icon-button" aria-label="Close chat" onClick={()=>setChat(false)}>×</button></div>
            <div className="chat-body" aria-live="polite">
              {messages.length===0&&<div className="welcome"><div className="welcome-symbol">◉</div><h3>Lantern, your orders?</h3><p>I'm ready for a test mission. This is a local mock response, not ChatGPT.</p></div>}
              {messages.map((m,i)=><div className={`bubble ${m.role}`} key={i}><span className="bubble-label">{m.role==="user"?"COMMANDER":"JOHN STEWART"}</span>{m.content}</div>)}
              {stream&&<div className="bubble assistant"><span className="bubble-label">JOHN STEWART · TRANSMITTING</span>{stream}</div>}
              {busy&&!stream&&<div className="typing">John is responding…</div>}
              {error&&<div className="error" role="alert">{error}</div>}
            </div>
            <form className="compose" onSubmit={e=>{e.preventDefault();void send();}}>
              <input aria-label="Message John" placeholder="Give John a mission..." maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={busy||status!=="online"}/>
              {busy?<button type="button" onClick={()=>void cancel()}>Cancel</button>:<button type="submit" disabled={!text.trim()||status!=="online"}>Send ↗</button>}
            </form>
          </section>}
        </div>
        <div className="underworld"><div><b>01 / COMMAND HALL</b><span>Click John Stewart to start a simulated conversation.</span></div><button onClick={()=>setMenu(true)}>INTERACT WITH JOHN ↗</button></div>
      </main>
    </div>
  </div>;
}
export default App;
