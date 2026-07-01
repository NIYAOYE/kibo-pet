# Desktop Pet Contract

## Sprite Atlas

- Format: PNG or WebP.
- Dimensions: `1536x2704`.
- Grid: 8 columns x 13 rows.
- Cell: `192x208`.
- Background: transparent.
- Unused cells: fully transparent.

The renderer animates by reading frames from the fixed row/column grid. Do not add labels, gutters, borders, grid lines, shadows outside the cell, or extra frames. See [animation-rows.md](animation-rows.md) for the row layout and [`scripts/pet_layout.py`](../scripts/pet_layout.py) for the authoritative geometry, frame counts, durations, and loop flags.

## Pet Package

A pet is a self-contained folder; swapping the skin = swapping the folder.

```text
pets/<pet-id>/
├── pet.json
├── spritesheet.webp
└── persona.md          # optional: persona for the agent (Persona/Voice/Behavior/Tools)
```

`package_custom_pet.py` writes packages to `<cwd>/pets/<pet-id>/` by default (override with `--package-root` or `--output-dir`). `persona.md` is authored separately and is not produced by this skill.

## pet.json Manifest

```json
{
  "id": "arona",
  "displayName": "Arona",
  "description": "One short sentence.",
  "spritesheetPath": "spritesheet.webp",
  "sheet": { "rows": 13, "cols": 8, "cellWidth": 192, "cellHeight": 208 },
  "animations": {
    "idle":       { "row": 0,  "frames": 6, "fps": 5, "loop": true,  "durations": [280,110,110,140,140,320] },
    "walk-right": { "row": 1,  "frames": 8, "fps": 8, "loop": true,  "durations": [120,120,120,120,120,120,120,220] },
    "walk-left":  { "row": 2,  "frames": 8, "fps": 8, "loop": true,  "durations": [120,120,120,120,120,120,120,220] },
    "drag":       { "row": 3,  "frames": 4, "fps": 6, "loop": true,  "durations": [140,140,140,200] },
    "sleep":      { "row": 4,  "frames": 4, "fps": 2, "loop": true,  "durations": [420,420,420,520] },
    "greet":      { "row": 5,  "frames": 5, "fps": 6, "loop": false, "durations": [140,140,140,140,280] },
    "thinking":   { "row": 6,  "frames": 6, "fps": 6, "loop": true,  "durations": [150,150,150,150,150,260] },
    "talk":       { "row": 7,  "frames": 4, "fps": 7, "loop": true,  "durations": [120,120,120,180] },
    "happy":      { "row": 8,  "frames": 6, "fps": 6, "loop": false, "durations": [140,140,140,140,140,260] },
    "sad":        { "row": 9,  "frames": 6, "fps": 5, "loop": true,  "durations": [180,180,180,180,180,300] },
    "cry":        { "row": 10, "frames": 6, "fps": 6, "loop": true,  "durations": [160,160,160,160,160,260] },
    "surprised":  { "row": 11, "frames": 5, "fps": 6, "loop": false, "durations": [110,110,140,140,280] },
    "love":       { "row": 12, "frames": 6, "fps": 6, "loop": true,  "durations": [160,160,160,160,160,260] }
  }
}
```

- `fps` is a representative frames-per-second derived from the mean per-frame duration; `durations` carry the exact per-frame timing (used for non-uniform loops like `idle`). The renderer may use either.
- The `animations` and `sheet` blocks are generated from `scripts/pet_layout.py` by `package_custom_pet.py`, so they always match the atlas that was composed.
