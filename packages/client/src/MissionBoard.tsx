import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { CreateMissionRequest, Mission, MissionStatus, NpcDescriptor, UpdateMissionRequest } from "@glc/shared";

const statusLabels: Record<MissionStatus,string> = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed"
};
const statuses: MissionStatus[] = ["planned","in_progress","completed"];
// Optional until Storage PR A is merged: the current JSON backend has no revision.
type StoredMission = Mission & { revision?:number; leadNpcId?:string; participantNpcIds?:string[] };
type Conflict = {
  id:string; reason:"stale_revision"|"active_run"; current:StoredMission;
  attemptedStatus?:MissionStatus; attemptedDelete?:boolean
};
function conflictBody(body:unknown): Pick<Conflict,"reason"|"current">|null {
  if(!body || typeof body!=="object")return null;
  const v=body as {reason?:string;current?:StoredMission};
  if((v.reason!=="stale_revision"&&v.reason!=="active_run") ||
     !v.current || typeof v.current.id!=="string" ||
     !Number.isSafeInteger(v.current.revision))return null;
  return {reason:v.reason,current:v.current};
}
function editHeaders(mission:StoredMission):Record<string,string> {
  return Number.isSafeInteger(mission.revision)&& (mission.revision??0)>0
    ? {"If-Match":'\"'+mission.revision+'\"'}:{};
}

function formatError(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as {error?: {message?: string}}).error;
    if (err?.message) return err.message;
  }
  return fallback;
}

export default function MissionBoard({ npcs, onClose }: {
  npcs: NpcDescriptor[];
  onClose(): void;
}) {
  const [missions, setMissions] = useState<StoredMission[]>([]);
  const [conflict,setConflict] = useState<Conflict|null>(null);
  const [pendingStatus,setPendingStatus] = useState<Record<string,MissionStatus>>({});
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [workingId,setWorkingId] = useState<string|null>(null);
  const [error,setError] = useState("");
  const [title,setTitle] = useState("");
  const [notes,setNotes] = useState("");
  const [assignedNpcId,setAssignedNpcId] = useState("hal");

  useEffect(()=>{
    let active=true;
    fetch("/api/missions").then(async response=>{
      const body:unknown=await response.json();
      if (!response.ok) throw new Error(formatError(body,"Cannot load missions."));
      return body as StoredMission[];
    }).then(data=>{ if(active) setMissions(data); })
      .catch(reason=>{ if(active) setError(reason instanceof Error ? reason.message : "Cannot load missions."); })
      .finally(()=>{ if(active) setLoading(false); });
    return ()=>{active=false;};
  },[]);

  async function createMission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!title.trim() || saving)return;
    setSaving(true);setError("");
    const data:CreateMissionRequest={
      title:title.trim(),
      notes:notes.trim(),
      assignedNpcId:assignedNpcId || null
    };
    try {
      const response=await fetch("/api/missions",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)
      });
      const body:unknown=await response.json();
      if(!response.ok) throw new Error(formatError(body,"Could not save mission."));
      const created=body as StoredMission;
      setMissions(previous=>[created,...previous]);
      setTitle("");setNotes("");
    }catch(reason) {
      setError(reason instanceof Error?reason.message:"Could not save mission.");
    }finally {setSaving(false);}
  }

  async function modifyMission(id:string,changes:UpdateMissionRequest) {
    if(workingId||conflict?.id===id)return;
    const current=missions.find(m=>m.id===id);
    if(!current)return;
    if(changes.status)setPendingStatus(prev=>({...prev,[id]:changes.status!}));
    setWorkingId(id);setError("");
    let conflicted=false;
    try {
      const response=await fetch("/api/missions/"+encodeURIComponent(id),{
        method:"PATCH",
        headers:{"Content-Type":"application/json",...editHeaders(current)},
        body:JSON.stringify(changes)
      });
      const body:unknown=await response.json();
      if(!response.ok){
        const server=response.status===409?conflictBody(body):null;
        if(server){
          conflicted=true;
          setConflict({id,...server,attemptedStatus:changes.status});
          return;
        }
        throw new Error(formatError(body,"Could not update mission."));
      }
      const updated=body as StoredMission;
      setMissions(prev=>prev.map(m=>m.id===id?updated:m));
    }catch(reason){
      setError(reason instanceof Error?reason.message:"Could not update mission.");
    }finally{
      if(!conflicted)setPendingStatus(prev=>{const copy={...prev};delete copy[id];return copy;});
      setWorkingId(null);
    }
  }

  async function removeMission(mission:StoredMission) {
    if(workingId||conflict?.id===mission.id||
      !window.confirm('Permanently delete mission "'+mission.title+
      '" AND all its team discussion history? This cannot be undone.'))return;
    setWorkingId(mission.id);setError("");
    try {
      const response=await fetch("/api/missions/"+encodeURIComponent(mission.id),{
        method:"DELETE",headers:editHeaders(mission)
      });
      if(!response.ok){
        const body:unknown=await response.json();
        const server=response.status===409?conflictBody(body):null;
        if(server){
          setConflict({id:mission.id,...server,attemptedDelete:true});
          return;
        }
        throw new Error(formatError(body,"Could not delete mission."));
      }
      setMissions(prev=>prev.filter(m=>m.id!==mission.id));
    }catch(reason){
      setError(reason instanceof Error?reason.message:"Could not delete mission.");
    }finally{setWorkingId(null);}
  }

  async function reloadCurrentMission() {
    if(!conflict||workingId)return;
    const id=conflict.id;
    setWorkingId(id);setError("");
    try {
      const response=await fetch("/api/missions/"+encodeURIComponent(id),{cache:"no-store"});
      if(response.status===404){
        setMissions(prev=>prev.filter(m=>m.id!==id));
      }else{
        const body:unknown=await response.json();
        if(!response.ok)throw new Error(formatError(body,"Could not reload mission."));
        const current=body as StoredMission;
        setMissions(prev=>prev.map(m=>m.id===id?current:m));
      }
      setPendingStatus(prev=>{const copy={...prev};delete copy[id];return copy;});
      setConflict(null);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"Could not reload mission.");
    }finally{setWorkingId(null);}
  }

  const completedCount=missions.filter(item=>item.status==="completed").length;
  const activeCount=missions.filter(item=>item.status==="in_progress").length;

  return <section className="mission-panel" aria-label="Mission Control board"
    onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
    <header className="mission-header">
      <div><span className="mission-eyebrow">OA / MISSION CONTROL</span><h2>Mission Board</h2>
        <p>Save and organize your projects locally.</p>
      </div>
      <button type="button" className="mission-close" onClick={onClose} aria-label="Close Mission Board">×</button>
    </header>
    <div className="mission-content">
      <div className="mission-stats">
        <div><strong>{missions.length}</strong><span>Total</span></div>
        <div><strong>{activeCount}</strong><span>In progress</span></div>
        <div><strong>{completedCount}</strong><span>Completed</span></div>
      </div>
      <form className="mission-create" onSubmit={event=>void createMission(event)}>
        <h3><span>+</span> Create a mission</h3>
        <label htmlFor="mission-title">Mission title</label>
        <input id="mission-title" maxLength={120} required placeholder="e.g. Finish my website design"
          value={title} onChange={event=>setTitle(event.target.value)}/>
        <label htmlFor="mission-notes">Details (optional)</label>
        <textarea id="mission-notes" maxLength={1000} rows={2}
          placeholder="What do you want to accomplish?" value={notes}
          onChange={event=>setNotes(event.target.value)}/>
        <label htmlFor="mission-assignee">Assign to</label>
        <select id="mission-assignee" value={assignedNpcId}
          onChange={event=>setAssignedNpcId(event.target.value)}>
          <option value="">Unassigned</option>
          {npcs.map(npc=><option key={npc.id} value={npc.id}>{npc.displayName} — {npc.represents}</option>)}
        </select>
        <p className="mission-disclaimer">Assigning a Lantern is for tracking only. It does not start an AI task or send messages.</p>
        <button className="mission-add" type="submit" disabled={saving||!title.trim()}>
          {saving?"Saving…":"Save Mission"}
        </button>
      </form>
      <div className="mission-list-header">
        <h3>Current missions</h3><span>{missions.length} records</span>
      </div>
      {error && <div className="mission-error" role="alert">{error}</div>}
      {conflict&&<div className="mission-conflict" role="alert">
        <strong>{conflict.reason==="active_run"?"Team run still active":"Mission changed elsewhere"}</strong>
        <p>{conflict.reason==="active_run"
          ?"The team run must finish or be cancelled before this mission can be deleted."
          :"This saved mission has a newer revision. Your attempted edit was not applied."}</p>
        {conflict.attemptedStatus&&<p>Your pending change: {statusLabels[conflict.attemptedStatus]}.</p>}
        {conflict.attemptedDelete&&<p>Your deletion was not performed.</p>}
        <button type="button" onClick={()=>void reloadCurrentMission()} disabled={workingId!==null}>
          Reload current mission
        </button>
        <small>Reloading discards this pending change; it will not overwrite the saved mission.</small>
      </div>}
      {loading && <div className="mission-empty">Loading your local Mission Board…</div>}
      {!loading && missions.length===0 && <div className="mission-empty">
        <strong>No missions yet.</strong>
        <span>Create one above to start organizing your work.</span>
      </div>}
      <div className="mission-list">
        {missions.map(mission=>{
          const owner=npcs.find(npc=>npc.id===mission.assignedNpcId);
          return <article className="mission-card" key={mission.id}>
            <div className="mission-card-top">
              <strong>{mission.title}</strong>
              <span className={"mission-status status-"+mission.status}>{statusLabels[mission.status]}</span>
            </div>
            {mission.notes&&<p>{mission.notes}</p>}
            <div className="mission-owner"><span>Assigned:</span> {owner?.displayName ?? "Unassigned"}
              {owner?.status==="unconfigured" && <span className="mission-unconfigured"> · Offline</span>}
            </div>
            {mission.leadNpcId&&<div className="mission-owner">
              <span>Team:</span> Lead {npcs.find(n=>n.id===mission.leadNpcId)?.displayName??mission.leadNpcId}
              {mission.participantNpcIds?.length?" · "+mission.participantNpcIds.map(id=>npcs.find(n=>n.id===id)?.displayName??id).join(", "):""}
            </div>}
            <div className="mission-actions">
              <label>
                <span>Status</span>
                <select aria-label={"Status of "+mission.title} value={pendingStatus[mission.id]??mission.status}
                  disabled={workingId!==null||conflict?.id===mission.id}
                  onChange={event=>void modifyMission(mission.id,{status:event.target.value as MissionStatus})}>
                  {statuses.map(status=><option key={status} value={status}>{statusLabels[status]}</option>)}
                </select>
              </label>
              <button type="button" disabled={workingId!==null||conflict?.id===mission.id} onClick={()=>void removeMission(mission)}>Delete</button>
            </div>
          </article>;
        })}
      </div>
    </div>
  </section>;
}
