# Prototype 0.2 — The Living Corps

## Status
The first vertical slice is a **registry-driven multi-NPC headquarters**, not the final art pass. Product mode A2 (Headquarters Commander) and Option A (detailed Sims-like 2.5D) remain unchanged.

## NPC registry
- `packages/gateway/src/registry.ts` is the authority for `NpcId -> NpcDescriptor + optional ChatProvider`.
- `GET /api/npcs` returns all registered NPCs.
- Hal Jordan is the Corps leader and represents GPT / ChatGPT (OpenAI). John Stewart represents Gemini (Google). Both currently use independent local mock chats—neither provider API is connected.
- Kyle Rayner (Claude), Guy Gardner (fourth AI TBD), Sinestro (WhatsApp), and Kilowog (Discord) are visible but explicitly `unconfigured` and advertise no actions.
- An unconfigured NPC request to `POST /api/chat` is rejected (503), and unknown NPCs return 404.
- Conversation ownership remains enforced in the local gateway.
- Scene positions and temporary vector artwork live **only in the client** in `game.ts`, keyed by NpcId. A missing visual config gets a generic fallback.

## What works
- All six NPCs are selectable by clicking their characters or sidebar entries.
- Interaction menus are generated from server-advertised capabilities.
- Offline idle/wandering animation runs in Phaser and makes **zero external requests**.
- Hal is the default selected character, visually centered and mock-chat capable; John retains his own mock-chat and SSE streaming behavior.
- Unsupported characters clearly say their service is not connected.

## Not yet implemented
- Paid or free-tier AI provider API integrations.
- WhatsApp personal inbox or Discord account automation.
- Full Sims-quality artwork and consistent multi-angle walking sprite sheets.
- True pathfinding, collisions, furniture interactions, and saved NPC routes.

## Development boundary
Claude can extend `NpcRegistry` and provider adapters on the backend.
ChatGPT owns the Phaser client, character visuals, React UI, and their integration.
The shared protocol remains v1; no breaking changes needed.
