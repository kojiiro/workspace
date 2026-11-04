import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  TEAM_CONTRACT_DRAFT_VERSION,TEAM_RUN_TERMINAL_STATES,
  TEAM_RUN_TRANSITIONS,DEFAULT_TEAM_MOCK_LIMITS,MAX_TEAM_TOTAL_ROUNDS,
  isAllowedTeamRunTransition,teamRunLimitsSchema,teamActorSchema,
  teamEventSchema,newTeamEventSchema,teamPlanOutputSchema,
  teamPlanUsesOnlyParticipants,teamReviewOutputSchema,
  teamReviewUsesOnlyParticipants,teamSynthesisOutputSchema,
  teamRunRecordSchema,teamRunSnapshotSchema,teamStepRecordSchema,teamStepAttemptRecordSchema,
  startTeamRunRequestSchema,commanderTeamReviewSchema,teamMissionRecordSchema
} from "@glc/shared";

const iso=new Date().toISOString();
const uuid=()=>randomUUID();

test("terminal run states have no exits, and illegal transitions fail",()=>{
  assert.equal(TEAM_CONTRACT_DRAFT_VERSION,2);
  for(const state of TEAM_RUN_TERMINAL_STATES) {
    assert.deepEqual(TEAM_RUN_TRANSITIONS[state],[]);
    for(const next of Object.keys(TEAM_RUN_TRANSITIONS)) {
      assert.equal(isAllowedTeamRunTransition(state,next as keyof typeof TEAM_RUN_TRANSITIONS),false);
    }
  }
  assert.equal(isAllowedTeamRunTransition("queued","planning"),true);
  assert.equal(isAllowedTeamRunTransition("reviewing","completed"),false);
  assert.equal(isAllowedTeamRunTransition("awaiting_commander_review","revising"),true);
});

test("paused run can resume only to the state recorded before restart",()=>{
  assert.equal(isAllowedTeamRunTransition("working","paused"),true);
  assert.equal(isAllowedTeamRunTransition("paused","working"),false);
  assert.equal(isAllowedTeamRunTransition("paused","working","working"),true);
  assert.equal(isAllowedTeamRunTransition("paused","reviewing","working"),false);
  assert.equal(isAllowedTeamRunTransition("paused","cancelling"),true);
  assert.equal(isAllowedTeamRunTransition("cancelling","cancelled"),true);
});

test("client cannot select hidden providers or add action authorization",()=>{
  const id=uuid();
  assert.deepEqual(startTeamRunRequestSchema.parse({clientRequestId:id}),{clientRequestId:id});
  assert.equal(startTeamRunRequestSchema.safeParse({
    clientRequestId:id,mode:"live",provider:"openai",participants:["john"]
  }).success,false);
  assert.equal(commanderTeamReviewSchema.safeParse({
    decision:"approve",expectedRunVersion:3,authorizeFileEdits:true
  }).success,false);
});

test("commander review requires version, notes for revisions, and acknowledgement",()=>{
  for(const decision of ["approve","reject"]) {
    assert.equal(commanderTeamReviewSchema.safeParse({
      decision,expectedRunVersion:1
    }).success,true);
  }
  assert.equal(commanderTeamReviewSchema.safeParse({
    decision:"request_changes",expectedRunVersion:1
  }).success,false);
  const revised=commanderTeamReviewSchema.parse({
    decision:"request_changes",notes:"Fix accessibility issues",
    expectedRunVersion:4,acknowledgeUnreviewed:true
  });
  assert.equal(revised.acknowledgeUnreviewed,true);
  assert.equal(commanderTeamReviewSchema.safeParse({
    decision:"approve",expectedRunVersion:0
  }).success,false);
});

test("team rounds and frozen run limits have bounded peer and commander revisions",()=>{
  assert.equal(MAX_TEAM_TOTAL_ROUNDS,4);
  assert.equal(teamRunLimitsSchema.safeParse(DEFAULT_TEAM_MOCK_LIMITS).success,true);
  for(const field of ["maxRevisionRounds","maxCommanderRevisionRounds"] as const) {
    assert.equal(teamRunLimitsSchema.safeParse({
      ...DEFAULT_TEAM_MOCK_LIMITS,[field]:3
    }).success,false);
  }
  assert.equal(teamRunLimitsSchema.safeParse({
    ...DEFAULT_TEAM_MOCK_LIMITS,maxSteps:100
  }).success,false);
});

test("model output extra keys are stripped but required plan keys stay validated",()=>{
  const plan=teamPlanOutputSchema.parse({
    summary:"Build website", notes:"harmless extra",
    subtasks:[
      {participantNpcId:"john",instruction:"Draft content",extra:"strip"},
      {participantNpcId:"kyle",instruction:"Review content"}
    ]
  });
  assert.equal("notes" in plan,false);
  assert.equal("extra" in plan.subtasks[0],false);
  assert.equal(teamPlanUsesOnlyParticipants(plan,["john","kyle"]),true);
  assert.equal(teamPlanUsesOnlyParticipants(plan,["john"]),false);
  assert.equal(teamPlanOutputSchema.safeParse({
    summary:"Overflow",subtasks:Array.from({length:5},()=>({
      participantNpcId:"john",instruction:"Work"
    }))
  }).success,false);
});

test("review revisions target only listed team members",()=>{
  assert.equal(teamReviewOutputSchema.safeParse({
    verdict:"request_revision",summary:"Needs work",findings:["Missing contrast"]
  }).success,false);
  const review=teamReviewOutputSchema.parse({
    verdict:"request_revision",summary:"Needs work",findings:["Missing contrast"],
    extra:"ignored",
    revisions:[{participantNpcId:"john",instruction:"Improve accessibility",notes:"extra"}]
  });
  assert.equal("extra" in review,false);
  assert.equal(teamReviewUsesOnlyParticipants(review,["john","kyle"],"kyle"),true);
  assert.equal(teamReviewUsesOnlyParticipants(review,["kyle"],"kyle"),false);
  const selfDirected=teamReviewOutputSchema.parse({
    verdict:"request_revision",summary:"Retry",findings:["Clarify"],
    revisions:[{participantNpcId:"kyle",instruction:"Review my own work"}]
  });
  assert.equal(teamReviewUsesOnlyParticipants(selfDirected,["john","kyle"],"kyle"),false);
  assert.equal(teamReviewOutputSchema.safeParse({
    verdict:"accept",summary:"Approved",findings:[]
  }).success,true);
});

test("synthesis and persisted cost require valid bounded fields",()=>{
  const stripped=teamSynthesisOutputSchema.parse({
    summary:"Done",deliverable:"Work complete",unreviewed:false,gaps:["fake"]
  });
  assert.equal("unreviewed" in stripped,false);
  assert.equal("gaps" in stripped,false);
  assert.equal(teamSynthesisOutputSchema.safeParse({
    summary:"Done",deliverable:""
  }).success,false);
  const event={
    cursor:1,id:uuid(),missionId:uuid(),teamRunId:uuid(),
    stepId:null,attemptId:null,parentId:null,
    sequence:1,round:4,at:iso,kind:"commander_decision",
    from:{type:"commander"},to:[{type:"npc",npcId:"hal"}],
    text:"Approve",provenance:{mode:"mock",adapterId:"mock"},
    usage:{inputTokens:0,outputTokens:0,costMicros:0}
  };
  assert.equal(teamEventSchema.safeParse(event).success,true);
  assert.equal(teamEventSchema.safeParse({...event,attemptId:uuid()}).success,true);
  assert.equal(teamEventSchema.safeParse({
    ...event,usage:{costMicros:1.75}
  }).success,false);
  assert.equal(teamEventSchema.safeParse({...event,round:5}).success,false);
  assert.equal(teamEventSchema.safeParse({...event,text:"x".repeat(6001)}).success,false);
  assert.equal(teamActorSchema.safeParse({type:"commander",npcId:"hal"}).success,false);
});

test("new event input cannot forge sequence, cursor or timestamp",()=>{
  const source={
    missionId:uuid(),teamRunId:uuid(),stepId:null,attemptId:null,parentId:null,
    round:0,kind:"delegation",
    from:{type:"npc",npcId:"hal"},to:[{type:"npc",npcId:"john"}],
    text:"Please contribute",provenance:{mode:"mock",adapterId:"mock"},usage:null
  };
  assert.equal(newTeamEventSchema.safeParse(source).success,true);
  assert.equal(newTeamEventSchema.safeParse({...source,cursor:100}).success,false);
});

test("run record matches SQL NULLs and terminal end reasons",()=>{
  const record={
    id:uuid(),missionId:uuid(),clientRequestId:uuid(),
    state:"working",version:1,round:0,
    snapshot:{
      title:"Website",notes:"Brief",leadNpcId:"hal",
      participantNpcIds:["john","kyle"],limits:DEFAULT_TEAM_MOCK_LIMITS
    },
    mode:"mock",pausedFrom:null,endReason:null,unreviewed:false,
    activeExecutionMs:3000,startedAt:iso,updatedAt:iso,completedAt:null
  };
  assert.equal(teamRunRecordSchema.safeParse(record).success,true);
  assert.equal(teamRunRecordSchema.safeParse({
    ...record,state:"paused",pausedFrom:null
  }).success,false);
  assert.equal(teamRunRecordSchema.safeParse({
    ...record,state:"paused",pausedFrom:"working"
  }).success,true);
  assert.equal(teamRunRecordSchema.safeParse({
    ...record,state:"cancelled",completedAt:iso,endReason:"commander_rejected"
  }).success,true);
  assert.equal(teamRunRecordSchema.safeParse({
    ...record,state:"completed",completedAt:iso,endReason:null
  }).success,false);
});

test("step and attempt schemas tolerate nullable end time and usage",()=>{
  const stepId=uuid();
  assert.equal(teamStepRecordSchema.safeParse({
    id:stepId,runId:uuid(),npcId:"kyle",position:0,
    round:0,state:"running",createdAt:iso,updatedAt:iso
  }).success,true);
  assert.equal(teamStepAttemptRecordSchema.safeParse({
    id:uuid(),stepId,attemptNo:1,
    state:"running",startedAt:iso,endedAt:null,usage:null
  }).success,true);
});

test("mission record has revision and no unsafe cached active run pointer",()=>{
  const mission={
    id:uuid(),title:"Website",notes:"Local",
    assignedNpcId:"hal",leadNpcId:"hal",
    participantNpcIds:["john","kyle"],status:"planned",revision:1,
    createdAt:iso,updatedAt:iso
  };
  assert.equal(teamMissionRecordSchema.safeParse(mission).success,true);
  assert.equal(teamMissionRecordSchema.safeParse({
    ...mission,activeRunId:uuid()
  }).success,false);
  assert.equal(teamMissionRecordSchema.safeParse({
    ...mission,revision:0
  }).success,false);
  assert.equal(teamMissionRecordSchema.safeParse({
    ...mission,participantNpcIds:["john","john"]
  }).success,false);
});

test("team lead cannot also join its own participants in mission or run snapshot",()=>{
  const mission={
    id:uuid(),title:"Website",notes:"",assignedNpcId:"hal",
    leadNpcId:"hal",participantNpcIds:["john","kyle"],
    status:"planned",revision:1,createdAt:iso,updatedAt:iso
  };
  assert.equal(teamMissionRecordSchema.safeParse(mission).success,true);
  assert.equal(teamMissionRecordSchema.safeParse({
    ...mission,participantNpcIds:["hal","john"]
  }).success,false);
  const snapshot={title:"Website",notes:"",leadNpcId:"hal",
    participantNpcIds:["john","kyle"],limits:DEFAULT_TEAM_MOCK_LIMITS};
  assert.equal(teamRunSnapshotSchema.safeParse(snapshot).success,true);
  assert.equal(teamRunSnapshotSchema.safeParse({
    ...snapshot,participantNpcIds:["hal","kyle"]
  }).success,false);
});
