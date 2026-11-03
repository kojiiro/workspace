import test from "node:test";
import assert from "node:assert/strict";
import type { ChatChunk, ChatInput, ChatProvider } from "@glc/shared";
import { createGateway } from "./app.js";

const HOST = { host: "127.0.0.1:3001" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function request(npcId = "john", text = "hello", conversationId?: string) {
  return { npcId, text, ...(conversationId ? { conversationId } : {}) };
}
test("loopback Host and browser Origin are allowlisted", async () => {
  const app = createGateway();
  try {
    const good = await app.inject({ method: "GET", url: "/api/npcs", headers: HOST });
    assert.equal(good.statusCode, 200);
    const evilHost = await app.inject({ method: "GET", url: "/api/npcs", headers: { host: "evil.example:3001" } });
    assert.equal(evilHost.statusCode, 403);
    const evilOrigin = await app.inject({
      method: "GET", url: "/api/npcs", headers: { ...HOST, origin: "https://evil.example" }
    });
    assert.equal(evilOrigin.statusCode, 403);
    const nullOrigin = await app.inject({
      method: "GET", url: "/api/npcs", headers: { ...HOST, origin: "null" }
    });
    assert.equal(nullOrigin.statusCode, 403);
    const viteHost = await app.inject({ method: "GET", url: "/api/npcs", headers: { host: "127.0.0.1:5173" } });
    assert.equal(viteHost.statusCode, 200);
  } finally { await app.close(); }
});

test("a second run on the same conversation is rejected and cancel does not corrupt history", async () => {
  const app = createGateway();
  try {
    const first = await app.inject({ method: "POST", url: "/api/chat", headers: HOST, payload: request() });
    assert.equal(first.statusCode, 202);
    const { runId, conversationId } = first.json();
    const duplicate = await app.inject({
      method: "POST", url: "/api/chat", headers: HOST,
      payload: request("john", "another question", conversationId)
    });
    assert.equal(duplicate.statusCode, 409);
    const cancelled = await app.inject({
      method: "POST", url: "/api/runs/" + runId + "/cancel", headers: HOST
    });
    assert.equal(cancelled.statusCode, 204);
    await sleep(100);
    const history = await app.inject({
      method: "GET", url: "/api/conversations/" + conversationId + "/messages", headers: HOST
    });
    assert.deepEqual(history.json(), []);
    const retry = await app.inject({
      method: "POST", url: "/api/chat", headers: HOST, payload: request("john", "retry", conversationId)
    });
    assert.equal(retry.statusCode, 202);
    await app.inject({ method: "POST", url: "/api/runs/" + retry.json().runId + "/cancel", headers: HOST });
  } finally { await app.close(); }
});

test("mock provider failure does not add unanswered user messages", async () => {
  const app = createGateway();
  try {
    const failed = await app.inject({
      method: "POST", url: "/api/chat", headers: HOST, payload: request("john", "/fail")
    });
    assert.equal(failed.statusCode, 202);
    const { conversationId } = failed.json();
    await sleep(100);
    const history = await app.inject({
      method: "GET", url: "/api/conversations/" + conversationId + "/messages", headers: HOST
    });
    assert.deepEqual(history.json(), []);
  } finally { await app.close(); }
});

test("provider ending without a done chunk releases the conversation lock", async () => {
  const noDone: ChatProvider = {
    id: "test",
    capabilities: [{ id: "chat", label: "Test", risk: "safe" }],
    async health() { return "ready"; },
    async *chat(_input: ChatInput, _signal: AbortSignal): AsyncIterable<ChatChunk> {
      yield { type: "delta", text: "partial" };
    }
  };
  const app = createGateway(noDone);
  try {
    const first = await app.inject({ method: "POST", url: "/api/chat", headers: HOST, payload: request() });
    assert.equal(first.statusCode, 202);
    const { conversationId } = first.json();
    await sleep(75);
    const history = await app.inject({
      method: "GET", url: "/api/conversations/" + conversationId + "/messages", headers: HOST
    });
    assert.deepEqual(history.json(), []);
    const followup = await app.inject({
      method: "POST", url: "/api/chat", headers: HOST, payload: request("john", "retry", conversationId)
    });
    assert.equal(followup.statusCode, 202);
  } finally { await app.close(); }
});


test("gateway logging is configurable and silent by default for tests", async () => {
  const silent = createGateway();
  const logged = createGateway(undefined, { logger: true });
  try {
    assert.equal(silent.log.level, "silent");
    assert.equal(logged.log.level, "info");
  } finally {
    await silent.close();
    await logged.close();
  }
});

test("a stale conversation ID returns a detectable 404 so the client can reset", async () => {
  const app = createGateway();
  try {
    const staleId = "c408b907-841e-4bf6-aece-6e4542987c3e";
    const response = await app.inject({
      method: "POST", url: "/api/chat", headers: HOST,
      payload: request("john", "please retry", staleId)
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: { code: "unavailable", message: "Conversation not found.", retryable: false }
    });
  } finally {
    await app.close();
  }
});
