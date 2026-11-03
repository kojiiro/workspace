# Architectural decisions

## D-001 — 2026-11-03
Choose TypeScript (not Laravel) for Phaser/React and gateway shared types. Laravel is not needed for the MVP.

## D-002 — 2026-11-03
Choose A2 Headquarters Commander: no required player avatar movement. Clicking an NPC opens React controls.

## D-003 — 2026-11-03
Choose HTTP + SSE over WebSockets for the first prototype. Run creation uses POST; a separate GET SSE connection streams events. Can revisit when bidirectional features demand it.

## D-004 — 2026-11-03
Freeze the Phase 1 contract as PROTOCOL_VERSION=1, derived from Claude's shared TypeScript proposal. The client owns animation; the gateway owns provider calls.

## D-005 — 2026-11-03
Use mock responses and generated placeholder visuals in v0.1. No API keys, paid services, unauthorized messaging, or IP assets in the repository.

## D-006 — 2026-11-03
Keep all changes in a feature branch and request review via pull request. Do not write to main until reviewed.
