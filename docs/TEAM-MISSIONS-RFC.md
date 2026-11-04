# RFC: Collaborative Lantern Missions (Prototype 0.4)

Status: **design proposal for independent Claude review**. This document does not enable real AI calls or automatically run missions. Product requirement: [issue #6](https://github.com/kojiiro/workspace/issues/6).

## Core product rule
One shared mission; multiple cooperating agents; one human commander. The NPCs are **not** isolated chat windows.

- **Hal Jordan** = GPT / ChatGPT (OpenAI), **mission leader** and planner/coordinator.
- **John Stewart** = Gemini (Google), contributing teammate and alternative reviewer.
- **Kyle Rayner** = Claude (Anthropic), contributing teammate and independent reviewer.
- Guy Gardner: fourth AI undecided. Sinestro: WhatsApp. Kilowog: Discord; messaging requires user approval.
- The game remains A2 Commander with a fixed camera and clickable NPCs. The world displays activity, but **the backend makes all decisions about real actions**.

## Prototype 0.4 scope

Build a **clearly labelled local simulated team mission** first. It is an interactive demonstration of orchestration, not a claim that GPT, Gemini, or Claude were actually contacted.

1. Commander opens a saved Mission Board item and chooses **Start team simulation**.
2. Hal prepares a structured plan and delegates to John and Kyle.
3. John contributes a draft or an alternative; Kyle reviews and returns feedback.
4. Hal synthesizes a final report for the commander.
5. A Team Discussion panel shows messages with **sender → recipient**, status, timestamps, and links to the mission, preserving a log after a gateway restart.
6. The commander can cancel; all steps have bounded iterations and are honest about mock/simulation mode.

No real API keys, remote calls, file modifications, or sending messages in 0.4.

## Orchestration model
Make the backend an explicit finite-state machine, not a free-form recursive "agents talk forever" loop:

```
PLANNED --user starts--> PLANNING
PLANNING --Hal delegates--> CONTRIBUTING
CONTRIBUTING --John & Kyle replies--> REVIEWING
REVIEWING --Kyle requests revisions?--> REVISING (bounded)
REVIEWING / REVISING --Hal synthesizes--> AWAITING_APPROVAL
AWAITING_APPROVAL --user approves--> COMPLETED
any running step --user cancels--> CANCELLED
any failure --> FAILED (with partial logs retained)
```

The human controls whether work begins, and reviews final deliverables. Later, tool writes / messages require additional **action-specific approvals**, not blanket mission approval.

### Backend boundaries
- `MissionRepository`: `list/get/create/update/delete`, plus transactional mission events and revision checking. JSON file v1 is existing; introduce versioned migration to v2 and revision numbers **before orchestration writes**.
- `TeamOrchestrator`: accepts only a validated mission ID, participants and user-approved budget/settings. Owns run state, scheduling and cancellation. Is independent of React/Phaser.
- `AgentAdapter`: one adapter per supported provider (mock, OpenAI, Gemini, Anthropic), instantiated through explicit environment configuration. Never infer a working provider from NPC names.
- `TeamEventStore`: append-only event log per mission. Replays history to a newly opened team discussion panel after restart.
- `ActionApprovalService`: only for future external side effects (repo edits, filesystem changes, WhatsApp/Discord). Pending actions carry exact payload hashes/targets, creator, expiry and approver.

### Durable data
Proposed v2 mission shape extends the v1 Mission Board safely:
- `schemaVersion: 2` and a tested v1 → v2 migration; unknown newer versions remain unopened.
- `revision: integer >= 1` increments on every successful change; clients send `expectedRevision`, server returns 409 for stale edits.
- `leadNpcId: "hal"`, `participantNpcIds: ["john", "kyle"]`, `status` and `teamRunId?` in the mission record.
- Separate event records (mission ID, run ID, sequence, `senderNpcId | "commander"`, recipients, parent event ID, event kind, text, provider provenance, time, usage/cost metadata).
- Shared context is **a bounded per-task snapshot and compact summary**, not unlimited raw chat history. Preserve references to original artifacts.

Avoid storing every assistant's unbounded internal reasoning. Show actionable messages, drafts, critique and decisions. Never promise to expose hidden chain-of-thought.

### Shared message contract (proposal)
```ts
type TeamEvent = {
  id: string;
  missionId: string;
  runId: string;
  sequence: number;
  at: string;
  kind: "plan" | "delegation" | "contribution" | "review" |
        "revision_request" | "synthesis" | "approval_request" |
        "status" | "error";
  fromNpcId: string | "commander";
  toNpcIds: string[];
  text: string;
  adapterId: string | "system";
  simulated: boolean;
};
```
Structured server records drive the UI: bubbles, highlighted speakers, arrows between workstations, and a mission timeline. **Animation is decorative; events are the truth.**

### Provider architecture and safety
- First version: deterministic mock workers for Hal/John/Kyle; each message explicitly marked `simulated: true`.
- Later: real providers are **off by default**; require user's explicit setup and model selection. Advertise `ready` only after a successful health check.
- Require per-mission limits (steps, maximum delegations, output length, concurrency, elapsed time) and user-selected cost/budget caps before remote execution.
- Context passed between agents should contain mission goal and prior results relevant to their subtask; isolate provider credentials server-side.
- User-supplied content, documents, and all other AI replies are untrusted text, not instructions granting tool permissions.
- Unconfigured/offline teammates should show a visible limitation and recover or stop without fabricated contributions.
- External side effects always remain behind explicit user authorization. No unreviewed background outbound calls.

## API sketch (subject to Claude review)
- `POST /api/missions/:id/team-runs` — create a **mock** run after explicit user click; body lists participants, `mode:"mock"` and expected mission revision.
- `GET /api/missions/:id/team-runs/:runId` — status and summary.
- `GET /api/missions/:id/team-runs/:runId/events` — ordered transcript; future SSE cursor for streaming.
- `POST /api/missions/:id/team-runs/:runId/cancel` — stop idempotently.
- Future `POST /api/.../approvals/:id/decide` — scoped approval/denial.

Every route retains localhost Host and Origin validation, ID checks, mission ownership and strict schemas. Unknown fields are rejected. Do not allow the browser to supply provider keys or mark results `simulated:false`.

## UX acceptance tests
1. Start a demo team mission from a saved item. Hal, John and Kyle produce clearly **simulated** contributions in the Team Discussion panel.
2. Every handoff visibly shows source and recipient; no anonymous AI text.
3. A revision request returns to the correct contributor with bounded iterations.
4. Cancel stops future events; previously saved events remain after restart.
5. Restart the gateway and reopen the same mission to view the full transcript.
6. Disabled/unknown NPCs do not silently run remote providers. There is no external network call or token usage.
7. Stale updates return 409 instead of silently overwriting the commander's work.

## Implementation order
1. Agree on state machine, safe endpoints, repository interface and data migration with Claude.
2. Build revisioned storage and event log, with backend tests on Windows + Ubuntu.
3. Implement bounded mock orchestrator and provenance-tagged team events.
4. Add Team Discussion UI and subtle NPC-to-NPC visual activity in Phaser.
5. Do project-owner browser acceptance and Claude review; merge.
6. Only then evaluate real AI adapters and budget/approval system.

## Outstanding issue from PR #5
Repeated loads of unchanged invalid records can create repeated quarantine sidecars. This is separate maintenance work. Do not silently overwrite damaged source data before a recoverable, durable backup has been verified; prefer idempotent quarantine or atomic migration after the sidecar is secured.
