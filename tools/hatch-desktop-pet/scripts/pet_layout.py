#!/usr/bin/env python3
"""Single source of truth for the desktop-pet sprite atlas layout.

Every other script imports geometry, row order, frame counts, durations, and
loop flags from here so the 13-row layout is defined in exactly one place.

Atlas: 8 columns x 13 rows, 192x208 px cells -> 1536x2704 px.

Rows 0-7 are the MVP animation set; rows 8-12 are the Phase 2
emotion/event-driven set. `walk-right` and `walk-left` are generated as two
separate grounded rows (no runtime mirroring) so asymmetric features such as
the halo and hair tint stay correct in both directions.
"""

from __future__ import annotations

from statistics import mean

# --- Atlas geometry ---------------------------------------------------------

COLUMNS = 8
ROWS = 13
CELL_WIDTH = 192
CELL_HEIGHT = 208

ATLAS = {
    "columns": COLUMNS,
    "rows": ROWS,
    "cell_width": CELL_WIDTH,
    "cell_height": CELL_HEIGHT,
    "width": COLUMNS * CELL_WIDTH,
    "height": ROWS * CELL_HEIGHT,
}
ATLAS_WIDTH = ATLAS["width"]
ATLAS_HEIGHT = ATLAS["height"]
ATLAS_SIZE = (ATLAS_WIDTH, ATLAS_HEIGHT)

# --- Animation rows ---------------------------------------------------------
# Each entry: state, row index, frame count, per-frame durations (ms),
# loop flag, purpose, and design phase ("mvp" | "phase2").
# durations length must equal the frame count.

ROW_DEFS: list[dict[str, object]] = [
    {
        "state": "idle",
        "row": 0,
        "frames": 6,
        "durations": [280, 110, 110, 140, 140, 320],
        "loop": True,
        "phase": "mvp",
        "purpose": "calm breathing/blinking idle loop",
    },
    {
        "state": "walk-right",
        "row": 1,
        "frames": 8,
        "durations": [120, 120, 120, 120, 120, 120, 120, 220],
        "loop": True,
        "phase": "mvp",
        "purpose": "rightward walking locomotion loop",
    },
    {
        "state": "walk-left",
        "row": 2,
        "frames": 8,
        "durations": [120, 120, 120, 120, 120, 120, 120, 220],
        "loop": True,
        "phase": "mvp",
        "purpose": "leftward walking locomotion loop",
    },
    {
        "state": "drag",
        "row": 3,
        "frames": 4,
        "durations": [140, 140, 140, 200],
        "loop": True,
        "phase": "mvp",
        "purpose": "being picked up and dangling while dragged by the cursor",
    },
    {
        "state": "sleep",
        "row": 4,
        "frames": 4,
        "durations": [420, 420, 420, 520],
        "loop": True,
        "phase": "mvp",
        "purpose": "dozing/sleeping loop with closed eyes",
    },
    {
        "state": "greet",
        "row": 5,
        "frames": 5,
        "durations": [140, 140, 140, 140, 280],
        "loop": False,
        "phase": "mvp",
        "purpose": "greeting gesture when summoned (raise hand / wave and return)",
    },
    {
        "state": "thinking",
        "row": 6,
        "frames": 6,
        "durations": [150, 150, 150, 150, 150, 260],
        "loop": True,
        "phase": "mvp",
        "purpose": "focused thinking/processing loop while the agent is working",
    },
    {
        "state": "talk",
        "row": 7,
        "frames": 4,
        "durations": [120, 120, 120, 180],
        "loop": True,
        "phase": "mvp",
        "purpose": "talking loop (mouth motion / small head bob) while replying",
    },
    {
        "state": "happy",
        "row": 8,
        "frames": 6,
        "durations": [140, 140, 140, 140, 140, 260],
        "loop": False,
        "phase": "phase2",
        "purpose": "happy reaction: a small celebratory hop",
    },
    {
        "state": "sad",
        "row": 9,
        "frames": 6,
        "durations": [180, 180, 180, 180, 180, 300],
        "loop": True,
        "phase": "phase2",
        "purpose": "sad/deflated slump loop",
    },
    {
        "state": "cry",
        "row": 10,
        "frames": 6,
        "durations": [160, 160, 160, 160, 160, 260],
        "loop": True,
        "phase": "phase2",
        "purpose": "crying loop with tears attached to the face",
    },
    {
        "state": "surprised",
        "row": 11,
        "frames": 5,
        "durations": [110, 110, 140, 140, 280],
        "loop": False,
        "phase": "phase2",
        "purpose": "startled/surprised recoil reaction",
    },
    {
        "state": "love",
        "row": 12,
        "frames": 6,
        "durations": [160, 160, 160, 160, 160, 260],
        "loop": True,
        "phase": "phase2",
        "purpose": "affectionate loop (blush / clasped hands / attached heart)",
    },
]

# Sanity check: durations length must equal frame count, rows must be 0..ROWS-1.
for _entry in ROW_DEFS:
    assert len(_entry["durations"]) == _entry["frames"], _entry["state"]
assert [entry["row"] for entry in ROW_DEFS] == list(range(ROWS))

# --- Derived views (so consumers never re-list states) ----------------------

ALL_STATES: list[str] = [entry["state"] for entry in ROW_DEFS]
ROW_NAMES: list[str] = ALL_STATES
USED_COUNTS: list[int] = [int(entry["frames"]) for entry in ROW_DEFS]

# state -> (row, frames)
ROW_BY_INDEX: dict[int, tuple[str, int]] = {
    int(entry["row"]): (str(entry["state"]), int(entry["frames"])) for entry in ROW_DEFS
}
# state -> frame count
ROW_FRAME_COUNTS: dict[str, int] = {
    str(entry["state"]): int(entry["frames"]) for entry in ROW_DEFS
}
# (state, row, frames) tuples, in row order
ROW_SPECS: list[tuple[str, int, int]] = [
    (str(entry["state"]), int(entry["row"]), int(entry["frames"])) for entry in ROW_DEFS
]
# state -> (row, durations) for video rendering
STATE_DURATIONS: dict[str, tuple[int, list[int]]] = {
    str(entry["state"]): (int(entry["row"]), list(entry["durations"])) for entry in ROW_DEFS
}


def fps_for(durations: list[int]) -> int:
    """Representative frames-per-second derived from mean per-frame duration."""
    avg_ms = mean(durations)
    return max(1, round(1000.0 / avg_ms))


def animations_manifest() -> dict[str, dict[str, object]]:
    """Build the `animations` block for pet.json from the row definitions."""
    manifest: dict[str, dict[str, object]] = {}
    for entry in ROW_DEFS:
        durations = list(entry["durations"])
        manifest[str(entry["state"])] = {
            "row": int(entry["row"]),
            "frames": int(entry["frames"]),
            "fps": fps_for(durations),
            "loop": bool(entry["loop"]),
            "durations": durations,
        }
    return manifest


def sheet_manifest() -> dict[str, int]:
    """Build the `sheet` block for pet.json."""
    return {
        "rows": ROWS,
        "cols": COLUMNS,
        "cellWidth": CELL_WIDTH,
        "cellHeight": CELL_HEIGHT,
    }
