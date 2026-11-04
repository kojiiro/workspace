# Green Lantern Corps — AI Workspace

An A2 (Headquarters Commander) isometric workspace prototype. The next art milestone is **Option A: detailed Sims-like 2.5D**, with original artwork rather than pixel art. Click an NPC, open a menu, and chat through a local gateway. The first release has **no paid APIs** and does not send messages to WhatsApp or Discord.

## Requirements
- Windows 11, macOS, or Linux
- Node.js 22 LTS or newer
- Git and VS Code recommended (not required)

## Run locally
1. Clone this repository and check out `feat/headquarters-prototype-01`.
2. Open the project folder in VS Code (optional).
3. Open a terminal in the project folder.
4. Run `npm install`.
5. Run `npm run dev`.
6. Visit http://127.0.0.1:5173 .

The command launches the React/Phaser client and the Fastify mock gateway together. Stop them with Ctrl+C.

## What works in prototype 0.1
- A lightweight isometric room rendered with Phaser (placeholder geometry).
- An animated, clickable John Stewart NPC and commander camera controls.
- React interaction menu and chat panel.
- Local HTTP chat request and Server-Sent Events (SSE) response stream.
- A mock AI provider. No API key, model, hosting service, or database is required.

## What is NOT implemented yet
Real ChatGPT/Gemini/Claude connections, Discord, WhatsApp, persistence after gateway restart, and downloadable game assets. See `docs/ARCHITECTURE.md`.

## Structure
- `packages/shared` — protocol v2 shared types and Zod schemas; v1 chat routes remain compatible and team execution is not enabled
- `packages/client` — React menus + Phaser world
- `packages/gateway` — Fastify localhost gateway + mock provider
- `docs/` — architectural decisions and handoff notes

## Security and collaboration
The gateway binds to `127.0.0.1`. It rejects untrusted browser origins and validates requests. Never commit API keys, session cookies, Discord tokens, or personal messages. Keep work on feature branches and review PRs before merging.

## Browser smoke test before merging
1. Click John Stewart, open his chat, and type `wasd WASD arrows`; every character should enter the text box without panning the camera.
2. Send `hello` and verify that text streams into the chat panel.
3. Send `/fail` and confirm a friendly rate-limit error; you should be able to retry without a broken history.
4. Cancel a long reply; sending a new message should work.
5. Disconnect the gateway briefly and reconnect; the SSE connection should recover.

Run `npm test` for the gateway safety/concurrency tests.

## Prototype 0.2 development branch
The six Corps members are loaded from the backend NPC registry. Hal (GPT) leads, John (Gemini) assists, and both offer independent local mock chat. Kyle (Claude), Guy, Sinestro and Kilowog remain unconfigured.

To try this development version after cloning:
```powershell
git fetch origin
git switch feat/living-corps-npc-registry
npm ci
npm run dev
```
Read `docs/PROTOTYPE-02.md` for scope and ownership.

## Prototype 0.2: Hal Jordan leads the Corps
Hal Jordan is the primary character, centrally located and selected by default, representing **GPT / ChatGPT**. John Stewart represents **Gemini**, and Kyle Rayner represents **Claude**. Hal and John currently use separate local **mock** chats; neither model API is connected yet. Game-world pointer interactions are ignored while the chat/menu overlay is open. The blocked-switch notice remains until you dismiss it.

## Prototype 0.3 development: Mission Control
The `feat/mission-control-local-board` branch adds a Mission Board. Missions are saved locally under `data/missions.json` (ignored by Git). Assigned characters are labels for organization, **not automatic AI agents**. Use the regular `npm ci` and `npm run dev` commands, then open Mission Board from the sidebar. See `docs/PROTOTYPE-03.md`.

## Prototype 0.4 contract (protocol v2)
The reviewed team-mission contract is documented in `docs/TEAM-CONTRACT-04.md`; it adds the `team.event` event type and schema definitions without enabling AI team execution or changing the existing chat/Mission Board behavior. Data migration to SQLite and mock team collaboration will be implemented in later reviewed changes. Hal (GPT) leads, with John (Gemini) and Kyle (Claude) as the approved default teammates for imported missions.
