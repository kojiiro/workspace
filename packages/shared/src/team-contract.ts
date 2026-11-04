import { z } from "zod";

/**
 * Candidate contract for Prototype 0.4. This module is exported for testing
 * and review only: the active v1 gateway does not execute team missions.
 * Freeze the contract and bump PROTOCOL_VERSION only after Claude approves.
 */
export const TEAM_CONTRACT_DRAFT_VERSION = 2;
const uuid = z.uuid();
const npcId = z.string().regex(/^[a-z0-9-]{1,48}$/);
const iso = z.iso.datetime();
const positiveVersion = z.number().int().positive();
const round = z.number().int().min(0).max(4);

export const teamRunStateSchema = z.enum([
  "queued","planning","working","reviewing","revising",
  "awaiting_commander_review","paused","cancelling",
  "completed","cancelled","failed"
]);
export type TeamRunState = z.infer<typeof teamRunStateSchema>;
export const teamStepStateSchema = z.enum([
  "pending","running","succeeded","failed","skipped","discarded"
]);
export type TeamStepState = z.infer<typeof teamStepStateSchema>;

export const TEAM_RUN_TERMINAL_STATES = [
  "completed","cancelled","failed"
] as const satisfies readonly TeamRunState[];

export const TEAM_RUN_TRANSITIONS: Record<TeamRunState,readonly TeamRunState[]> = {
  queued: ["planning","paused","cancelling","failed"],
  planning: ["working","paused","cancelling","failed"],
  working: ["reviewing","paused","cancelling","failed"],
  reviewing: ["revising","awaiting_commander_review","paused","cancelling","failed"],
  revising: ["working","reviewing","paused","cancelling","failed"],
  awaiting_commander_review: ["revising","completed","paused","cancelling","failed"],
  paused: ["queued","planning","working","reviewing","revising",
    "awaiting_commander_review","cancelling","failed"],
  cancelling: ["cancelled","failed"],
  completed: [], cancelled: [], failed: []
};

export function isAllowedTeamRunTransition(
  from:TeamRunState, to:TeamRunState, pausedFrom?:TeamRunState|null
):boolean {
  if (!TEAM_RUN_TRANSITIONS[from].includes(to)) return false;
  if (from!=="paused" || to==="cancelling" || to==="failed") return true;
  return pausedFrom!=null && to===pausedFrom;
}

export const teamRunLimitsSchema = z.object({
  maxSteps:z.number().int().min(1).max(12),
  maxRevisionRounds:z.number().int().min(0).max(2),
  maxCommanderRevisionRounds:z.number().int().min(0).max(2),
  maxSubtasks:z.number().int().min(1).max(4),
  maxEventCharacters:z.number().int().min(1).max(6000),
  maxEvents:z.number().int().min(1).max(120),
  stepTimeoutMs:z.number().int().min(100).max(20_000),
  // Counts active execution time ONLY, excluding paused and commander review.
  activeRunTimeoutMs:z.number().int().min(1000).max(300_000)
}).strict();
export type TeamRunLimits=z.infer<typeof teamRunLimitsSchema>;
export const DEFAULT_TEAM_MOCK_LIMITS:Readonly<TeamRunLimits>=Object.freeze({
  maxSteps:12,maxRevisionRounds:2,maxCommanderRevisionRounds:2,
  maxSubtasks:4,maxEventCharacters:6000,maxEvents:120,
  stepTimeoutMs:20_000,activeRunTimeoutMs:300_000
});
export const MAX_TEAM_TOTAL_ROUNDS=4;

export const teamActorSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("commander")}).strict(),
  z.object({type:z.literal("system")}).strict(),
  z.object({type:z.literal("npc"),npcId}).strict()
]);
export type TeamActor=z.infer<typeof teamActorSchema>;

export const teamEventKindSchema=z.enum([
  "plan","delegation","contribution","review","revision_request",
  "synthesis","approval_request","commander_decision","status","error",
  "cancelled","paused","resumed","limit_reached","discarded"
]);
export const teamProvenanceSchema=z.object({
  mode:z.enum(["mock","live"]),
  adapterId:z.string().trim().min(1).max(64),
  model:z.string().trim().min(1).max(128).optional()
}).strict();
export const teamUsageSchema=z.object({
  inputTokens:z.number().int().nonnegative().optional(),
  outputTokens:z.number().int().nonnegative().optional(),
  // Integer micro-US-dollars; no floating point currency in persisted events.
  costMicros:z.number().int().nonnegative().optional()
}).strict();
export const teamEventSchema=z.object({
  cursor:z.number().int().positive(),
  id:uuid, missionId:uuid,teamRunId:uuid,
  stepId:uuid.nullable(),
  attemptId:uuid.nullable(),
  parentId:uuid.nullable(),
  sequence:z.number().int().positive(),
  round,
  at:iso,
  kind:teamEventKindSchema,
  from:teamActorSchema,
  to:z.array(teamActorSchema).max(6),
  text:z.string().max(6000),
  provenance:teamProvenanceSchema,
  usage:teamUsageSchema.nullable()
}).strict();
export type TeamEvent=z.infer<typeof teamEventSchema>;

// Server-only append input. Durable cursor/id/sequence/time are assigned inside
// the repository transaction, never trusted from an AI model or browser.
export const newTeamEventSchema=teamEventSchema.omit({
  cursor:true,id:true,sequence:true,at:true
});
export type NewTeamEvent=z.infer<typeof newTeamEventSchema>;

const participants=z.array(npcId).min(1).max(4).refine(
  ids=>new Set(ids).size===ids.length,"Duplicate participant"
);
export const teamMissionRecordSchema=z.object({
  id:uuid,title:z.string().trim().min(1).max(120),
  notes:z.string().trim().max(1000),
  // Existing v1 field remains advisory after a migration.
  assignedNpcId:npcId.nullable(),
  leadNpcId:npcId,
  participantNpcIds:participants,
  status:z.enum(["planned","in_progress","completed"]),
  revision:positiveVersion,
  // Active run is DERIVED from the team_runs partial unique index.
  createdAt:iso,updatedAt:iso
}).strict().refine(record=>!record.participantNpcIds.includes(record.leadNpcId),{
  path:["participantNpcIds"],message:"The mission lead cannot also be a participant"
});
export type TeamMissionRecord=z.infer<typeof teamMissionRecordSchema>;

export const teamRunSnapshotSchema=z.object({
  title:z.string().trim().min(1).max(120),
  notes:z.string().trim().max(1000),
  leadNpcId:npcId,
  participantNpcIds:participants,
  limits:teamRunLimitsSchema
}).strict().refine(snapshot=>!snapshot.participantNpcIds.includes(snapshot.leadNpcId),{
  path:["participantNpcIds"],message:"The run lead cannot also be a participant"
});
export type TeamRunSnapshot=z.infer<typeof teamRunSnapshotSchema>;

export const teamRunEndReasonSchema=z.enum([
  "approved","commander_rejected","commander_cancelled",
  "limit_reached","lead_unavailable","run_timeout","internal_error"
]);
export type TeamRunEndReason=z.infer<typeof teamRunEndReasonSchema>;

export const teamRunRecordSchema=z.object({
  id:uuid,missionId:uuid,clientRequestId:uuid,
  state:teamRunStateSchema,version:positiveVersion,round,
  snapshot:teamRunSnapshotSchema,
  mode:z.enum(["mock","live"]),
  pausedFrom:teamRunStateSchema.nullable(),
  endReason:teamRunEndReasonSchema.nullable(),
  unreviewed:z.boolean(),
  // Active execution time accumulated before pause/review, in milliseconds.
  activeExecutionMs:z.number().int().nonnegative(),
  startedAt:iso,updatedAt:iso,completedAt:iso.nullable()
}).strict().superRefine((run,ctx)=>{
  const terminal=TEAM_RUN_TERMINAL_STATES.some(s=>s===run.state);
  if ((run.state==="paused")!==(run.pausedFrom!==null)) {
    ctx.addIssue({code:"custom",path:["pausedFrom"],message:"pausedFrom is required exactly while paused"});
  }
  if (terminal!==(run.completedAt!==null)|| (terminal&&run.endReason===null)) {
    ctx.addIssue({code:"custom",path:["completedAt"],message:"Terminal runs need a completion time and reason"});
  }
});
export type TeamRunRecord=z.infer<typeof teamRunRecordSchema>;

export const teamStepRecordSchema=z.object({
  id:uuid,runId:uuid,npcId,position:z.number().int().nonnegative(),
  round,state:teamStepStateSchema,createdAt:iso,updatedAt:iso
}).strict();
export type TeamStepRecord=z.infer<typeof teamStepRecordSchema>;
export const teamStepAttemptStateSchema=z.enum(["running","succeeded","failed","discarded"]);
export const teamStepAttemptRecordSchema=z.object({
  id:uuid,stepId:uuid,attemptNo:positiveVersion,
  state:teamStepAttemptStateSchema,
  startedAt:iso,endedAt:iso.nullable(),usage:teamUsageSchema.nullable()
}).strict();
export type TeamStepAttemptRecord=z.infer<typeof teamStepAttemptRecordSchema>;

// Models can add harmless extra keys; only validated known fields survive parse.
// Client-originated requests elsewhere remain strict.
const modelSubtaskSchema=z.object({
  participantNpcId:npcId,
  instruction:z.string().trim().min(1).max(1000)
});
export const teamPlanOutputSchema=z.object({
  summary:z.string().trim().min(1).max(1000),
  subtasks:z.array(modelSubtaskSchema).min(1).max(4)
});
export type TeamPlanOutput=z.infer<typeof teamPlanOutputSchema>;
export function teamPlanUsesOnlyParticipants(
  plan:TeamPlanOutput,allowed:readonly string[]
):boolean {
  const ids=new Set(allowed);
  return plan.subtasks.every(s=>ids.has(s.participantNpcId));
}

const modelFindingSchema=z.string().trim().min(1).max(1000);
const reviewBase={
  findings:z.array(modelFindingSchema).max(4),
  summary:z.string().trim().min(1).max(1000)
};
export const teamReviewOutputSchema=z.discriminatedUnion("verdict",[
  z.object({...reviewBase,verdict:z.literal("accept")}),
  z.object({...reviewBase,verdict:z.literal("request_revision"),
    revisions:z.array(modelSubtaskSchema).min(1).max(4)})
]);
export type TeamReviewOutput=z.infer<typeof teamReviewOutputSchema>;
export function teamReviewUsesOnlyParticipants(
  review:TeamReviewOutput,allowed:readonly string[],reviewerNpcId:string
):boolean {
  if (!allowed.includes(reviewerNpcId)) return false;
  if (review.verdict==="accept") return true;
  return review.revisions.every(item=>
    item.participantNpcId!==reviewerNpcId && allowed.includes(item.participantNpcId)
  );
}
// A model cannot decide whether peer review was completed. The orchestrator
// derives unreviewed and gaps from durable step outcomes, not model text.
export const teamSynthesisOutputSchema=z.object({
  summary:z.string().trim().min(1).max(1000),
  deliverable:z.string().trim().min(1).max(6000)
});
export type TeamSynthesisOutput=z.infer<typeof teamSynthesisOutputSchema>;

export const startTeamRunRequestSchema=z.object({
  clientRequestId:uuid
}).strict();
export type StartTeamRunRequest=z.infer<typeof startTeamRunRequestSchema>;

export const commanderTeamReviewSchema=z.object({
  decision:z.enum(["approve","request_changes","reject"]),
  notes:z.string().trim().max(1000).default(""),
  expectedRunVersion:positiveVersion,
  acknowledgeUnreviewed:z.boolean().default(false)
}).strict().superRefine((review,ctx)=>{
  if(review.decision==="request_changes" && !review.notes) {
    ctx.addIssue({code:"custom",path:["notes"],message:"Request changes requires an explanation"});
  }
});
export type CommanderTeamReview=z.infer<typeof commanderTeamReviewSchema>;

export const teamEventNoticeSchema=z.object({
  type:z.literal("team.event"),
  missionId:uuid,teamRunId:uuid,cursor:z.number().int().positive()
}).strict();
