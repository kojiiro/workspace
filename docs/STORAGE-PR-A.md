# Storage PR A: SQLite mission database

Implements issue #10 on top of the frozen protocol v2 contract (PR #7, PR #9). No AI provider is called, no team run is executed, and no message is sent by this change.

## What changed

| Area | Change |
|---|---|
| Storage | `packages/gateway/src/storage/` replaces the JSON file store. `better-sqlite3` is pinned to `13.0.3`. Its Windows, macOS and Linux binaries ship inside the package, so there is no install-time download or compiler step. |
| Schema | `docs/sqlite-team-schema.sql` is the reviewed DDL. `npm run schema:sync` regenerates `storage/schema.generated.ts` from it, and a test fails if they differ. |
| Migration | Verified backup, then one all-or-nothing import transaction, then archive. See below. |
| API | Mission routes are revision-aware: `If-Match` on PATCH and DELETE, `ETag` on responses, 409 with the latest mission on conflict. |
| Shared | `Mission` gains `revision`, `leadNpcId`, `participantNpcIds`; `ErrorCode` gains `conflict` and `precondition_required`. Additive; `PROTOCOL_VERSION` stays 2. |
| CI | The 42 schema invariant checks now run on `better-sqlite3`, the production engine. |

## Install and Windows

`.npmrc` sets `ignore-scripts=true`. This is required, not cosmetic: `better-sqlite3` declares `"gypfile": false` and ships its binaries inside the package, but npm drops that flag when installing from a lockfile and then runs `node-gyp rebuild` anyway (reproduced with npm 10.9.7, the version bundled with Node 22). That compile fails on any PC without Visual Studio Build Tools and with no network access to nodejs.org, and it would also hide the problem on CI runners that do have a toolchain. With scripts disabled, plain `npm ci` and `npm install` load the bundled binary. The only other locked packages with install scripts are `esbuild` (an optional speed-up) and `fsevents` (optional, macOS); the client builds normally without them. `npm run check:native` (also run in CI after `npm ci`) fails if `.npmrc` loses the setting, if `better-sqlite3/build` exists (meaning it was compiled locally), or if the module cannot load. If a future dependency really needs a build step, run `npm rebuild <package>` explicitly.

## Data layout (all gitignored under `data/`, override with `GLC_DATA_DIR`)

```
data/headquarters.sqlite          the database (+ -wal and -shm while running)
data/backups/missions.v1-<UTC>-<sha12>.json     verified copy of the original missions.json
data/backups/headquarters-<UTC>.sqlite          verified database copies from npm run db:backup
data/missions.json.migrated       the original file, renamed only after a successful import
```

## Every connection

`openDatabase` sets and then **reads back**: `foreign_keys=1`, `recursive_triggers=1` (without it `INSERT OR REPLACE` could silently overwrite an event), `journal_mode=wal`, `synchronous=FULL`, and `busy_timeout`. A build that does not honour a setting refuses to start.

## First start with an existing missions.json

1. Parse and validate. A file that is empty, not JSON, has an unknown `schemaVersion`, or an unknown layout **stops startup with a message**; nothing is created or changed. A UTF-8 byte-order mark (common on Windows) is tolerated. Both the v1 envelope and the original bare array are accepted.
2. Write `data/backups/missions.v1-...json` with exclusive create, `fsync`, then re-read it and compare SHA-256. A backup that does not verify is deleted and the migration stops. Repeated attempts reuse an identical verified backup instead of piling up copies.
3. In **one** `IMMEDIATE` transaction: create the schema, seed `team_run_transitions` from `TEAM_RUN_TRANSITIONS`, insert each valid mission (same id, title, notes, assignee, status and timestamps; `revision` 1; lead `hal`; participants `john`, `kyle`), put invalid or duplicate records in `rejected_records` (keyed by content hash), write the `schema_migrations` marker (source and backup SHA-256, imported and rejected counts), re-read and compare every row, then COMMIT. Any failure rolls everything back.
4. Only after COMMIT, rename `missions.json` to `missions.json.migrated` (retried on `EPERM`/`EBUSY`/`EACCES`, which Windows antivirus and indexers cause). If the rename fails the import still stands; the next start finishes the archive.

On every later start the marker decides: the file is never imported again, even if it reappears or changes. A changed file is left untouched with a warning, because the database is authoritative.

### If something goes wrong

| Symptom | What it means | What to do |
|---|---|---|
| "missions.json is empty or is not valid JSON" | Fail-closed; nothing was changed | Repair the file, or restore from `data/backups/missions.v1-*.json` |
| "unknown layout or schema version" | The file is from a newer release | Update the application |
| "database file is damaged" | The `.sqlite` file is unreadable; it was not changed | Copy the newest `data/backups/headquarters-*.sqlite` to `data/headquarters.sqlite`, or delete the damaged database and put the original `missions.v1-*.json` backup back at `data/missions.json` to re-import |
| "created by a newer release" | Downgrade attempted | Run the newer release |
| Warning that a different missions.json exists | The database already holds your missions | Nothing; the file is ignored |

## Mission Board API (for the frontend)

| Request | Result |
|---|---|
| `GET /api/missions`, `GET /api/missions/:id` | Mission(s); the single form also sets `ETag: "<revision>"` |
| `POST /api/missions` | `201`, `ETag`, `Location`. Defaults: lead `hal`, participants `["john","kyle"]` |
| `PATCH /api/missions/:id` + `If-Match: "<revision>"` | `200` with the new mission and `ETag`. Body may change `title`, `notes`, `assignedNpcId`, `status`, `leadNpcId`, `participantNpcIds`. A change that alters nothing returns `200` without bumping the revision. |
| `DELETE /api/missions/:id` + `If-Match` | `204`, removing the mission, its participants and **all** of its team history |
| missing `If-Match` | `428` `precondition_required` |
| malformed `If-Match` (must be exactly one quoted number, e.g. `"3"`) | `400` `invalid_request` |
| stale revision | `409` `{ error:{code:"conflict"}, reason:"stale_revision", current:<Mission> }` |
| delete while a team run is active, paused, awaiting review or cancelling | `409` with `reason:"active_run"` and `current` |
| database busy (another process holds the write lock) | `503` `unavailable`, `retryable:true`. The gateway never retries silently and never discards an edit. |

The frontend must remember `revision` per mission, send it as `If-Match`, and on `409` keep the user's unsaved edits while offering **Reload current mission** (the body already contains `current`). The delete confirmation must say the mission's conversation history is deleted permanently. `Mission.assignedNpcId` is advisory after migration; participants come from `participantNpcIds`.

## Shutdown

`server.ts` closes the HTTP server and then SQLite on SIGINT and SIGTERM, which checkpoints the WAL and releases the files (verified: no `-wal` file remains). After a hard kill, SQLite recovers from the WAL on the next start (verified).

## Tests (all on real better-sqlite3, in temp folders)

`storage-database` (pragmas, atomic schema, parity, docs equals embedded DDL, REPLACE blocked, WAL-consistent backup), `storage-migration` (verified backup, bare array and BOM, quarantine, fail-closed, backup corruption, rollback before COMMIT, a real SIGKILL inside the transaction, archive failure and retry, no re-import, two gateways starting together, newer and damaged databases, 500 missions), `storage-repository` (revisions, atomic team edits, cascade delete scope, active-run block in every non-terminal state, two connections, busy database, corrupt rows), `storage-api` (If-Match matrix, 409 bodies, concurrent edits, restart persistence, 503, no leaked internals, Host/Origin protections). Ten deliberate code breakages were each caught by at least one test.

## Not in this PR (follow-ups)

- Mission Board revision UX (ChatGPT, issue #10 frontend list). **Until it lands, the existing board's edits and deletes receive `428`.** Merge the two together.
- Scheduled automatic database snapshots and backup retention (the command exists; nothing runs it automatically).
- The team-run orchestrator, event streaming and everything under `team_runs`.
