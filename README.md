# Green Lantern Corps — AI Workspace

An A2 (Headquarters Commander) isometric workspace prototype. Click an NPC, open a menu, and chat through a local gateway. The first release has **no paid APIs** and does not send messages to WhatsApp or Discord.

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
