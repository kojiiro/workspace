import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./app.js";
import { createDefaultNpcRegistry, NpcRegistry } from "./registry.js";
import { MockChatProvider } from "./adapters/mock.js";

const headers = { host: "127.0.0.1:3001" };

test("registry describes the complete Corps, with only the mock provider active", async () => {
  const app = createGateway();
  try {
    const response = await app.inject({method:"GET",url:"/api/npcs",headers});
    assert.equal(response.statusCode,200);
    const members = response.json();
    assert.deepEqual(members.map((member: {id:string})=>member.id),
      ["john","hal","kyle","guy","sinestro","kilowog"]);
    assert.deepEqual(members.filter((member:{status:string})=>member.status==="ready")
      .map((member:{id:string})=>member.id),["john"]);
    assert.deepEqual(members.find((member:{id:string})=>member.id==="hal").capabilities,[]);
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
  assert.equal(registry.get("hal")?.provider,undefined);
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
