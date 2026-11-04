# Prototype 0.3 — Mission Control (first useful workspace feature)

## What this milestone adds
A persistent local Mission Board on top of the Prototype 0.2 six-character headquarters.

- Create missions with a title, notes and optional assigned Corps member.
- Change status between `planned`, `in_progress`, and `completed`.
- Delete missions only after the user confirms in the browser.
- Reopen saved missions after the backend is restarted.
- Work fully locally without AI API keys or any automatic messaging.

## Core distinction
**Assignment is only metadata in v0.3.** Hal is the GPT representative and leader, John represents Gemini, and Kyle represents Claude. Assigning anyone does *not* silently call ChatGPT, Gemini, Claude, or any other remote service. The main reason for this phase is to give the game an actually useful planning feature.

## Local API
- `GET /api/missions` — list
- `POST /api/missions` — create (validated title, notes, assignee)
- `PATCH /api/missions/:id` — update a mission's title, notes, assignee or status
- `DELETE /api/missions/:id` — delete

Every call uses the existing loopback Host and Origin validations.

## Storage and privacy
Data is saved in `data/missions.json` at the repository root. The `data/` folder is gitignored; do not commit personal projects or API credentials. Writes are serialized and use an atomic temporary-file rename to reduce corruption risk. This is a small single-user JSON store; a later SQLite migration is recommended for conversations, files and multi-table projects. The current repository is public.

No new npm dependencies are needed. No API usage fees are incurred.

## Local acceptance checks
1. Open Mission Board from the sidebar and create a mission assigned to Hal.
2. Change it to In progress, close and reopen the panel.
3. Restart the development servers and reload the page. Confirm the record remains.
4. Mark it Completed and then delete it using the confirmation dialog.
5. Verify Hal and John mock chats still work and game-world clicks are blocked while Mission Board is open.

## Collaboration
ChatGPT owns the Mission Board interface and initial persistence layer. Claude reviews security, persistence and API contracts before merge. Real AI provider integration and graphical sprite replacement remain separate milestones.

## Claude review hardening (2026-11-04)
- Persisted missions are individually validated against the shared strict `missionSchema`; invalid records are preserved in a separate `missions.rejected.json` file (or a uniquely suffixed sidecar if the first one already exists). Invalid records never enter the board's in-memory list.
- Invalid JSON, malformed envelopes and unknown schema versions **fail closed**. The original data file is not overwritten, and the next request can recover after manual repair.
- Mission files now use `{ "schemaVersion": 1, "missions": [...] }`. Legacy bare-array files are still accepted and migrate on the next successful create/update/delete.
- Each saved temporary file is flushed to disk before replacement. Replacement is retried briefly on temporary Windows `EPERM`, `EBUSY`, or `EACCES` locks.
- GitHub Actions builds and tests on both Windows and Ubuntu.
- Multi-process concurrent writes still require a future SQLite migration; the current single-gateway design serializes writes within one instance.
- **Do not intentionally corrupt real project data for browser testing without a backup.** Automated tests use isolated temporary directories.
