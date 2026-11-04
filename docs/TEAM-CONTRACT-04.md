# Prototype 0.4 — Team-Mission Contract Draft

**Status:** candidate contract for Claude's independent review. No executable team
orchestration exists in this PR. The live chat protocol is still v1, and
`PROTOCOL_VERSION` is deliberately unchanged pending contract freeze.

**Architecture reference:** [Team Missions RFC](TEAM-MISSIONS-RFC.md) (PR #7).
**Product requirement:** [issue #6](https://github.com/kojiiro/workspace/issues/6).

## Owner-approved decisions (2026-11-04)

1. **SQLite now**, with transactional import from the existing JSON Mission Board
   and a verified backup. Never delete/overwrite original records during migration.
2. **Cascade history deletion** only after an explicit warning naming the loss of
   team discussions; block deletion while any active run exists. Approval of
   deletion in the product spec is *not* per-mission authorization.
3. **Three commander review choices:** Approve, Request changes, Reject. These
   review a deliverable only, and never authorize file writes or outgoing messages.

## Change boundary

`packages/shared/src/team-contract.ts` exports **draft** types, strict Zod
validators, the proposed finite-state transition table and a helper.
`docs/sqlite-team-schema.sql` is a **design artifact**, not a live migration.
There are no new routes, dependencies, database files, providers, or operations.

Merge/freeze this only after Claude reviews the exact contracts and confirms
which changes warrant a `PROTOCOL_VERSION` bump to 2. Existing v1 chat and
Mission Board APIs remain functional until the storage PR implements a controlled
migration and client updates.

## 1. Records and roles

Three different entity lifecycles MUST stay distinct:

- **Mission**: title, notes, `planned | in_progress | completed`, lead
  (Hal/GPT), participants (John/Gemini, Kyle/Claude), `revision`, and optional
  `activeRunId`. One mission may have many historical team runs.
- **TeamRun**: a single bounded execution of a *snapshot* of a mission,
  `version`, `clientRequestId`, immutable limits, paused-from state, mode
  (mock/live), and run state. Only one active run per mission.
- **TeamStep / Attempt**: one collaborator's assigned piece and each attempt to
  complete it. Restart/resume creates a new attempt ID; late responses cannot
  overwrite a later attempt.

For a run, explicit states are:

```
queued -> planning -> working -> reviewing -> awaiting_commander_review -> completed
                                |                                  |
                                +-> revising <- request_changes --+
                                      |
                                      +-> working -> reviewing
active state -> paused (gateway restart; never auto-resume)
active state -> cancelling -> cancelled
active state -> failed
```

`completed | cancelled | failed` are terminal. Paused runs can resume only to
their **persisted interrupted state** and only after an explicit commander
interaction. A cancelled/failed run does not erase its mission or prior events.

- Hal offline: stop with an explicit failed outcome.
- John offline: preserve mission and run, mark his step skipped and report it.
- Kyle offline: mark the result **unreviewed**; commander must acknowledge
  review was unavailable before approval.
- Final review decisions: approve = completed; request_changes = new bounded
  revision round; reject = cancelled (reason `commander_rejected`).
- Request changes beyond the limit yields a clear `limit_reached` outcome,
  not an unbounded cycle.

`TEAM_RUN_TRANSITIONS` is the candidate transition table. The orchestrator
must enforce the table in the same transaction that updates the run and appends
its event; no UI code can advance states on its own.

## 2. SQLite contract

See [the proposed SQL](sqlite-team-schema.sql). An implementation should use
a reviewed `better-sqlite3` version in WAL mode with `foreign_keys=ON`,
durable transactions, and all migration/concurrency tests on Windows and Ubuntu.

Minimum invariants:
- A partial unique index allows at most one active run per mission.
- Mission content/coarse status uses revision increments. Run progress uses its
  independent version; streaming deltas do **not** bump mission revision.
- `UPDATE missions SET ... revision=revision+1 WHERE id=? AND revision=?`
  must report zero affected rows for stale edits.
- Each step's status, run transition and completed-step event are written in
  **one transaction**.
- `(run_id, sequence)` is unique; team-event `cursor` is a globally increasing
  SQLite `AUTOINCREMENT` primary key. Events remain ordered across restarts.
- Team events are append-only through normal APIs. Deleting a confirmed
  finished mission may cascade-delete its transcripts; authorization and
  deletion happen in the same transaction. Review the supplied SQL triggers
  and cascade order carefully before execution.
- Public data paths are under gitignored `data/`. Never commit projects,
  transcripts, SQLite databases, backups or API credentials.

### Existing JSON migration (safe, exactly once)

1. Detect `data/missions.json`; **do not overwrite it**. Start with a
   validated backup and database transaction.
2. Validate outer file: either existing `schemaVersion:1` envelope or legacy
   bare array. Unsupported newer version or malformed envelope fails closed.
3. Validate each v1 mission; preserve invalid records in SQLite
   `rejected_records`, keyed by a content hash, not repeating sidecars.
4. Insert valid mission IDs, titles, notes, assignee and times. Default
   `leadNpcId="hal"`, `revision=1`, no active run, and explicit initial
   participants, without inventing historical AI runs.
5. Commit imported rows and a migration marker in **one transaction**. Verify
   source digest and row counts. Only then archive JSON to `.migrated` or a
   verified backup. If renaming fails, do not reimport on restart.
6. On restart, verify marker and rollback/repair safely; never delete the
   original until the owner has a recoverable copy and the import is verified.

### Concurrent edits and deletion

- `PATCH /api/missions/:id` and `DELETE /api/missions/:id` require
  `If-Match: "5"`, where 5 is the current mission revision.
- Missing precondition: HTTP **428**; malformed header: **400**; stale revision:
  HTTP **409** with a typed error and the latest mission representation.
- A mission with an active run cannot be deleted (409), including when paused
  or awaiting commander review.
- A confirmed deletion asks whether to permanently remove the mission **and
  all prior team discussion history**. Deletion is scoped to that mission,
  transactional, and not automatically implied by a deliverable approval.

## 3. Team event / API contract

All character-to-character messages are persisted as **data**, not model
instructions. An event contains a durable cursor and unique within-run
sequence, run/mission/step IDs, round, sender/recipient actors, event kind,
timestamp, plain-text message, and server-set provenance/usage. It does not
contain or expose internal model reasoning.

`from` and `to` use the discriminated `TeamActor` union:
`{type:"commander"} | {type:"system"} | {type:"npc",npcId}`.

The gateway publishes a new `team.event` notification on the existing SSE
connection, separate from current chat `run.*` events. Each notification
identifies a durable `cursor`, not an unbounded transcript. The client:
1. opens the SSE stream, buffering incoming `team.*` notifications,
2. fetches `GET .../events?after=<cursor>`,
3. merges and de-duplicates events by cursor,
4. advances its saved cursor; after reconnect, repeats from the last cursor.

Persist only completed step and meaningful state-transition events. Token
deltas are temporary and **not** stored one row per token.

### Proposed routes, NOT implemented yet

| Method | Route | Contract |
|---|---|---|
| POST | `/api/missions/:id/team-runs` | Starts server-owned team run; body strictly `{clientRequestId}`, idempotent; 202 |
| GET | `/api/missions/:id/team-runs/:teamRunId` | State, version, review and snapshot |
| GET | `/api/missions/:id/team-runs/:teamRunId/events?after=...` | Durable ordered transcript |
| POST | `/api/missions/:id/team-runs/:teamRunId/cancel` | Idempotent cancel, including during review |
| POST | `/api/missions/:id/team-runs/:teamRunId/resume` | Explicit resume of paused run |
| POST | `/api/missions/:id/team-runs/:teamRunId/review` | `approve/request_changes/reject`; no tool authorization |

The gateway checks run-to-mission ownership on every request, applies current
localhost Host/Origin protections, validates all request and response data, and
never lets the browser supply agent identities, providers, simulated/live flags,
keys, or budget ceilings.

## 4. Provider, budget, and security rules

- **Reuse existing `ChatProvider`**, including Hal, John and Kyle, not a
  second parallel `AgentAdapter` registry.
- Start with deterministic **mock providers** that nevertheless pass through
  the same Zod plan/review validation and state machine as real providers.
- Include happy path, revision, offline John, offline Kyle, unavailable Hal,
  malformed plan, slow/overlong output, restart and cancellation cases.
- Every message and final report clearly says:
  **"Local simulation. No AI model was consulted."**
- Proposed immutable mock caps: 12 steps, 2 revision rounds, 4 subtasks,
  6,000 characters/event, 120 events/run, 20s/step, 5 min/run, at most one
  active run/mission and two concurrent runs across the gateway. Lower limits
  are allowed; model-supplied outputs can never raise limits.
- Later live providers are opt-in, with explicit configuration, health checks,
  cost budgets and per-provider limits; aborted calls may still have billable
  usage to record. The prototype defaults to **zero external API calls**.
- User mission notes, received documents, other model responses and Hal's
  plan are **untrusted data**, not instructions authorizing tools.
- Use typed errors, redact secrets from logs and do not log transcript text.
  Render model output as plain text; no auto-loaded links or images.
- Outbound messages, repository/file edits or deletion actions require separate
  explicit, target-specific, expiring approval. Approval of a result is not
  consent to a side effect.

## 5. Contract acceptance / division of work

**Contract review — Claude:** check schema fields, SQL constraints and the
cascade-delete trigger, step-attempt fencing, restart transitions, HTTP codes,
If-Match conflict responses and migration rollback. Propose amendments before
protocol v2 is enabled. This PR is intentionally reviewable without a live
database or provider calls.

**Storage PR — Claude/backend, ChatGPT/client:** build and test SQLite and a
`MissionRepository` interface (`list/get/create/update/delete`), copy JSON
missions safely, update UI conflict handling, validate Windows and Ubuntu.

**Orchestrator PR — Claude/backend:** implement bounded mocked team runs,
attempt-fenced cancellation, restart pause/recovery, Zod plan/review parsing,
and event replay. Verify no remote network access in mock mode.

**Team Discussion PR — ChatGPT/frontend:** render participants, shared
transcript, provenance disclaimer, resume/review/cancel controls, and safe
cursor replay. **Phaser visuals PR — ChatGPT:** NPC reactions based only on
persisted team events.

**Frozen contract is a prerequisite:** no live GPT/Gemini/Claude adapters until
these boundaries, review workflows and budgets have working tests.
