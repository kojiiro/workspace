import { z } from "zod";

// Architecture v1, agreed by ChatGPT and Claude. Bump on breaking changes.
export const PROTOCOL_VERSION = 1;

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
  | { type: "npc.status"; npcId: NpcId; status: NpcStatus };

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
  | { type: "done"; usage: Usage };

export interface ChatProvider {
  readonly id: string;
  readonly capabilities: Capability[];
  chat(input: ChatInput, signal: AbortSignal): AsyncIterable<ChatChunk>;
  health(): Promise<"ready" | "unconfigured" | "offline">;
}
