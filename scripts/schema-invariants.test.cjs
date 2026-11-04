// Adapted from Claude's supplied schema-invariants.test.cjs for repo-relative paths.
// Uses Node's built-in SQLite runtime ONLY for contract invariant testing,
// not as the production adapter (planned production DB: better-sqlite3).
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs");
const path=require("node:path");
const {pathToFileURL}=require("node:url");
const Database=class extends DatabaseSync {
  pragma(s){this.exec("PRAGMA "+s);}
};
(async()=>{
const {TEAM_RUN_TRANSITIONS}=await import(
  pathToFileURL(path.resolve(__dirname,"../packages/shared/dist/index.js")).href
);
const SQL=fs.readFileSync(path.resolve(__dirname,"../docs/sqlite-team-schema.sql"),"utf8");
const N=new Date().toISOString(),M="m1",R="r1";
let pass=0,fail=0;
const expect=(name,shouldThrow,fn)=>{
  let rejected=false,reason="";
  try{fn();}catch(err){rejected=true;reason=String(err?.message??err).slice(0,75);}
  const okay=rejected===shouldThrow;
  if(okay)pass++;else fail++;
  process.stdout.write((okay?"PASS ":"FAIL ")+name+(rejected?" ["+reason+"]":"")+"\n");
};
const mk=(recursive=true)=>{
  const db=new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = "+(recursive?"ON":"OFF"));
  assertPragma(db,"foreign_keys",1);
  if(recursive)assertPragma(db,"recursive_triggers",1);
  db.exec(SQL);
  const seed=db.prepare("INSERT INTO team_run_transitions VALUES(?,?)");
  for(const [from,targets] of Object.entries(TEAM_RUN_TRANSITIONS))
    for(const to of targets)seed.run(from,to);
  const actual=db.prepare("SELECT from_state,to_state FROM team_run_transitions ORDER BY from_state,to_state").all();
  const wanted=Object.entries(TEAM_RUN_TRANSITIONS)
    .flatMap(([from,targets])=>targets.map(to=>({from_state:from,to_state:to})))
    .sort((a,b)=>a.from_state.localeCompare(b.from_state)||a.to_state.localeCompare(b.to_state));
  if(JSON.stringify(actual)!==JSON.stringify(wanted))throw Error("TS and SQL transition table mismatch");
  return db;
};
function assertPragma(db,key,value){
  const got=db.prepare("PRAGMA "+key).get()?.[key];
  if(got!==value)throw Error("Required PRAGMA "+key+" was "+got);
}
const mission=(db,id=M)=>db.prepare(
  "INSERT INTO missions(id,title,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?)"
).run(id,"t","","in_progress",N,N);
const run=(db,id=R,mid=M,state="working",client=id+"c")=>db.prepare(
  "INSERT INTO team_runs(id,mission_id,client_request_id,state,mode,snapshot_json,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
).run(id,mid,client,state,"mock","{}",N,N);
const step=db=>db.prepare(
  "INSERT INTO team_steps(id,run_id,npc_id,position,round,status,created_at,updated_at) VALUES('s1',?,?,0,0,'running',?,?)"
).run(R,"john",N,N);
const attempt=(db,id="a1",n=1,state="running")=>db.prepare(
  "INSERT INTO team_step_attempts(id,step_id,attempt_no,state,started_at) VALUES(?,?,?,?,?)"
).run(id,"s1",n,state,N);
const ev=(db,seq,o={})=>db.prepare(
  "INSERT OR "+(o.replace?"REPLACE":"ABORT")+" INTO team_events(event_uuid,mission_id,run_id,step_id,attempt_id,parent_event_uuid,sequence,round,at,kind,from_actor_json,to_actors_json,text,provenance_json) VALUES(?,?,?,?,?,?,?,0,?,?,'{}','[]',?,'{}')"
).run(o.uuid??"e"+seq,o.mission??M,o.run??R,
  o.step===undefined?"s1":o.step,o.attempt===undefined?"a1":o.attempt,
  o.parent??null,seq,N,o.kind??"status",o.text??"x");
const bump=(db,to,from,extra="")=>db.prepare(
  "UPDATE team_runs SET state=?,version=version+1 "+extra+" WHERE id=? AND state=?"
).run(to,R,from);
const full=()=>{const db=mk();mission(db);run(db);step(db);attempt(db);ev(db,1);ev(db,2,{parent:"e1"});return db;};

{
 const db=full();
 bump(db,"reviewing","working");
 bump(db,"awaiting_commander_review","reviewing");
 db.prepare("UPDATE team_runs SET state='completed',version=version+1,completed_at=?,end_reason='approved' WHERE id=?").run(N,R);
 expect("finished mission cascades through all records",false,()=>db.prepare("DELETE FROM missions WHERE id=?").run(M));
 expect("cascade actually emptied five tables",false,()=>{
  for(const name of ["missions","team_runs","team_steps","team_step_attempts","team_events"])
    if(db.prepare("SELECT count(*) c FROM "+name).get().c!==0)throw Error("remaining "+name);
 });
 db.close();
}
{const db=mk();mission(db);run(db);expect("active run even without events blocks deletion",true,()=>db.prepare("DELETE FROM missions WHERE id=?").run(M));db.close();}
{const db=full();expect("direct event deletion blocked",true,()=>db.prepare("DELETE FROM team_events").run());db.close();}
{const db=full();expect("direct run deletion blocked",true,()=>db.prepare("DELETE FROM team_runs WHERE id=?").run(R));db.close();}
{const db=full();expect("event update blocked",true,()=>db.prepare("UPDATE team_events SET text='forged'").run());db.close();}
{const db=full();expect("event REPLACE blocked (recursive triggers enabled)",true,()=>ev(db,1,{replace:true,uuid:"forged",text:"FORGED"}));db.close();}
{
 const db=mk(false);mission(db);run(db);step(db);attempt(db);ev(db,1);
 // Reproduces the vulnerability that motivated the mandatory PRAGMA.
 let vulnerable=false;
 try{ev(db,1,{replace:true,uuid:"forged",text:"FORGED"});vulnerable=db.prepare("SELECT text FROM team_events WHERE sequence=1").get().text==="FORGED";}catch{}
 expect("without recursive_triggers, REPLACE vulnerability is reproducible",false,()=>{if(!vulnerable)throw Error("unexpectedly fixed");});
 db.close();
}
{
 const db=full();mission(db,"m2");
 expect("event mission/run mismatch rejected",true,()=>ev(db,3,{mission:"m2"}));
 expect("dangling step rejected",true,()=>ev(db,4,{step:"nope",attempt:null}));
 expect("dangling attempt rejected",true,()=>ev(db,5,{attempt:"nope"}));
 expect("parent from different run rejected",true,()=>{run(db,"r2","m2");ev(db,1,{uuid:"x2",run:"r2",mission:"m2",step:null,attempt:null,parent:"e1"});});
 expect("unknown event kind rejected",true,()=>ev(db,6,{kind:"banana"}));
 expect("commander decision kind accepted",false,()=>ev(db,7,{kind:"commander_decision"}));
 expect("second running attempt rejected",true,()=>attempt(db,"a2",2));
 expect("second active run rejected",true,()=>run(db,"r9",M));
 db.close();
}
{
 const db=full();
 expect("legal working→reviewing",false,()=>bump(db,"reviewing","working"));
 expect("illegal reviewing→completed",true,()=>bump(db,"completed","reviewing",",completed_at='"+N+"',end_reason='approved'"));
 expect("version +2 blocked",true,()=>db.prepare("UPDATE team_runs SET state='revising',version=version+2 WHERE id=?").run(R));
 expect("pause with saved state",false,()=>bump(db,"paused","reviewing",",paused_from='reviewing'"));
 expect("wrong-state resume blocked",true,()=>db.prepare("UPDATE team_runs SET state='working',paused_from=NULL,version=version+1 WHERE id=?").run(R));
 expect("correct-state resume allowed",false,()=>db.prepare("UPDATE team_runs SET state='reviewing',paused_from=NULL,version=version+1 WHERE id=?").run(R));
 expect("paused_from outside pause rejected",true,()=>db.prepare("UPDATE team_runs SET paused_from='working',version=version+1 WHERE id=?").run(R));
 expect("terminal without reason/time rejected",true,()=>db.prepare("UPDATE team_runs SET state='cancelled',version=version+1 WHERE id=?").run(R));
 db.prepare("UPDATE team_runs SET state='cancelled',version=version+1,completed_at=?,end_reason='commander_rejected' WHERE id=?").run(N,R);
 expect("terminal runs immutable",true,()=>db.prepare("UPDATE team_runs SET state='working',version=version+1 WHERE id=?").run(R));
 db.close();
}
{
 const db=full();
 const version=db.prepare("SELECT version FROM team_runs WHERE id=?").get(R).version;
 const cancel=db.prepare("UPDATE team_runs SET state='cancelling',version=version+1,end_reason='commander_cancelled' WHERE id=? AND version=? AND state=?").run(R,version,"working");
 const late=db.prepare("UPDATE team_runs SET state='reviewing',version=version+1 WHERE id=? AND version=? AND state=?").run(R,version,"working");
 expect("cancel wins, late result does not commit",false,()=>{if(cancel.changes!==1||late.changes!==0)throw Error("unsafe race");});
 expect("active run derived from index",false,()=>{
  const found=db.prepare("SELECT id FROM team_runs WHERE mission_id=? AND state NOT IN ('completed','cancelled','failed')").get(M)?.id;
  if(found!==R)throw Error("wrong active run");
 });
 db.close();
}
process.stdout.write("SQLITE CONTRACT CHECKS: "+pass+" passed, "+fail+" failed\n");
if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
