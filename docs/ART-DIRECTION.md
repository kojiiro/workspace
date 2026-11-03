# Art direction — A2 Commander / Option A (Sims-style 2.5D)

## Approved experience
The browser is a living Green Lantern Corps-inspired headquarters. The commander clicks characters directly; no player-avatar walking is required. The final visuals should have the clarity and detailed furnishings of a stylized isometric simulation game rather than 8-bit or pixel art.

## Rendering approach
- Phaser 3 2.5D, fixed isometric map with pan/zoom. React panels float above the game.
- Light source: soft upper-left glow, luminous green holographic workstations, dark jade metal floors, restrained yellow and purple accents for non-Green-Lantern characters.
- Depth-order scene objects by floor position where practical, preserving click targets when props overlap.
- Assets should be original/commissioned or appropriately licensed. Prototype geometry is original vector art. Do not copy official character artwork or commercially licensed Sims assets into the repository.

## Character visual benchmark
Start with **John Stewart** as the single proof-of-concept character before generating a full roster:
- Proportions: readable stylized 3D-inspired human silhouette in a 2.5D view, not chibi/pixel art.
- Costume: dark green and black science-fiction uniform with subtle glowing trim and clearly visible face.
- Consistent appearance between idle and movement angles.
- Separate silhouette/face/arm/torso details so all views remain recognizable.
- First verify a stationary character and a 4-direction walk cycle. Only then extend to 8 directions, sitting and interacting with desks.

## Asset format
- Transparent PNG sprite frames or PNG sprite sheets. Keep source assets organized by `assets/characters/<npc-id>/`.
- Individual frames must use identical canvas size, pivot and foot anchor for a given character.
- Name frames predictably: `idle-s-000.png`, `walk-ne-003.png`, etc.
- Maintain corresponding metadata (frame dimensions, action, direction, frame rate).
- Avoid baked-in text labels inside sprites; React/Phaser overlays own UI text.
- Character feet should anchor to isometric tile positions to enable reliable depth sorting.
- Optimize art size and color fidelity while keeping a responsive Windows laptop browser experience.

## Workstation and room art
Develop a compact command hall first. Prioritize recognizable desks, energy consoles, pathways, holographic screens and practical navigability. Add object interaction states later; don't let decorative assets prevent clicking NPCs.

## The staged art pipeline
1. Original concept sheet for John: front, three-quarter, back, outfit close-up.
2. One in-game still-frame test and footprint/pivot validation.
3. Four-direction idle and walk sprites, consistent scale.
4. Replace John geometry and validate appearance/animation in Phaser.
5. Establish the same asset template for the other NPCs.
6. Add station actions and room polish.

This is a visual specification only. **The current 0.2 branch still uses temporary vector NPCs** until art assets have passed the proof-of-concept test.
