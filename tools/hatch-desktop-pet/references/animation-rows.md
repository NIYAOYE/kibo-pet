# Animation Rows

The desktop-pet app reads one fixed atlas: **8 columns, 13 rows, 192x208 px per cell** (1536x2704 px total). The single source of truth for this layout is [`scripts/pet_layout.py`](../scripts/pet_layout.py); the table below mirrors it for reference.

Rows 0-7 are the **MVP** animation set. Rows 8-12 are the **Phase 2** emotion/event-driven set. `walk-right` and `walk-left` are two separately drawn rows (no runtime mirroring) so the halo, hair tint, and any one-sided markings stay correct in both directions.

| Row | State | Used columns | Loop | Phase | Durations (ms) |
| --- | --- | ---: | --- | --- | --- |
| 0 | idle | 0-5 | yes | mvp | 280, 110, 110, 140, 140, 320 |
| 1 | walk-right | 0-7 | yes | mvp | 120 x7, 220 |
| 2 | walk-left | 0-7 | yes | mvp | 120 x7, 220 |
| 3 | drag | 0-3 | yes | mvp | 140, 140, 140, 200 |
| 4 | sleep | 0-3 | yes | mvp | 420, 420, 420, 520 |
| 5 | greet | 0-4 | no | mvp | 140, 140, 140, 140, 280 |
| 6 | thinking | 0-5 | yes | mvp | 150 x5, 260 |
| 7 | talk | 0-3 | yes | mvp | 120, 120, 120, 180 |
| 8 | happy | 0-5 | no | phase2 | 140 x5, 260 |
| 9 | sad | 0-5 | yes | phase2 | 180 x5, 300 |
| 10 | cry | 0-5 | yes | phase2 | 160 x5, 260 |
| 11 | surprised | 0-4 | no | phase2 | 110, 110, 140, 140, 280 |
| 12 | love | 0-5 | yes | phase2 | 160 x5, 260 |

Unused cells after each row's final used column must be fully transparent.

## Row Purposes

- `idle`: calm, low-distraction breathing/blinking loop; the first frame doubles as the reduced-motion static pet. Keep motion subtle and persona-preserving.
- `walk-right`: rightward walking loop; the pet faces and moves to the right.
- `walk-left`: leftward walking loop; a separately drawn row, not a mirror of `walk-right`.
- `drag`: the pet picked up and dangling from the cursor; limbs loose, small startled expression, no cursor/hand/string drawn.
- `sleep`: dozing loop with closed eyes and a lowered head; no floating Z letters or bubbles.
- `greet`: greeting gesture shown when the pet is summoned (arm raise / small wave and return).
- `thinking`: focused working/processing loop while the agent runs a task. Not foot-running; no new prop/symbol props.
- `talk`: talking loop (mouth open/close + small head bob) shown while the pet replies; no speech bubbles or text.
- `happy`: a small celebratory hop with a bright expression; vertical motion only, no confetti/shadows.
- `sad`: slumped, deflated loop with drooping limbs.
- `cry`: crying loop; tears allowed only when attached to the face, no detached droplets.
- `surprised`: startled recoil with wide eyes; no exclamation marks or shock lines.
- `love`: affectionate loop (blush / clasped hands); a heart is allowed only if it touches/overlaps the pet.
