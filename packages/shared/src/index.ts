import { z } from "zod";

// Protocol v2: additive team event notices. Storage PR A (SQLite) adds
// revision-aware Mission Board routes: Mission gains revision, leadNpcId and
// participantNpcIds; PATCH/DELETE require If-Match; ErrorCode gains "conflict"
// and "precondition_required". Chat routes and event envelopes are unchanged.
export const PROTOCOL_VERSION = 2;

export type NpcId = string;
export type ConversationId = string;
export type RunId = string;
export type MessageId = string;
export type CapabilityId =
  | "chat"
  | "compose-message"
  | "read-messages"
  | "send-message";
export type RiskLevel = "safe" | "needs-approval";

export interface Capability {
  id: CapabilityId;
  label: string;
  risk: RiskLevel;
}

export type NpcStatus = "ready" | "busy" | "offline" | "unconfigured";

export interface NpcDescriptor {
  id: NpcId;
  displayName: string;
  represents: string;
  adapterId: string;
  capabilities: Capability[];
  status: NpcStatus;
}

/** A mission is a local project/task record; assigning one does not call an AI. */
export const missionStatusSchema = z.enum(["planned", "in_progress", "completed"]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

const missionTitleSchema = z.string().trim().min(1).max(120);
const missionNotesSchema = z.string().trim().max(1000);
const npcIdSchema = z.string().regex(/^[a-z0-9-]{1,48}$/);
const missionAssigneeSchema = npcIdSchema.nullable();

/** Owner-approved defaults: Hal leads; John (Gemini) and Kyle (Claude) participate. */
export const DEFAULT_MISSION_LEAD_NPC_ID: NpcId = "hal";
export const DEFAULT_MISSION_PARTICIPANT_NPC_IDS: readonly NpcId[] = Object.freeze(["john", "kyle"]);

const missionParticipantsSchema = z.array(npcIdSchema).min(1).max(4).refine(
  ids => new Set(ids).size === ids.length, "Duplicate participant"
);

export const createMissionSchema = z.object({
  title: missionTitleSchema,
  notes: missionNotesSchema.default(""),
  assignedNpcId: missionAssigneeSchema.default(null),
  leadNpcId: npcIdSchema.optional(),
  participantNpcIds: missionParticipantsSchema.optional()
}).strict().refine(
  value => !(value.leadNpcId && value.participantNpcIds?.includes(value.leadNpcId)),
  { path: ["participantNpcIds"], message: "The mission lead cannot also be a participant" }
);

export const updateMissionSchema = z.object({
  title: missionTitleSchema.optional(),
  notes: missionNotesSchema.optional(),
  assignedNpcId: missionAssigneeSchema.optional(),
  status: missionStatusSchema.optional(),
  leadNpcId: npcIdSchema.optional(),
  participantNpcIds: missionParticipantsSchema.optional()
}).strict()
  .refine(value => Object.keys(value).length > 0, "Specify at least one change")
  .refine(
    value => !(value.leadNpcId && value.participantNpcIds?.includes(value.leadNpcId)),
    { path: ["participantNpcIds"], message: "The mission lead cannot also be a participant" }
  );

export type CreateMissionRequest = z.infer<typeof createMissionSchema>;
export type UpdateMissionRequest = z.infer<typeof updateMissionSchema>;

export interface Mission {
  id: string;
  title: string;
  notes: string;
  /** Legacy v1 field. Advisory after migration; it does not select participants. */
  assignedNpcId: NpcId | null;
  leadNpcId: NpcId;
  participantNpcIds: NpcId[];
  status: MissionStatus;
  /** Content revision. Send it back as If-Match on PATCH and DELETE. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Body of a 409 response: a typed error plus the latest mission when it still exists. */
export interface MissionConflictBody {
  error: GatewayError;
  reason: "stale_revision" | "active_run";
  current: Mission;
}

/** Validates every persisted mission before it enters the in-memory store. */
export const missionSchema = z.object({
  id: z.uuid(),
  title: missionTitleSchema,
  notes: missionNotesSchema,
  assignedNpcId: missionAssigneeSchema,
  status: missionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

/** Versioned envelope so later team-mission and SQLite migrations are explicit. */
export const missionFileSchema = z.object({
  schemaVersion: z.literal(1),
  missions: z.array(z.unknown())
}).strict();


export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: Role;
  content: string;
  createdAt: string;
}

export type ErrorCode =
  | "invalid_request"
  | "unavailable"
  | "auth"
  | "rate_limited"
  | "quota_exceeded"
  | "timeout"
  | "cancelled"
  | "conflict"
  | "precondition_required"
  | "internal";

export interface GatewayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface GatewayHealth {
  protocol: number;
  mode: "live" | "mock";
}

export const sendChatRequestSchema = z.object({
  npcId: z.string().regex(/^[a-z0-9-]{1,48}$/),
  conversationId: z.uuid().optional(),
  text: z.string().trim().min(1).max(2000)
});

export type SendChatRequest = z.infer<typeof sendChatRequestSchema>;

export interface SendChatResponse {
  conversationId: ConversationId;
  runId: RunId;
  userMessageId: MessageId;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type GatewayEvent =
  | { type: "run.started"; runId: RunId; npcId: NpcId; conversationId: ConversationId }
  | { type: "run.delta"; runId: RunId; text: string }
  | { type: "run.completed"; runId: RunId; messageId: MessageId; usage: Usage }
  | { type: "run.failed"; runId: RunId; error: GatewayError }
  | { type: "run.cancelled"; runId: RunId }
  | { type: "npc.status"; npcId: NpcId; status: NpcStatus }
  | { type: "team.event"; missionId: string; teamRunId: string; cursor: number };

export interface EventEnvelope {
  id: number;
  at: string;
  event: GatewayEvent;
}

export interface PendingAction {
  id: string;
  npcId: NpcId;
  capability: CapabilityId;
  summary: string;
  createdAt: string;
}

export interface ChatInput {
  messages: Pick<ChatMessage, "role" | "content">[];
  model?: string;
  maxOutputTokens: number;
}

export type ChatChunk =
  | { type: "delta"; text: string }
  | { type: "done"; usage: Usage; model?: string };

export interface ChatProvider {
  readonly id: string;
  readonly capabilities: Capability[];
  chat(input: ChatInput, signal: AbortSignal): AsyncIterable<ChatChunk>;
  health(): Promise<"ready" | "unconfigured" | "offline">;
}

export * from "./team-contract.js";
