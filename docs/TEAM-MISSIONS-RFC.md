# RFC: Collaborative Lantern Missions — Prototype 0.4

Status: **revised design proposal, pending product-owner decisions and Claude contract review**.
This RFC changes **no executable behavior**. Product requirement: [issue #6](https://github.com/kojiiro/workspace/issues/6).
Revised following Claude's six-part review of PR #7.

## Product goal

One shared mission, multiple cooperating AI teammates, one human commander. The NPCs are **not** six separate chatbot windows.

| Character | Provider association | Responsibility |
|---|---|---|
| Hal Jordan | GPT / ChatGPT (OpenAI) | Mission leader, planning, delegation, synthesis |
| John Stewart | Gemini (Google) | Teammate, research, contributions, alternate solutions |
| Kyle Rayner | Claude (Anthropic) | Teammate, independent review, contributions |
| Guy Gardner | Fourth AI, not selected | Future |
| Sinestro | WhatsApp | Future permissioned communications |
| Kilowog | Discord | Future permissioned communications |

A2 Commander remains the game mode. The Phaser world visualizes activity; the **gateway is the authority** for missions, providers, run state, events, and external actions.

**The first milestone is an unmistakably labelled local simulation, not actual GPT/Gemini/Claude collaboration.** Every team message and final report displays: **"Local simulation. No AI model was consulted."** No external model calls or messaging occur.

## Decision proposals — product owner

Before the storage implementation, confirm these defaults (recommended by Claude and ChatGPT):

1. **Use SQLite now** instead of growing the JSON v1 Mission Board into multiple JSON files. Import existing missions safely, test on the user's Windows laptop, and never lose prior mission records.
2. **Delete cascade:** after a clear confirmation that the discussion transcript will also be deleted, deleting a mission removes its runs/events. Deletion is blocked while it has an active run.
3. **Final commander review:** allow **Approve**, **Request changes**, or **Reject**; approval of a deliverable is *not* permission to edit files or send messages.

These are proposals, **not** silently granted approval. No implementation involving destructive migration or deletion changes proceeds before product-owner acceptance.

## 1. Distinct mission, team run, and step lifecycles

### Mission — coarse persistent record

Retain the user's Mission Board statuses: `planned | in_progress | completed`. Add `activeRunId: TeamRunId | null` when a run exists. A failed or cancelled **run does not change the mission to failed**; the commander can retry. The mission has a content `revision` independent of run progress.

A mission can have many historical runs but at most **one active** run at a time.

### Team run — explicit state machine

```
queued -> planning -> working -> reviewing -> awaiting_commander_review -> completed
                                     |                  |
                                     v                  | request changes (within limit)
                                   revising <-----------+
                                     |
                                     +-> reviewing

queued/planning/working/reviewing/revising/awaiting_commander_review
    -> paused (restart; human Resume required)
    -> cancelling (requested by human) -> cancelled
    -> failed (unrecoverable leader/infrastructure failure)

awaiting_commander_review --Approve--> completed
awaiting_commander_review --Request changes--> revising (bounded)
awaiting_commander_review --Reject--> cancelled, reason=commander_rejected
```

`queued, planning, working, reviewing, revising, awaiting_commander_review, paused, cancelling` count as *active* for the single-active-run constraint. `completed, cancelled, failed` are terminal with **no outgoing transitions**. Store the exact legal transition table in code and test forbidden/terminal transitions.

The run has its own version and bounded, immutable-at-start configuration. It snapshots the mission's title, notes, lead/participants, permitted context and limits; editing mission content during a run does **not** rewrite its instructions.

### Step — one collaborator's work attempt

Each step has a state `pending | running | succeeded | failed | skipped | discarded`, a stable step ID and distinct attempt IDs. Keep retry history and failures, with one recorded completed-step event. The orchestrator must commit **step state + run transition + durable event in one SQLite transaction**.

### Offline providers and partial results

- Hal (lead) unavailable: run fails clearly. Do not silently substitute another model.
- John unavailable: mark his step skipped/failed, continue with available contributors; Hal's synthesis explicitly notes the gap.
- Kyle unavailable: allow a clearly marked **unreviewed** deliverable; commander must explicitly acknowledge the missing review before approving.
- A malformed plan or repeated revision limit: fail the affected step/run safely or return to commander review with a `limit_reached` event, without fabricated AI work.

### Restarts and resumability

At gateway startup, any non-terminal run becomes `paused` with reason `gateway_restarted` and the prior state saved. **Never automatically resume**, including when the real providers are enabled. The commander clicks Resume; any interrupted step reruns as a **new attempt**. Previously persisted events remain. Distinct `clientRequestId` values support intentional retries without duplicate starts.

### Cancellation and final review

Cancellation is a request, not an instant disappearance: `cancelling` aborts in-flight provider calls via `AbortSignal`, then transitions to `cancelled`. Cancelling a terminal run returns its current state (idempotent). Cancellation also works during commander review.

Every async attempt carries an attempt ID and expected run state/version. Any result arriving late after cancellation, pause or a newer attempt is **fenced**: do not append its response text or advance the run. Record a safe `discarded` metadata event where appropriate. Usage from an aborted call is still recorded because future live providers can bill for partial work.

## 2. SQLite as the single persistence authority

**Preferred proposal:** `better-sqlite3` in WAL mode, subject to an actual **Windows + Ubuntu CI install, build, crash/restart and concurrency validation**. Current engines are compatible with Node 22.12+; evaluate any version-specific dependency/Node support before pinning. The prior `node:sqlite` alternative is not assumed available across the current supported Node range.

`MissionRepository` provides `list/get/create/update/delete` and revision-aware methods. The same SQLite database owns:
- `missions` (coarse fields, `revision`, `active_run_id`, lead and participants)
- `team_runs` (state, version, snapshot, explicit limits, idempotency request ID)
- `team_steps` (step and attempt IDs, outcome and provenance)
- `team_events` (append-only, durable global integer cursor, per-run sequence)
- `rejected_records` (invalid legacy records keyed by content digest)
- migration bookkeeping and future action approvals

Required constraints / transactional invariants:
- Partial unique index limits each mission to one active run; a double click is idempotent or returns a conflict.
- `UPDATE ... WHERE revision = ?` ensures stale mission content edits change **zero** rows; stale clients see HTTP 409 and the current mission.
- **Mission revision** increments on title/notes/participants/coarse-status changes, **not** every team-run step or token. Run progress increments its own version.
- Unique `(run_id, sequence)`, append-only event trigger, foreign keys/cascade for approved deletion, and a durable auto-increment event cursor.
- A step state, run status transition and associated persistent event are written atomically. A crash cannot commit only half of the truth.

### Existing JSON migration (one-time, conservative)

1. Keep `data/missions.json` untouched during validation and database import.
2. Accept the existing `schemaVersion: 1` envelope and legacy bare arrays; validate every mission using the current strict schema.
3. Import valid missions in **one transaction**; put invalid records in `rejected_records` keyed by content hash (avoid repeated rejected sidecars).
4. Persist a migration marker, verify counts/digests, and only then rename the old JSON file to `.migrated` or preserve it as a verified backup. If rename fails, the marker prevents reimport.
5. Unknown newer JSON versions or an invalid outer envelope **fail closed** rather than dropping source data. Migration is recoverable/retryable.
6. Test rollback/restarts/locked files on Windows and Ubuntu. Document backup/restore and eventual SQLite export.

This is a planned storage migration; don't replace the stable v0.3 storage in PR #7 (which is **documentation only**).

## 3. Concurrency, commander's edits and mission deletion

`PATCH /api/missions/:id` and `DELETE /api/missions/:id` require the mission's current revision in an `If-Match` header (for example `If-Match: "5"`). A stale revision returns **409** with the current mission for reconciliation; the UI does not overwrite automatically. Document behavior for absent or malformed preconditions.

Mission deletion:
- Refuse if an active run exists, including paused or awaiting review.
- After explicit confirmation that all runs and team transcripts will be lost, cascade-delete corresponding rows transactionally.
- Preserve the current user's ability to edit the Mission Board while the run works from its immutable start snapshot.

## 4. Provider abstraction and structured work

**Reuse the existing `ChatProvider` interface** for mock, OpenAI, Gemini and Anthropic. Do not add a separate `AgentAdapter` registry. The `TeamOrchestrator` owns role prompts, relevant context assembly, routing, parsing and state transitions.

- Hal's plan and Kyle's review use **Zod-validated structured outputs**; assign only to a participant already recorded on the mission and cap subtasks.
- A mock scenario passes through the **same validation and orchestration path** as a real provider, not special UI-only animation.
- Required deterministic mock scenarios: happy path, request changes, John offline, Kyle offline, Hal offline, malformed plan, slow response, oversized output, cancellation/restart.
- Provider identity, availability and model come from server-side configuration and health checks; characters' UI labels never imply a connected service.
- All model output—including Hal's plan—is untrusted data and cannot grant permissions, alter participants, raise limits, or bypass approvals.

## 5. Durable team event model, streaming and UI

Existing `RunId` / `run.*` refer to chat sessions. Team workflows use a distinct **`TeamRunId`** and **`team.*` SSE event family**.

```ts
type TeamActor =
  | { type: "commander" }
  | { type: "npc"; npcId: NpcId }
  | { type: "system" };

type TeamEvent = {
  cursor: number;                // durable, increasing across gateway restarts
  id: string;
  missionId: string;
  teamRunId: TeamRunId;
  stepId?: string;
  parentId?: string;
  sequence: number;              // unique within teamRunId
  round: number;
  at: string;
  kind:
    | "plan" | "delegation" | "contribution" | "review"
    | "revision_request" | "synthesis" | "approval_request"
    | "status" | "error" | "cancelled" | "paused"
    | "resumed" | "limit_reached" | "discarded";
  from: TeamActor;
  to: TeamActor[];
  text: string;
  provenance: {
    mode: "mock" | "live";
    adapterId: string;
    model?: string;
  };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
};
```

Persist **one event per completed step**, not one event per token. Transient streaming deltas remain in the existing live SSE channel and do not fill SQLite.

Expose history with `GET .../events?after=<cursor>` and publish `team.*` notifications on the existing SSE stream. Client opens the stream **first**, buffers arriving events, fetches history, then de-duplicates by durable cursor. Validate that the team run belongs to the mission in the URL on every route. Render model output **as plain text only**: no automatically rendered links/images or raw HTML.

Every message shows sender, recipient, step/round, mock/live provenance and timestamp. **Game animation follows recorded events; it does not create them.**

## 6. Security and spending boundaries

- Only the server chooses mission participants, `ChatProvider` configuration, provenance, allowed model, and simulated flag. A browser cannot assert `simulated:false`, choose a hidden provider, or supply keys.
- `POST /api/missions/:id/team-runs` accepts strict validated metadata (such as `clientRequestId` and mission precondition), **not** participant/provider lists supplied by the browser. New starts return 202.
- No paid providers or outbound integrations run in 0.4. Mock network tests actively block `fetch` and non-loopback sockets, rather than trusting the word "mock".
- Treat mission notes, uploaded files and all assistant messages as untrusted data; isolate task context and do not allow model text to direct tools or authorization.
- Enforce per-run bounds. Suggested mock defaults (Claude proposal): **12 steps; 2 revision rounds; 4 subtasks; 6,000 characters/event; 120 events/run; 20-second step timeout; 5-minute run timeout; 1 active run/mission; 2 active runs globally**. Freeze limits into the run record on creation.
- Future live providers are opt-in and require configured keys, health checks, user-selected budgets and per-provider limits. Record token usage (including aborts), do not log transcript text, and redact secrets.
- External side effects (filesystem, repo actions, WhatsApp, Discord) always need separate **exact-payload, target-specific, expiring user approval**. A commander's approval of a *deliverable* does not approve a tool call.

## API proposal (implementation details to be frozen in contract PR)

- `POST /api/missions/:id/team-runs` — start one server-authorized mock run, idempotent by `clientRequestId`, 202.
- `GET /api/missions/:id/team-runs/:teamRunId` — run state, version, snapshot summary and active review.
- `GET /api/missions/:id/team-runs/:teamRunId/events?after=<cursor>` — replay durable transcript.
- `POST /api/missions/:id/team-runs/:teamRunId/cancel` — idempotent cancellation.
- `POST /api/missions/:id/team-runs/:teamRunId/resume` — explicit resumption of paused run.
- `POST /api/missions/:id/team-runs/:teamRunId/review` — approve/request-changes/reject (no external tool authorization).

All routes use loopback Host/Origin allowlists, schema validation, mission/run association and output caps. Stale mission edits use `If-Match`; the exact response contracts belong in the contract PR.

## Acceptance tests

1. Start a team **simulation** from a saved mission. Hal delegates, John contributes, Kyle reviews, Hal synthesizes, and all messages explicitly state no model was consulted.
2. Each handoff displays clear sender and recipients with live transcript replay; client doesn't lose events across reconnect.
3. A review can request bounded revisions, approve or reject.
4. Missing John skips his step, missing Kyle flags the result unreviewed, missing Hal fails fast.
5. Restart leaves an in-progress run **paused**, never auto-resumes; commander must resume and interrupted step starts as a new attempt.
6. Cancel races cannot append late provider outputs; cancellation is idempotent even during final review.
7. State and transcript remain consistent across crashes; aborted-call usage is recorded.
8. Double-click starts only one active team run; stale mission edits and deletes return 409.
9. Mock runs create **no network traffic to non-loopback hosts** and no real AI charges.
10. Deleting a finished mission displays a warning that its discussion history is also deleted and requires confirmation.

## Implementation sequence and ownership

**Do not code the orchestrator against an unreviewed contract.**

1. **Contract PR — Claude drafts for review:** shared types, Zod schemas, transition table, SQLite schema, `If-Match` rules, migration plan. ChatGPT reviews; a protocol version bump and compatibility rules are agreed before behavior changes.
2. **PR A — storage:** SQLite repository, import/migration, revision matching, transaction boundaries and tests on Windows/Ubuntu. ChatGPT updates React Mission Board for stale-edit conflicts.
3. **PR B — orchestrator:** bounded mock scenarios, state transitions, restart recovery, cancellation attempt fencing, persistence and SSE endpoints. Run/test against offline and failure scenarios.
4. **PR C — ChatGPT:** Team Discussion panel, transcript cursor replay, user review/resume/cancel controls.
5. **PR D — ChatGPT:** visual NPC coordination and animations in Phaser, purely driven by recorded events.
6. After project-owner browser acceptance and Claude code review, consider live GPT/Gemini/Claude providers **one by one**, with explicit API costs, budgets and permissions.

This RFC records design decisions to review. No character has gained real-model access, no scheduled/background action is enabled, and no mission is executed automatically.
