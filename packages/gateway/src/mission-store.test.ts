import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./app.js";
import { MissionStore } from "./mission-store.js";

const HOST={host:"127.0.0.1:3001"};
function appFor(path:string) {
  return createGateway(undefined, { missionStore:new MissionStore(path) });
}
async function temporaryStore(fn:(path:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),"glc-missions-"));
  try {await fn(join(dir,"missions.json"));}
  finally {await rm(dir,{recursive:true,force:true});}
}

test("create, update, reload and delete missions across gateway instances", async ()=>{
  await temporaryStore(async path=>{
    const first=appFor(path);
    let id="";
    try {
      const create=await first.inject({method:"POST",url:"/api/missions",headers:HOST,
        payload:{title:"  Finish website  ",notes:"Landing page",assignedNpcId:"hal"}});
      assert.equal(create.statusCode,201);
      const mission=create.json();
      assert.equal(mission.title,"Finish website");
      assert.equal(mission.status,"planned");
      assert.equal(mission.assignedNpcId,"hal");
      id=mission.id;
      const updated=await first.inject({method:"PATCH",url:"/api/missions/"+id,headers:HOST,
        payload:{status:"in_progress"}});
      assert.equal(updated.statusCode,200);
      assert.equal(updated.json().status,"in_progress");
    } finally {await first.close();}
    const second=appFor(path);
    try {
      const list=await second.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(list.statusCode,200);
      assert.equal(list.json().length,1);
      assert.equal(list.json()[0].id,id);
      assert.equal(list.json()[0].status,"in_progress");
      const onDisk=JSON.parse(await readFile(path,"utf8"));
      assert.equal(onDisk.schemaVersion,1);
      assert.equal(onDisk.missions.length,1);
      const removal=await second.inject({method:"DELETE",url:"/api/missions/"+id,headers:HOST});
      assert.equal(removal.statusCode,204);
      const empty=await second.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.deepEqual(empty.json(),[]);
    } finally {await second.close();}
  });
});

test("invalid titles, assignees, and unknown fields are rejected",async()=>{
  await temporaryStore(async path=>{
    const app=appFor(path);
    try{
      for(const payload of [
        {title:"",notes:"",assignedNpcId:"hal"},
        {title:"x".repeat(121),notes:"",assignedNpcId:"hal"},
        {title:"Valid",notes:"",assignedNpcId:"unknown-lantern"},
        {title:"Valid",notes:"",assignedNpcId:"Bad ID"},
        {title:"Valid",notes:"",assignedNpcId:null,extra:"unknown"}
      ]) {
        const response=await app.inject({method:"POST",url:"/api/missions",headers:HOST,payload});
        assert.equal(response.statusCode,400);
      }
      const list=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.deepEqual(list.json(),[]);
    }finally{await app.close();}
  });
});

test("invalid patches, nonexistent records, and untrusted Origins are refused",async()=>{
  await temporaryStore(async path=>{
    const app=appFor(path);
    try{
      const first=await app.inject({method:"POST",url:"/api/missions",headers:HOST,
        payload:{title:"Write report",notes:"",assignedNpcId:null}});
      const id=first.json().id as string;
      const invalid=await app.inject({method:"PATCH",url:"/api/missions/"+id,headers:HOST,
        payload:{status:"fake"}});
      assert.equal(invalid.statusCode,400);
      const empty=await app.inject({method:"PATCH",url:"/api/missions/"+id,headers:HOST,payload:{}});
      assert.equal(empty.statusCode,400);
      const wrongOwner=await app.inject({method:"PATCH",url:"/api/missions/"+id,headers:HOST,
        payload:{assignedNpcId:"not-registered"}});
      assert.equal(wrongOwner.statusCode,400);
      const foreign=await app.inject({method:"POST",url:"/api/missions",
        headers:{...HOST,origin:"https://evil.example"},
        payload:{title:"Not allowed",notes:"",assignedNpcId:null}});
      assert.equal(foreign.statusCode,403);
      const missing=await app.inject({method:"DELETE",
        url:"/api/missions/89e51be1-37f6-4ec9-a86a-b9e69e359d5e",headers:HOST});
      assert.equal(missing.statusCode,404);
      const list=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(list.json().length,1);
      assert.equal(list.json()[0].status,"planned");
    }finally{await app.close();}
  });
});

test("concurrent mission submissions are serialized without lost updates",async()=>{
  await temporaryStore(async path=>{
    const app=appFor(path);
    try{
      const tasks=Array.from({length:12},(_,i)=>app.inject({
        method:"POST",url:"/api/missions",headers:HOST,
        payload:{title:"Mission "+i,notes:"",assignedNpcId:"john"}
      }));
      const created=await Promise.all(tasks);
      assert.ok(created.every(response=>response.statusCode===201));
      const list=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(list.json().length,12);
      const persisted=JSON.parse(await readFile(path,"utf8"));
      assert.equal(persisted.schemaVersion,1);
      assert.equal(persisted.missions.length,12);
    }finally{await app.close();}
  });
});

const fixture = (id:string, title:string) => ({
  id, title, notes:"", assignedNpcId:"hal" as const, status:"planned" as const,
  createdAt:"2026-11-04T00:00:00.000Z",updatedAt:"2026-11-04T00:00:00.000Z"
});

test("legacy bare array is accepted, and rewritten only on next save", async()=>{
  await temporaryStore(async path=>{
    const legacy=[fixture("ffbf1813-b768-4eaf-854b-0abe82db2dd2","Old mission")];
    await writeFile(path,JSON.stringify(legacy),"utf8");
    const app=appFor(path);
    try{
      const list=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(list.statusCode,200);
      assert.equal(list.json().length,1);
      assert.ok(Array.isArray(JSON.parse(await readFile(path,"utf8"))));
      const updated=await app.inject({
        method:"PATCH",url:"/api/missions/"+legacy[0].id,headers:HOST,
        payload:{status:"in_progress"}
      });
      assert.equal(updated.statusCode,200);
      const onDisk=JSON.parse(await readFile(path,"utf8"));
      assert.equal(onDisk.schemaVersion,1);
      assert.equal(onDisk.missions.length,1);
      assert.equal(onDisk.missions[0].status,"in_progress");
    }finally{await app.close();}
  });
});

test("invalid individual records are quarantined without disabling valid missions",async()=>{
  await temporaryStore(async path=>{
    const valid=fixture("a75816b4-b05d-49a6-833c-37b76eb49783","Valid record");
    const invalidDate={...fixture("484bf7aa-d7e9-471f-9d9a-a4c951c13dbf","Broken timestamp")};
    delete (invalidDate as Partial<typeof invalidDate>).updatedAt;
    const invalidFields={...fixture("2ff76cf8-05cc-41b7-9422-a2068b0399a2","Broken fields"),
      assignedNpcId:5,status:"fake"};
    await writeFile(path,JSON.stringify({schemaVersion:1,missions:[invalidDate,valid,invalidFields]}),"utf8");
    const app=appFor(path);
    try {
      const list=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(list.statusCode,200);
      assert.deepEqual(list.json().map((m:{title:string})=>m.title),["Valid record"]);
      const sidecar=path.replace(/\.json$/,".rejected.json");
      const rejected=JSON.parse(await readFile(sidecar,"utf8"));
      assert.equal(rejected.rejected.length,2);
      assert.equal(rejected.rejected[0].record.title,"Broken timestamp");
      assert.equal(rejected.rejected[1].record.assignedNpcId,5);
      // The source is retained until an actual successful write.
      assert.equal(JSON.parse(await readFile(path,"utf8")).missions.length,3);
      const saved=await app.inject({method:"POST",url:"/api/missions",headers:HOST,
        payload:{title:"New clean mission",notes:"",assignedNpcId:"john"}});
      assert.equal(saved.statusCode,201);
      const disk=JSON.parse(await readFile(path,"utf8"));
      assert.equal(disk.schemaVersion,1);
      assert.equal(disk.missions.length,2);
      assert.deepEqual(disk.missions.map((m:{title:string})=>m.title),["Valid record","New clean mission"]);
    }finally{await app.close();}
  });
});

test("unparseable JSON and unknown schema versions fail closed, but recover without restart",async()=>{
  await temporaryStore(async path=>{
    const broken='{"schemaVersion":1,"missions":[';
    await writeFile(path,broken,"utf8");
    const app=appFor(path);
    try{
      const error=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(error.statusCode,500);
      assert.equal(await readFile(path,"utf8"),broken);
      await writeFile(path,JSON.stringify({schemaVersion:2,missions:[]}),"utf8");
      const newer=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(newer.statusCode,500);
      const fixed={schemaVersion:1,missions:[fixture("d3687c69-5c8b-4877-91c0-2299eec2b956","Recovered")]};
      await writeFile(path,JSON.stringify(fixed),"utf8");
      const recovered=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(recovered.statusCode,200);
      assert.equal(recovered.json()[0].title,"Recovered");
    }finally{await app.close();}
  });
});

test("duplicate mission IDs are rejected while the first valid record stays readable",async()=>{
  await temporaryStore(async path=>{
    const original=fixture("d324f6b0-780a-4917-8136-af7078012e68","First");
    const duplicate={...original,title:"Duplicate"};
    await writeFile(path,JSON.stringify({schemaVersion:1,missions:[original,duplicate]}),"utf8");
    const app=appFor(path);
    try {
      const response=await app.inject({method:"GET",url:"/api/missions",headers:HOST});
      assert.equal(response.statusCode,200);
      assert.equal(response.json().length,1);
      assert.equal(response.json()[0].title,"First");
      const quarantined=JSON.parse(await readFile(path.replace(/\.json$/,".rejected.json"),"utf8"));
      assert.match(quarantined.rejected[0].issues.join(" "),/duplicate/);
    }finally{await app.close();}
  });
});
