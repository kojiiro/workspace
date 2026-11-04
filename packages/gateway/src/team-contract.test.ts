import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  TEAM_CONTRACT_DRAFT_VERSION, TEAM_RUN_TERMINAL_STATES,
  TEAM_RUN_TRANSITIONS, DEFAULT_TEAM_MOCK_LIMITS,
  isAllowedTeamRunTransition, teamRunLimitsSchema,
  teamActorSchema, teamEventSchema, teamPlanOutputSchema,
  teamPlanUsesOnlyParticipants, startTeamRunRequestSchema,
  commanderTeamReviewSchema, teamMissionRecordSchema
} from "@glc/shared";

test("contract is draft-only; terminal states never resume", () => {
  assert.equal(TEAM_CONTRACT_DRAFT_VERSION,2);
  for(const terminal of TEAM_RUN_TERMINAL_STATES) {
    assert.deepEqual(TEAM_RUN_TRANSITIONS[terminal],[]);
    for(const state of Object.keys(TEAM_RUN_TRANSITIONS)) {
      assert.equal(isAllowedTeamRunTransition(
        terminal,state as keyof typeof TEAM_RUN_TRANSITIONS
      ),false);
    }
  }
  assert.equal(isAllowedTeamRunTransition("queued","planning"),true);
  assert.equal(isAllowedTeamRunTransition("planning","completed"),false);
  assert.equal(isAllowedTeamRunTransition("reviewing","awaiting_commander_review"),true);
});

test("paused runs resume only to their stored interrupted state", () => {
  assert.equal(isAllowedTeamRunTransition("working","paused"),true);
  assert.equal(isAllowedTeamRunTransition("paused","working"),false);
  assert.equal(isAllowedTeamRunTransition("paused","working","working"),true);
  assert.equal(isAllowedTeamRunTransition("paused","reviewing","working"),false);
  assert.equal(isAllowedTeamRunTransition("paused","cancelling"),true);
  assert.equal(isAllowedTeamRunTransition("cancelling","cancelled"),true);
});

test("client cannot provide providers, participants or action approvals", () => {
  const id=randomUUID();
  assert.deepEqual(startTeamRunRequestSchema.parse({clientRequestId:id}),{clientRequestId:id});
  assert.equal(startTeamRunRequestSchema.safeParse({
    clientRequestId:id, mode:"live", provider:"openai", participants:["john"]
  }).success,false);
  assert.equal(commanderTeamReviewSchema.safeParse({
    decision:"approve",authorizeFileEdits:true
  }).success,false);
  for(const decision of ["approve","request_changes","reject"]) {
    assert.equal(commanderTeamReviewSchema.safeParse({decision}).success,true);
  }
});

test("bounded mock limits and structured work are validated", () => {
  assert.equal(teamRunLimitsSchema.safeParse(DEFAULT_TEAM_MOCK_LIMITS).success,true);
  assert.equal(teamRunLimitsSchema.safeParse({
    ...DEFAULT_TEAM_MOCK_LIMITS,maxRevisionRounds:10
  }).success,false);
  const plan=teamPlanOutputSchema.parse({
    summary:"Build website",
    subtasks:[
      {participantNpcId:"john",instruction:"Draft content"},
      {participantNpcId:"kyle",instruction:"Review content"}
    ]
  });
  assert.equal(teamPlanUsesOnlyParticipants(plan,["john","kyle"]),true);
  assert.equal(teamPlanUsesOnlyParticipants(plan,["john"]),false);
  assert.equal(teamPlanOutputSchema.safeParse({
    summary:"Unlimited",
    subtasks:Array.from({length:5},()=>({participantNpcId:"john",instruction:"Work"}))
  }).success,false);
});

test("event provenance, sender and recipient have strict shape", () => {
  const sample={
    cursor:1,id:randomUUID(),missionId:randomUUID(),teamRunId:randomUUID(),
    sequence:1,round:0,at:new Date().toISOString(),kind:"delegation",
    from:{type:"npc",npcId:"hal"},to:[{type:"npc",npcId:"john"}],
    text:"Create a draft",provenance:{mode:"mock",adapterId:"mock"}
  };
  assert.equal(teamEventSchema.safeParse(sample).success,true);
  assert.equal(teamEventSchema.safeParse({...sample,text:"x".repeat(6001)}).success,false);
  assert.equal(teamEventSchema.safeParse({
    ...sample,provenance:{mode:"mock",adapterId:"mock",apiKey:"invalid"}
  }).success,false);
  assert.equal(teamActorSchema.safeParse({type:"commander",npcId:"hal"}).success,false);
});

test("revision and duplicate participant rules are enforced", () => {
  const mission={
    id:randomUUID(),title:"Build website",notes:"Local",
    assignedNpcId:"hal",leadNpcId:"hal",participantNpcIds:["john","kyle"],
    status:"planned",revision:1,activeRunId:null,
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  assert.equal(teamMissionRecordSchema.safeParse(mission).success,true);
  assert.equal(teamMissionRecordSchema.safeParse({...mission,revision:0}).success,false);
  assert.equal(teamMissionRecordSchema.safeParse({
    ...mission,participantNpcIds:["john","john"]
  }).success,false);
});
