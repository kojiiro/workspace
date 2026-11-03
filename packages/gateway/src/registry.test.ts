import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./app.js";
import { createDefaultNpcRegistry, NpcRegistry } from "./registry.js";
import { MockChatProvider } from "./adapters/mock.js";

const headers = { host: "127.0.0.1:3001" };

test("registry describes the Corps with Hal as primary mock character", async () => {
  const app = createGateway();
  try {
    const response = await app.inject({method:"GET",url:"/api/npcs",headers});
    assert.equal(response.statusCode,200);
    const members = response.json();
    assert.deepEqual(members.map((member: {id:string})=>member.id),
      ["hal","john","kyle","guy","sinestro","kilowog"]);
    assert.deepEqual(members.filter((member:{status:string})=>member.status==="ready")
      .map((member:{id:string})=>member.id),["hal","john"]);
    assert.deepEqual(members.find((member:{id:string})=>member.id==="hal").capabilities, [{id:"chat",label:"Talk to Hal",risk:"safe"}]);
  } finally {await app.close();}
});

test("unconfigured NPCs cannot accidentally create AI conversations", async () => {
  const app = createGateway();
  try {
    const disabled = await app.inject({
      method:"POST",url:"/api/chat",headers,
      payload:{npcId:"kyle",text:"hello"}
    });
    assert.equal(disabled.statusCode,503);
    assert.equal(disabled.json().error.code,"unavailable");
    const unknown = await app.inject({
      method:"POST",url:"/api/chat",headers,
      payload:{npcId:"unknown",text:"hello"}
    });
    assert.equal(unknown.statusCode,404);
  } finally {await app.close();}
});

test("registry rejects duplicate identities and missing providers for chat", () => {
  const registry = createDefaultNpcRegistry(new MockChatProvider());
  assert.equal(registry.get("john")?.provider?.id,"mock");
  assert.equal(registry.get("hal")?.provider?.id,"mock");
  const duplicate = registry.get("john");
  assert.ok(duplicate);
  assert.throws(()=>registry.register(duplicate),/Duplicate NPC/);
  const empty = new NpcRegistry();
  assert.throws(()=>empty.register({
    descriptor:{
      id:"test",displayName:"Test",represents:"No adapter",
      adapterId:"missing",status:"unconfigured",
      capabilities:[{id:"chat",label:"Chat",risk:"safe"}]
    }
  }),/needs a provider/);
});

test("Hal has an independent mock chat and John cannot reuse his conversation", async () => {
  const app = createGateway();
  try {
    const response = await app.inject({
      method:"POST",url:"/api/chat",headers,payload:{npcId:"hal",text:"Hal mission"}
    });
    assert.equal(response.statusCode,202);
    const { runId, conversationId }=response.json();
    const cancel = await app.inject({
      method:"POST",url:"/api/runs/"+runId+"/cancel",headers
    });
    assert.equal(cancel.statusCode,204);
    await new Promise(resolve => setTimeout(resolve,100));
    const wrongNpc = await app.inject({
      method:"POST",url:"/api/chat",headers,
      payload:{npcId:"john",conversationId,text:"Wrong owner"}
    });
    assert.equal(wrongNpc.statusCode,409);
    assert.match(wrongNpc.json().error.message,/belongs to another NPC/);
    const halRetry = await app.inject({
      method:"POST",url:"/api/chat",headers,
      payload:{npcId:"hal",conversationId,text:"Try again"}
    });
    assert.equal(halRetry.statusCode,202);
    await app.inject({method:"POST",url:"/api/runs/"+halRetry.json().runId+"/cancel",headers});
  } finally { await app.close(); }
});

test("registry refuses malformed NPC identifiers", () => {
  const registry=new NpcRegistry();
  assert.throws(()=>registry.register({
    descriptor:{id:"Invalid Id!",displayName:"Invalid",represents:"None",
      adapterId:"none",status:"unconfigured",capabilities:[]}
  }),/Invalid NPC ID/);
});
