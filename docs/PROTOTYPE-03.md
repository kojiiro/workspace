# Prototype 0.3 — Mission Control (first useful workspace feature)

## What this milestone adds
A persistent local Mission Board on top of the Prototype 0.2 six-character headquarters.

- Create missions with a title, notes and optional assigned Corps member.
- Change status between `planned`, `in_progress`, and `completed`.
- Delete missions only after the user confirms in the browser.
- Reopen saved missions after the backend is restarted.
- Work fully locally without AI API keys or any automatic messaging.

## Core distinction
**Assignment is only metadata in v0.3.** Selecting Hal or John does *not* silently call Gemini, ChatGPT, or any other remote service. The main reason for this phase is to give the game an actually useful planning feature.

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
