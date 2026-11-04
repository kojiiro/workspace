import { z } from "zod";

/**
 * PROPOSED team-mission contract for Prototype 0.4.
 * Adding these unused exports does not enable AI providers or change the live
 * v1 chat protocol. Freeze/version the contract after independent review.
 */
export const TEAM_CONTRACT_DRAFT_VERSION = 2;

const uuid = z.uuid();
const npcId = z.string().regex(/^[a-z0-9-]{1,48}$/);
const isoDate = z.iso.datetime();

export const teamRunStateSchema = z.enum([
  "queued", "planning", "working", "reviewing", "revising",
  "awaiting_commander_review", "paused", "cancelling",
  "completed", "cancelled", "failed"
]);
export type TeamRunState = z.infer<typeof teamRunStateSchema>;

export const teamStepStateSchema = z.enum([
  "pending", "running", "succeeded", "failed", "skipped", "discarded"
]);
export type TeamStepState = z.infer<typeof teamStepStateSchema>;

/** Terminal runs may never exit; pause/resume requires an exact prior state. */
export const TEAM_RUN_TERMINAL_STATES = [
  "completed", "cancelled", "failed"
] as const satisfies readonly TeamRunState[];

export const TEAM_RUN_TRANSITIONS: Record<TeamRunState, readonly TeamRunState[]> = {
  queued: ["planning", "paused", "cancelling", "failed"],
  planning: ["working", "paused", "cancelling", "failed"],
  working: ["reviewing", "paused", "cancelling", "failed"],
  reviewing: ["revising", "awaiting_commander_review", "paused", "cancelling", "failed"],
  revising: ["working", "reviewing", "paused", "cancelling", "failed"],
  awaiting_commander_review: ["revising", "completed", "paused", "cancelling", "failed"],
  paused: ["queued", "planning", "working", "reviewing", "revising",
    "awaiting_commander_review", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: []
};

/**
 * A caller may resume only to the exact stored interrupted state. This is a
 * contract helper, not an orchestrator implementation.
 */
export function isAllowedTeamRunTransition(
  from: TeamRunState,
  to: TeamRunState,
  pausedFrom?: TeamRunState
): boolean {
  if (!TEAM_RUN_TRANSITIONS[from].includes(to)) return false;
  if (from !== "paused" || to === "cancelling" || to === "failed") return true;
  return pausedFrom !== undefined && to === pausedFrom;
}

export const teamRunLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(12),
  maxRevisionRounds: z.number().int().min(0).max(2),
  maxSubtasks: z.number().int().min(1).max(4),
  maxEventCharacters: z.number().int().min(1).max(6000),
  maxEvents: z.number().int().min(1).max(120),
  stepTimeoutMs: z.number().int().min(100).max(20_000),
  runTimeoutMs: z.number().int().min(1000).max(300_000)
}).strict();
export type TeamRunLimits = z.infer<typeof teamRunLimitsSchema>;

/** Server freezes these defaults on each mock run; browser cannot raise them. */
export const DEFAULT_TEAM_MOCK_LIMITS: Readonly<TeamRunLimits> = Object.freeze({
  maxSteps: 12,
  maxRevisionRounds: 2,
  maxSubtasks: 4,
  maxEventCharacters: 6000,
  maxEvents: 120,
  stepTimeoutMs: 20_000,
  runTimeoutMs: 300_000
});

export const teamActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("commander") }).strict(),
  z.object({ type: z.literal("system") }).strict(),
  z.object({ type: z.literal("npc"), npcId }).strict()
]);
export type TeamActor = z.infer<typeof teamActorSchema>;

export const teamEventKindSchema = z.enum([
  "plan", "delegation", "contribution", "review", "revision_request",
  "synthesis", "approval_request", "status", "error",
  "cancelled", "paused", "resumed", "limit_reached", "discarded"
]);

export const teamProvenanceSchema = z.object({
  mode: z.enum(["mock", "live"]),
  adapterId: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128).optional()
}).strict();

export const teamUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().finite().optional()
}).strict();

export const teamEventSchema = z.object({
  cursor: z.number().int().positive(),
  id: uuid,
  missionId: uuid,
  teamRunId: uuid,
  stepId: uuid.optional(),
  parentId: uuid.optional(),
  sequence: z.number().int().positive(),
  round: z.number().int().nonnegative().max(2),
  at: isoDate,
  kind: teamEventKindSchema,
  from: teamActorSchema,
  to: z.array(teamActorSchema).max(6),
  text: z.string().max(6000),
  provenance: teamProvenanceSchema,
  usage: teamUsageSchema.optional()
}).strict();
export type TeamEvent = z.infer<typeof teamEventSchema>;

export const teamMissionRecordSchema = z.object({
  id: uuid,
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000),
  // Legacy Mission Board field remains for a compatible migration.
  assignedNpcId: npcId.nullable(),
  leadNpcId: npcId,
  participantNpcIds: z.array(npcId).min(1).max(4).refine(
    ids => new Set(ids).size === ids.length, "Duplicate participant"
  ),
  status: z.enum(["planned", "in_progress", "completed"]),
  revision: z.number().int().positive(),
  activeRunId: uuid.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate
}).strict();
export type TeamMissionRecord = z.infer<typeof teamMissionRecordSchema>;

export const teamRunSnapshotSchema = z.object({
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000),
  leadNpcId: npcId,
  participantNpcIds: z.array(npcId).min(1).max(4),
  limits: teamRunLimitsSchema
}).strict();
export type TeamRunSnapshot = z.infer<typeof teamRunSnapshotSchema>;

export const teamRunRecordSchema = z.object({
  id: uuid,
  missionId: uuid,
  clientRequestId: uuid,
  state: teamRunStateSchema,
  version: z.number().int().positive(),
  round: z.number().int().nonnegative().max(2),
  snapshot: teamRunSnapshotSchema,
  mode: z.enum(["mock", "live"]),
  pausedFrom: teamRunStateSchema.optional(),
  startedAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.nullable()
}).strict();
export type TeamRunRecord = z.infer<typeof teamRunRecordSchema>;

export const teamPlanOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  subtasks: z.array(z.object({
    participantNpcId: npcId,
    instruction: z.string().trim().min(1).max(1000)
  }).strict()).min(1).max(4)
}).strict();
export type TeamPlanOutput = z.infer<typeof teamPlanOutputSchema>;

/** Additional dynamic validation; the plan cannot invent new teammates. */
export function teamPlanUsesOnlyParticipants(
  plan: TeamPlanOutput,
  participants: readonly string[]
): boolean {
  const permitted = new Set(participants);
  return plan.subtasks.every(task => permitted.has(task.participantNpcId));
}

export const teamReviewOutputSchema = z.object({
  verdict: z.enum(["accept", "request_revision"]),
  findings: z.array(z.string().trim().min(1).max(1000)).max(4),
  summary: z.string().trim().min(1).max(1000)
}).strict();

export const startTeamRunRequestSchema = z.object({
  clientRequestId: uuid
}).strict();
export type StartTeamRunRequest = z.infer<typeof startTeamRunRequestSchema>;

export const commanderTeamReviewSchema = z.object({
  decision: z.enum(["approve", "request_changes", "reject"]),
  notes: z.string().trim().max(1000).default("")
}).strict();
export type CommanderTeamReview = z.infer<typeof commanderTeamReviewSchema>;

/** Live notifications carry only references; the canonical event lives on disk. */
export const teamEventNoticeSchema = z.object({
  type: z.literal("team.event"),
  missionId: uuid,
  teamRunId: uuid,
  cursor: z.number().int().positive()
}).strict();
