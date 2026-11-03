import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      assert.equal(onDisk.length,1);
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
      assert.equal(persisted.length,12);
    }finally{await app.close();}
  });
});
