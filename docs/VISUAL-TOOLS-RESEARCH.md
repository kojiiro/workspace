# 2.5D visual tooling decision — research note (Prototype 0.4)

**Status:** exploration only. No frontend framework migration is approved.

## What we already use

- React + Vite for the local UI and Mission Board.
- Phaser for the interactive isometric game scene and NPC click targets.
- A local Fastify gateway for mock providers, durable mission data and later orchestration.

Keeping the existing Phaser rendering loop avoids disrupting the working
headquarters, chat, and mission UI while backend collaboration is developed.

## Next.js versus 2.5D asset production

**Next.js** is a React-based web application framework. It can host pages and
3D views but does **not** create character models or isometric sprite animations.
Moving from Vite to Next.js solely to improve characters would replace tooling
without improving the source art.

For a more detailed game look, evaluate these *visual* tools separately:

| Tool | Appropriate job | Integration idea |
|---|---|---|
| **Spline** (https://spline.design) | Browser-based modeling, materials, lights, interactive 3D, collaborative drafts | Export scenes/images; test 3D asset quality and runtime restrictions |
| **Blender** (https://www.blender.org) | Rigged character meshes, controlled camera, consistent lighting and pose renders | Bake four/eight-direction spritesheets to PNG for Phaser |
| **Three.js** (https://threejs.org) | Optional *live* browser 3D renderer, if 2.5D sprites become too restrictive | Compare a small isolated scene rather than rewriting the app |
| **Next.js** (https://nextjs.org/docs) | Optional future React web application features | Revisit only if the website's routing/server-rendering needs justify the migration |

Both ChatGPT and Claude can author code, automation and asset specifications
for the pipeline, but a static illustration is **not itself** an animated game
character. Validate a single Hal Jordan-inspired *original* space-lantern
character with consistent angles, pivot alignment and frame sizes before
expanding to the rest of the Corps. Use original or licensed assets only.

## First art experiment (later PR)

1. Produce an original Hal concept model / concept sheet (no copied official
   DC art assets).
2. Establish a repeatable 3/4 isometric camera, lighting, scale and foot pivot.
3. Render idle plus a short walking test from four directions.
4. Import the PNG sprites into the existing Phaser scene alongside the temporary
   geometry. Verify framerate, click area, memory and scaling on the Windows PC.
5. Review Blender-vs-Spline effort, export licensing/hosting, and visual quality
   with the project owner. Keep local-only behavior unless remote hosting is
   explicitly requested.

Official references: https://www.phaser.io/oss/docs/ ,
https://docs.spline.design/ , https://nextjs.org/docs/ .
