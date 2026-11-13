import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, sendChatRequestSchema, createMissionSchema, updateMissionSchema } from "@glc/shared";
import type { ChatMessage, EventEnvelope, GatewayError, GatewayEvent, ChatProvider, Mission, MissionConflictBody } from "@glc/shared";
import { MockChatProvider } from "./adapters/mock.js";
import { createDefaultNpcRegistry } from "./registry.js";
import { StorageError, isBusyError, createInMemoryMissionRepository } from "./storage/index.js";
import type { MissionRepository } from "./storage/index.js";

const allowedHosts = new Set([
  "127.0.0.1:3001", "localhost:3001",
  "127.0.0.1:5173", "localhost:5173"
]);
const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
const MAX_CONCURRENT = 2;
const RUN_TIMEOUT_MS = 20_000;
const MAX_EVENT_HISTORY = 1000;
const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "The mock provider is temporarily rate limited.",
  timeout: "This mission timed out. Please try again.",
  internal: "The mission failed. Please try again."
};

function fail(code: GatewayError["code"], message: string, retryable = false): { error: GatewayError } {
  return { error: { code, message, retryable } };
}

export function createGateway(provider: ChatProvider = new MockChatProvider(), options: { logger?: boolean; missionRepository?: MissionRepository } = {}) {
  // Production logs errors (including port conflicts), tests stay silent by default.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 12_000 });
  const registry = createDefaultNpcRegistry(provider);
  // The caller owns (and closes) a repository it passes in. A repository created here is closed here.
  const repository = options.missionRepository ?? createInMemoryMissionRepository();
  const ownsRepository = !options.missionRepository;
  app.addHook("onClose", async () => { if (ownsRepository) repository.close(); });
  const conversations = new Map<string, ChatMessage[]>();
  const owners = new Map<string, string>();
  const activeConversations = new Set<string>();
  const runs = new Map<string, AbortController>();
  const subscribers = new Set<(event: EventEnvelope) => void>();
  const history: EventEnvelope[] = [];
  let nextEventId = 0;

  function publish(event: GatewayEvent) {
    const envelope: EventEnvelope = { id: ++nextEventId, at: new Date().toISOString(), event };
    history.push(envelope);
    if (history.length > MAX_EVENT_HISTORY) history.shift();
    for (const subscriber of subscribers) subscriber(envelope);
  }

  // Host header checks protect loopback services against DNS rebinding.
  // The allowed Vite hosts are needed because Vite forwards Host unchanged.
  app.addHook("onRequest", async (request, reply) => {
    const requestedHost = request.headers.host?.toLowerCase();
    if (!requestedHost || !allowedHosts.has(requestedHost)) {
      return reply.code(403).send(fail("auth", "Untrusted request host."));
    }
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send(fail("auth", "Untrusted browser origin."));
    }
  });

  app.get("/api/health", async () => ({ protocol: PROTOCOL_VERSION, mode: "mock" }));
  app.get("/api/npcs", async () => registry.list());

  // Mission Board: records and assignment metadata only. No AI is called here.
  // PATCH and DELETE require If-Match: "<revision>" (428 missing, 400 malformed, 409 stale).
  const missionIdPattern = /^[0-9a-f-]{36}$/i;

  function sendMission(reply: FastifyReply, status: number, mission: Mission) {
    return reply.code(status).header("ETag", `"${mission.revision}"`)
      .header("Cache-Control", "no-store").send(mission);
  }

  function sendConflict(reply: FastifyReply, reason: MissionConflictBody["reason"], current: Mission) {
    const message = reason === "active_run"
      ? "This mission has an active team run and cannot be deleted."
      : "This mission was changed elsewhere. Reload it before saving again.";
    const body: MissionConflictBody = { error: { code: "conflict", message, retryable: false }, reason, current };
    return reply.code(409).header("ETag", `"${current.revision}"`).header("Cache-Control", "no-store").send(body);
  }

  function readIfMatch(request: FastifyRequest, reply: FastifyReply): number | null {
    const header = request.headers["if-match"];
    if (header === undefined) {
      reply.code(428).send(fail("precondition_required",
        "Send If-Match with the mission revision you last loaded, for example If-Match: \"3\"."));
      return null;
    }
    const match = typeof header === "string" ? /^"([1-9][0-9]{0,8})"$/.exec(header.trim()) : null;
    if (!match) {
      reply.code(400).send(fail("invalid_request", "If-Match must be a single quoted revision number, for example \"3\"."));
      return null;
    }
    return Number(match[1]);
  }

  function unknownNpc(...ids: Array<string | null | undefined>): boolean {
    return ids.some(id => id !== null && id !== undefined && !registry.get(id));
  }

  function storageFailure(reply: FastifyReply, error: unknown, logMessage: string, userMessage: string) {
    if (error instanceof StorageError && error.code === "invalid_change") {
      return reply.code(400).send(fail("invalid_request", error.message));
    }
    if (isBusyError(error)) {
      app.log.warn({ err: error }, logMessage);
      return reply.code(503).send(fail("unavailable", "The mission database is busy. Please try again.", true));
    }
    app.log.error({ err: error }, logMessage);
    return reply.code(500).send(fail("internal", userMessage));
  }

  app.get("/api/missions", async (_request, reply) => {
    try {
      return await repository.list();
    } catch (error) {
      return storageFailure(reply, error, "Could not read local missions", "Local mission storage is unavailable.");
    }
  });

  app.get<{ Params: { id: string } }>("/api/missions/:id", async (request, reply) => {
    if (!missionIdPattern.test(request.params.id)) {
      return reply.code(400).send(fail("invalid_request", "Invalid mission ID."));
    }
    try {
      const mission = await repository.get(request.params.id);
      if (!mission) return reply.code(404).send(fail("unavailable", "Mission not found."));
      return sendMission(reply, 200, mission);
    } catch (error) {
      return storageFailure(reply, error, "Could not read local mission", "Local mission storage is unavailable.");
    }
  });

  app.post("/api/missions", async (request, reply) => {
    const parsed = createMissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail("invalid_request", "Mission title, notes, assignee, lead, or participants are invalid."));
    }
    const { assignedNpcId, leadNpcId, participantNpcIds } = parsed.data;
    if (unknownNpc(assignedNpcId, leadNpcId, ...(participantNpcIds ?? []))) {
      return reply.code(400).send(fail("invalid_request", "Choose registered Corps members."));
    }
    try {
      const mission = await repository.create(parsed.data);
      reply.header("Location", "/api/missions/" + mission.id);
      return sendMission(reply, 201, mission);
    } catch (error) {
      return storageFailure(reply, error, "Could not save local mission", "Mission could not be saved locally.");
    }
  });

  app.patch<{ Params: { id: string } }>("/api/missions/:id", async (request, reply) => {
    if (!missionIdPattern.test(request.params.id)) {
      return reply.code(400).send(fail("invalid_request", "Invalid mission ID."));
    }
    const expectedRevision = readIfMatch(request, reply);
    if (expectedRevision === null) return reply;
    const parsed = updateMissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail("invalid_request", "Mission changes are invalid."));
    }
    if (unknownNpc(parsed.data.assignedNpcId, parsed.data.leadNpcId, ...(parsed.data.participantNpcIds ?? []))) {
      return reply.code(400).send(fail("invalid_request", "Choose registered Corps members."));
    }
    try {
      const outcome = await repository.update(request.params.id, expectedRevision, parsed.data);
      if (outcome.ok) return sendMission(reply, 200, outcome.mission);
      if (outcome.reason === "not_found") return reply.code(404).send(fail("unavailable", "Mission not found."));
      return sendConflict(reply, "stale_revision", outcome.current);
    } catch (error) {
      return storageFailure(reply, error, "Could not update local mission", "Mission could not be updated locally.");
    }
  });

  app.delete<{ Params: { id: string } }>("/api/missions/:id", async (request, reply) => {
    if (!missionIdPattern.test(request.params.id)) {
      return reply.code(400).send(fail("invalid_request", "Invalid mission ID."));
    }
    const expectedRevision = readIfMatch(request, reply);
    if (expectedRevision === null) return reply;
    try {
      const outcome = await repository.delete(request.params.id, expectedRevision);
      if (outcome.ok) return reply.code(204).send();
      if (outcome.reason === "not_found") return reply.code(404).send(fail("unavailable", "Mission not found."));
      return sendConflict(reply, outcome.reason, outcome.current);
    } catch (error) {
      return storageFailure(reply, error, "Could not delete local mission", "Mission could not be removed locally.");
    }
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) {
      return reply.code(400).send(fail("invalid_request", "Invalid conversation ID."));
    }
    return conversations.get(request.params.id) ?? [];
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = sendChatRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail("invalid_request", "Please enter a message up to 2000 characters."));
    const { npcId, text, conversationId: existingId } = parsed.data;
    const entry = registry.get(npcId);
    if (!entry) return reply.code(404).send(fail("unavailable", "Unknown NPC."));
    if (!entry.provider || !entry.descriptor.capabilities.some(cap => cap.id === "chat")) {
      return reply.code(503).send(fail("unavailable", "This NPC is not connected yet."));
    }
    const selectedProvider = entry.provider;
    if (runs.size >= MAX_CONCURRENT) return reply.code(429).send(fail("rate_limited", "Too many simultaneous missions.", true));

    const conversationId = existingId ?? randomUUID();
    if (activeConversations.has(conversationId)) {
      return reply.code(409).send(fail("invalid_request", "This conversation already has a mission in progress."));
    }
    if (owners.has(conversationId) && owners.get(conversationId) !== npcId) {
      return reply.code(409).send(fail("invalid_request", "This conversation belongs to another NPC."));
    }
    // An unknown supplied UUID must not create a conversation or bypass ownership checks.
    if (existingId && !owners.has(conversationId)) {
      return reply.code(404).send(fail("unavailable", "Conversation not found."));
    }

    const messages = conversations.get(conversationId) ?? [];
    if (messages.length > 80) return reply.code(429).send(fail("rate_limited", "Conversation is too long for mock mode."));
    const userMessageId = randomUUID();
    const runId = randomUUID();
    const userMessage: ChatMessage = {
      id: userMessageId, conversationId, role: "user", content: text, createdAt: new Date().toISOString()
    };
    const controller = new AbortController();

    // Reserve the conversation synchronously before spawning the async worker.
    owners.set(conversationId, npcId);
    activeConversations.add(conversationId);
    runs.set(runId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Timed out")), RUN_TIMEOUT_MS);

    void (async () => {
      publish({ type: "run.started", runId, npcId, conversationId });
      let result = "";
      let completed = false;
      try {
        for await (const chunk of selectedProvider.chat({
          messages: [...messages, userMessage].map(({ role, content }) => ({ role, content })),
          maxOutputTokens: 240
        }, controller.signal)) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (chunk.type === "delta") {
            result += chunk.text;
            publish({ type: "run.delta", runId, text: chunk.text });
          } else if (chunk.type === "done") {
            const messageId = randomUUID();
            // Commit the user and assistant turn atomically only on success.
            messages.push(userMessage, {
              id: messageId,
              conversationId,
              role: "assistant",
              content: result.trim(),
              createdAt: new Date().toISOString()
            });
            conversations.set(conversationId, messages);
            completed = true;
            publish({ type: "run.completed", runId, messageId, usage: chunk.usage });
            break;
          }
        }
        if (!completed && !controller.signal.aborted) {
          publish({
            type: "run.failed", runId,
            error: { code: "internal", message: "The provider ended without completing its response.", retryable: true }
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === "Timed out";
          publish(timedOut
            ? { type: "run.failed", runId, error: { code: "timeout", message: ERROR_MESSAGES.timeout, retryable: true } }
            : { type: "run.cancelled", runId });
        } else {
          const code = (error as { code?: string }).code === "rate_limited" ? "rate_limited" : "internal";
          // Never reveal arbitrary provider SDK error strings or credentials to the client.
          app.log.error({ err: error, runId }, "Provider mission failed");
          publish({
            type: "run.failed", runId,
            error: { code, message: ERROR_MESSAGES[code], retryable: code === "rate_limited" }
          });
        }
      } finally {
        clearTimeout(timeout);
        runs.delete(runId);
        activeConversations.delete(conversationId);
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

    // Only replay on reconnect. New subscribers start with a fresh cursor.
    // The ready event carries an ID even when no mission events have occurred,
    // so EventSource can recover events lost during its first reconnect.
    const header = request.headers["last-event-id"];
    const resumeId = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : null;
    const send = (envelope: EventEnvelope) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write("id: " + envelope.id + "\ndata: " + JSON.stringify(envelope) + "\n\n");
      }
    };

    // JavaScript event loop is single threaded: subscription and history replay
    // cannot interleave with publish while this callback is synchronous.
    subscribers.add(send);
    if (resumeId !== null) {
      for (const item of history) if (item.id > resumeId) send(item);
    }
    res.write("id: " + nextEventId + "\nevent: ready\ndata: {}\n\n");
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
    }, 12_000);
    request.raw.on("close", () => {
      subscribers.delete(send);
      clearInterval(heartbeat);
    });
  });

  return app;
}
