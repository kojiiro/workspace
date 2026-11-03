import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, sendChatRequestSchema } from "@glc/shared";
import type { ChatMessage, EventEnvelope, GatewayError, GatewayEvent, NpcDescriptor, ChatProvider } from "@glc/shared";
import { MockChatProvider } from "./adapters/mock.js";

const app = Fastify({ logger: true, bodyLimit: 12_000 });
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
const provider: ChatProvider = new MockChatProvider();

const john: NpcDescriptor = {
  id: "john", displayName: "John Stewart", represents: "ChatGPT (mock mode)",
  adapterId: "mock",
  capabilities: [{ id: "chat", label: "Talk to John", risk: "safe" }],
  status: "ready"
};
const conversations = new Map<string, ChatMessage[]>();
const runs = new Map<string, AbortController>();
const subscribers = new Set<(event: EventEnvelope) => void>();
const history: EventEnvelope[] = [];
let nextEventId = 0;
const MAX_CONCURRENT = 2;
const RUN_TIMEOUT_MS = 20_000;

function publish(event: GatewayEvent) {
  const envelope: EventEnvelope = { id: ++nextEventId, at: new Date().toISOString(), event };
  history.push(envelope);
  if (history.length > 1000) history.shift();
  for (const subscriber of subscribers) subscriber(envelope);
}
function fail(code: GatewayError["code"], message: string, retryable = false): { error: GatewayError } {
  return { error: { code, message, retryable } };
}

// No wildcard CORS: only this local Vite client can send browser requests.
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    return reply.code(403).send(fail("auth", "Untrusted browser origin."));
  }
});
app.get("/api/health", async () => ({ protocol: PROTOCOL_VERSION, mode: "mock" }));
app.get("/api/npcs", async () => [john]);
app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
  if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return reply.code(400).send(fail("invalid_request", "Invalid conversation ID."));
  return conversations.get(request.params.id) ?? [];
});

app.post("/api/chat", async (request, reply) => {
  const parsed = sendChatRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(fail("invalid_request", "Please enter a message up to 2000 characters."));
  const { npcId, text, conversationId: existingId } = parsed.data;
  if (npcId !== "john") return reply.code(404).send(fail("unavailable", "This NPC is not available in the prototype."));
  if (runs.size >= MAX_CONCURRENT) return reply.code(429).send(fail("rate_limited", "Too many simultaneous missions.", true));
  const conversationId = existingId ?? randomUUID();
  const messages = conversations.get(conversationId) ?? [];
  if (messages.length > 80) return reply.code(429).send(fail("rate_limited", "Conversation is too long for mock mode."));
  const userMessageId = randomUUID(), runId = randomUUID();
  messages.push({ id: userMessageId, conversationId, role: "user", content: text, createdAt: new Date().toISOString() });
  conversations.set(conversationId, messages);
  const controller = new AbortController();
  runs.set(runId, controller);
  const timeout = setTimeout(() => controller.abort(new Error("Timed out")), RUN_TIMEOUT_MS);
  // This returns immediately; the separate SSE endpoint streams the response.
  void (async () => {
    publish({ type: "run.started", runId, npcId, conversationId });
    let result = "";
    try {
      for await (const chunk of provider.chat({
        messages: messages.map(({ role, content }) => ({ role, content })),
        maxOutputTokens: 240
      }, controller.signal)) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (chunk.type === "delta") {
          result += chunk.text;
          publish({ type: "run.delta", runId, text: chunk.text });
        } else {
          const messageId = randomUUID();
          messages.push({ id: messageId, conversationId, role: "assistant", content: result.trim(), createdAt: new Date().toISOString() });
          publish({ type: "run.completed", runId, messageId, usage: chunk.usage });
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out";
        publish(timedOut
          ? { type: "run.failed", runId, error: { code: "timeout", message: "The response timed out.", retryable: true } }
          : { type: "run.cancelled", runId });
      } else {
        const code = (error as { code?: string }).code === "rate_limited" ? "rate_limited" : "internal";
        publish({ type: "run.failed", runId, error: { code, message: error instanceof Error ? error.message : "An unexpected error occurred.", retryable: code === "rate_limited" } });
      }
    } finally {
      clearTimeout(timeout);
      runs.delete(runId);
    }
  })();
  return reply.code(202).send({ conversationId, runId, userMessageId });
});

app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (request, reply) => {
  const controller = runs.get(request.params.runId);
  if (!controller) return reply.code(404).send(fail("unavailable", "Run not found or already finished."));
  controller.abort(new Error("Cancelled"));
  return reply.code(204).send();
});

app.get("/api/events", async (request, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  const header = request.headers["last-event-id"];
  const lastId = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : 0;
  const send = (envelope: EventEnvelope) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`id: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`);
  };
  for (const envelope of history) if (envelope.id > lastId) send(envelope);
  subscribers.add(send);
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": ping\n\n"); }, 12_000);
  request.raw.on("close", () => {
    subscribers.delete(send);
    clearInterval(heartbeat);
  });
});

app.listen({ host, port }).then(() => {
  console.log(`GLC gateway listening at http://${host}:${port} (mock only)`);
}).catch(error => { app.log.error(error); process.exit(1); });
