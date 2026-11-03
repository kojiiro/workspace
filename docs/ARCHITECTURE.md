# Green Lantern Corps Workspace — Architecture v1

Status: Phase 1 vertical slice. Product mode **A2: Headquarters Commander**.

## Core idea
The user's browser displays an isometric Green Lantern headquarters. NPC simulation runs only in Phaser and must never make LLM calls on its own. Clicking an NPC triggers a React menu driven by the NPC's declared capabilities.

## Technology
- TypeScript monorepo with npm workspaces.
- React for menus and chat; Phaser 3.90 for the game world.
- Vite frontend dev server, Fastify backend bound to 127.0.0.1.
- POST /api/chat starts a run. GET /api/events carries server events using SSE.
- Local mock provider is the default and requires no credentials.
- SQLite and real provider adapters are phase 2, not falsely represented as complete.

## Packages
- packages/shared: PROTOCOL_VERSION=1, Zod chat request validation, event and provider contracts.
- packages/client: React component state, Phaser scene and NPC simulation.
- packages/gateway: HTTP routes, SSE event history, mock adapter and request validation.

## Invariants
1. Browser never receives provider secrets.
2. No call to an AI model is made merely to animate NPCs.
3. Sending external messages requires explicit human approval.
4. The browser does not impersonate a Discord user or automate WhatsApp personal sessions.
5. Bind gateway to loopback; Vite proxies /api to gateway. Requests are schema-validated.
6. An unsupported NPC capability is not rendered as an active action.
7. Backwards-incompatible changes bump PROTOCOL_VERSION and update docs/decisions.md.

## Phase 1 API
- GET /api/health -> GatewayHealth
- GET /api/npcs -> NpcDescriptor[]
- POST /api/chat -> 202 SendChatResponse; schema = sendChatRequestSchema
- GET /api/events -> SSE EventEnvelope; replay via Last-Event-ID
- POST /api/runs/:runId/cancel -> 204
- GET /api/conversations/:id/messages -> ChatMessage[]

## Error handling
Errors return { error: GatewayError }. The mock provider supports a /fail rate_limited test and cancellable responses. Each run has a timeout and a concurrency limit. Responses are intentionally limited to a short canned reply.

## Roadmap
1. Mock vertical slice (this branch).
2. SQLite persistence, production tests, provider selector, real Gemini or Ollama adapter.
3. Multiple NPCs and commissioned character sprites.
4. Discord bot integration with channel permissions.
5. WhatsApp official reply composer only.
6. Game-world polish, save/load, audio and missions.
