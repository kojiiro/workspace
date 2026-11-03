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
- `packages/shared` — frozen v1 protocol types and Zod request schema
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
On `feat/living-corps-npc-registry`, the game displays six selectable Corps members from a backend NPC registry and animates their idle/wandering routines locally. John is still mock-only; other apps/AIs are intentionally unconfigured.

To try this development version after cloning:
```powershell
git fetch origin
git switch feat/living-corps-npc-registry
npm ci
npm run dev
```
Read `docs/PROTOTYPE-02.md` for scope and ownership.
