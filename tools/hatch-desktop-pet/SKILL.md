---
name: hatch-desktop-pet
description: Create, repair, validate, preview, and package the desktop-pet app's animated sprite pets from character art, screenshots, generated images, or visual references. Use when a user wants to generate or rebuild the desktop pet's spritesheet — an 8x13 atlas (1536x2704, 192x208 cells) with transparent unused cells, row-by-row animation prompts, QA contact sheets, preview videos, and an extended pet.json (sheet + animations blocks). This skill delegates visual generation to an image-generation skill (Codex `$imagegen`) or an OpenAI fallback, and uses bundled scripts for deterministic spritesheet assembly. It is the asset-production tool for the desktop-pet agent project; it is not one of the app's runtime product skills.
---

# Hatch Desktop Pet

## Overview

Create the desktop-pet app's animated sprite pet from a concept, one or more reference images, or both. This skill owns pet-specific prompt planning, the 13-row animation layout, frame extraction, atlas geometry, QA, previews, and packaging. It delegates visual generation to an image-generation skill.

This skill is adapted from the upstream `hatch-pet` Codex skill. The differences: a **13-row** layout tailored to this app (see below), an **extended `pet.json`** with `sheet` + `animations` blocks, packages written into the project's `pets/` folder, and a single source of truth for geometry in [`scripts/pet_layout.py`](scripts/pet_layout.py).

User-facing inputs are optional. If the user omits a pet name, infer one from the concept or reference filenames. If the user omits a description, infer one. If the user omits reference images, generate the base pet from text first, then use that base as the canonical reference for every animation row.

## Atlas And Rows

The app reads one fixed atlas: **8 columns x 13 rows, 192x208 px cells, 1536x2704 px total**. Geometry, frame counts, per-frame durations, and loop flags are defined once in [`scripts/pet_layout.py`](scripts/pet_layout.py); [references/animation-rows.md](references/animation-rows.md) mirrors them and [references/pet-contract.md](references/pet-contract.md) documents the package/manifest shape.

Rows 0-7 are the MVP set; rows 8-12 are the Phase 2 emotion set:

| Row | State | Frames | Row | State | Frames |
| --- | --- | ---: | --- | --- | ---: |
| 0 | idle | 6 | 7 | talk | 4 |
| 1 | walk-right | 8 | 8 | happy | 6 |
| 2 | walk-left | 8 | 9 | sad | 6 |
| 3 | drag | 4 | 10 | cry | 6 |
| 4 | sleep | 4 | 11 | surprised | 5 |
| 5 | greet | 5 | 12 | love | 6 |
| 6 | thinking | 6 | | | |

`walk-left` is a **separately drawn left-facing row**, not a horizontal mirror of `walk-right`, because the pet has asymmetric features (halo, hair tint). It is generated as a normal grounded row that uses `walk-right` as a gait reference.

## Generation Delegation

Use an image-generation skill for all normal visual generation.

- **In Codex:** load and follow the installed image generation skill before generating base art, row strips, or repair rows:
  `${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/SKILL.md`. Let `$imagegen` choose its own built-in-first path and CLI fallback rules.
- **Outside Codex (no image-gen skill available):** use the secondary OpenAI fallback (`scripts/generate_pet_images.py`, requires `OPENAI_API_KEY`). State clearly that you are using the fallback because no image-generation skill is available.

When invoking image generation, pass the generated pet prompt as the authoritative visual spec. Keep prompts terse, sprite-specific, and desktop-pet oriented; do not add hero-art, photo, product, or illustration-style augmentation.

Use this skill's scripts for deterministic work only: preparing prompts and manifests, ingesting selected outputs, extracting frames, validating rows, composing the final atlas, creating QA media, and packaging.

Hard boundary: do not create, draw, tile, warp, mirror, or synthesize pet visuals with local Python/Pillow scripts, SVG, canvas, or HTML/CSS as a substitute for real image generation. For a normal run, expect up to 14 visual generation jobs: 1 base pet plus 13 row strips. If those calls are blocked or unavailable, stop and explain the blocker instead of fabricating row strips locally.

Do not mark visual jobs complete by editing `imagegen-jobs.json` or copying files into `decoded/`. Use `record_imagegen_result.py` for selected image-gen outputs, or `generate_pet_images.py` for the documented OpenAI fallback. The deterministic scripts may only process already-generated visual outputs.

Only the base job may be prompt-only. Every row-strip job must use the input images listed in `imagegen-jobs.json`, including the canonical base reference created after the base job is recorded.

## Desktop Pet Style

Default pet art should be a small pixel-art-adjacent mascot: compact chibi proportions, chunky readable silhouette, thick dark 1-2 px outlines, visible stepped/pixel edges, limited palette, flat cel shading, simple expressive face, tiny limbs. Even if the reference art is more detailed, complex, or realistic, simplify it into this style.

Do NOT generate polished illustration, painterly rendering, anime key art, 3D rendering, glossy app-icon treatment, realistic fur/material texture, soft gradients, high-detail antialiasing, or complex tiny accessories.

## Transparency And Effects

Pet rows are processed into transparent 192x208 cells, so every generated pixel must either belong to the pet sprite or be cleanly removable chroma-key background. Prefer pose, expression, and silhouette changes over decorative effects.

Allowed effects must satisfy all of these: state-relevant; physically attached to / touching / overlapping the pet silhouette (not floating); inside the same frame slot; opaque, hard-edged, pixel-style, using non-chroma-key colors; small enough to read at 192x208. Examples: a tear touching the face (`cry`), a heart overlapping the pet (`love`).

Avoid by default (these break transparent-background cleanup): wave marks, motion arcs, speed lines, action streaks, afterimages, blur, smears; detached stars/sparkles/punctuation/icons, falling tear drops, separated smoke, loose dust; cast/contact/drop/oval shadows, floor patches, landing marks, impact bursts, glow, halo-as-effect, aura; text, labels, frame numbers, grids, guide marks, speech/thought bubbles, UI panels, scenery, checkerboard transparency, white/black backgrounds; chroma-key-adjacent colors anywhere on the pet; stray pixels, disconnected outline bits, speckle, cropped body parts, slot-crossing poses.

Per-state guidance lives in `STATE_REQUIREMENTS` inside [`scripts/prepare_pet_run.py`](scripts/prepare_pet_run.py) and is baked into every row prompt. Key ones: `idle` stays calm/low-distraction; `drag` shows the pet dangling with no cursor/hand/string drawn; `sleep` uses closed eyes with no floating Z; `talk` uses mouth motion with no speech bubbles; `thinking` is a working/processing loop, not foot-running; `walk-left` must read as genuinely left-facing.

## Visible Progress Plan

Keep a visible checklist so the user can see progress. Establish the pet name first when possible. Use this checklist (replace `<Pet>`):

1. `Getting <Pet> ready.` Confirm name, description, source images, working folder.
2. `Imagining <Pet>'s main look.` Generate the base reference image (the visual source of truth).
3. `Picturing <Pet>'s poses.` Create the 13 pose rows, starting with `idle` and `walk-right` to confirm identity and gait, then `walk-left`, then the rest.
4. `Hatching <Pet>.` Turn approved poses into the final files, review the contact sheet/previews/validation, fix broken rows, save `pet.json` + `spritesheet.webp` into the pet folder, then tell the user where everything was saved.

Only mark a step complete when the real file, image, or decision exists.

## Default Workflow

Run scripts with the skill's `scripts/` directory (set `SKILL_DIR` to this skill's path):

1. Prepare a run folder, prompts, layout guides, and job manifest:

```bash
SKILL_DIR="<repo>/tools/hatch-desktop-pet"
python "$SKILL_DIR/scripts/prepare_pet_run.py" \
  --pet-name "Arona" \
  --description "<one sentence>" \
  --reference /absolute/path/to/reference.png \
  --output-dir /absolute/path/to/run \
  --pet-notes "<stable pet description>" \
  --style-notes "<style notes>" \
  --force
```

All arguments are optional except flags needed to express user constraints. `prepare_pet_run.py` infers a name, description, chroma key, and output dir as needed, and creates 13 row-specific layout guides under `references/layout-guides/`. Row jobs attach the matching guide as a layout-only input (follow its frame count/spacing/centering/padding; never reproduce visible guide lines).

2. Inspect the next ready jobs:

```bash
python "$SKILL_DIR/scripts/pet_job_status.py" --run-dir /absolute/path/to/run
```

3. For each ready job, invoke image generation with the prompt file and every input image listed in `imagegen-jobs.json`. The base job must complete first; record it so `record_imagegen_result.py` writes `decoded/base.png` and `references/canonical-base.png`. Keep the identity lock authoritative: do not redesign the pet between rows.

Generate and record `walk-right` before `walk-left`; `walk-left` uses `decoded/walk-right.png` as a gait reference and must be drawn as a genuine left-facing row (no mirroring).

4. Ingest a selected output:

```bash
python "$SKILL_DIR/scripts/record_imagegen_result.py" \
  --run-dir /absolute/path/to/run \
  --job-id <job-id> \
  --source /absolute/path/to/generated-output.png
```

5. When all jobs are complete, finalize (extract frames -> QA -> compose atlas -> validate -> contact sheet -> videos -> package):

```bash
python "$SKILL_DIR/scripts/finalize_pet_run.py" --run-dir /absolute/path/to/run
```

Expected output:

```text
run/
  pet_request.json
  imagegen-jobs.json
  prompts/
  decoded/
  frames/frames-manifest.json
  final/spritesheet.png
  final/spritesheet.webp
  final/validation.json
  qa/contact-sheet.png
  qa/review.json
  qa/run-summary.json
  qa/videos/*.mp4
```

The pet package is written to `<cwd>/pets/<pet-id>/` by default (override with `--package-dir`). For this project, run from the repo root so the pet lands in `pets/<pet-id>/`:

```text
pets/<pet-id>/
  pet.json          # id, displayName, description, spritesheetPath, sheet, animations
  spritesheet.webp
```

Review `qa/contact-sheet.png`, `qa/review.json`, `final/validation.json`, and `qa/videos/` before accepting. Deterministic validation is necessary but not sufficient: visually inspect the contact sheet for identity consistency and block acceptance if any row changes face, markings, palette, prop design, or silhouette.

## Subagent Row Generation

After the base job is recorded and `references/canonical-base.png` exists, row-strip visual generation should use subagents unless the user says otherwise. The parent owns the manifest and package writes.

Default flow:

1. Parent runs `prepare_pet_run.py`.
2. Parent generates and records `base`.
3. Parent runs `pet_job_status.py`.
4. Parent spawns subagents for `idle` and `walk-right` first as identity and gait checks.
5. Parent records those results, then delegates `walk-left` (with `decoded/walk-right.png` attached as gait reference).
6. Parent spawns subagents for every remaining row job.
7. Each subagent receives the row prompt and every listed input image, invokes image generation, and returns only the selected source path plus a one-sentence QA note.
8. Parent alone runs `record_imagegen_result.py`, repair queueing, finalization, QA, and packaging.

Subagent write boundary: subagents must not edit `imagegen-jobs.json`, copy into `decoded/`, record results, finalize, or package. Tell each subagent the transparency/effects rules are mandatory and to visually check frame count, identity, clean chroma-key background, and forbidden detached effects before returning.

## Repair Workflow

If finalization stops because row QA failed, queue targeted repairs:

```bash
python "$SKILL_DIR/scripts/queue_pet_repairs.py" --run-dir /absolute/path/to/run
```

Then repeat the generation + `record_imagegen_result.py` loop for each reopened row. Regenerate the smallest failing scope (the failed row, not the whole sheet), using the canonical base, references, contact sheet, and exact failure note as grounding.

## Secondary Image Generation Fallback

`scripts/generate_pet_images.py` is the secondary fallback, for environments where no image-generation skill is available. It requires `OPENAI_API_KEY`:

```bash
python "$SKILL_DIR/scripts/generate_pet_images.py" \
  --run-dir /absolute/path/to/run \
  --model gpt-image-2 \
  --states all
```

## Rules

- Keep image generation as the primary visual layer; never substitute locally drawn/tiled/transformed row strips.
- Attach each row's `references/layout-guides/<state>.png` as a layout-only guide; do not accept outputs that copy guide pixels.
- Treat only the base job as eligible for prompt-only generation; every row job must attach its grounding images.
- Generate `walk-left` as its own grounded left-facing row using `walk-right` as a gait reference; do not mirror.
- Never manually mutate `imagegen-jobs.json` to claim a visual job completed.
- Do not rely on generated images for exact atlas geometry; use this skill's deterministic scripts and `pet_layout.py`.
- Use the chroma key stored in `pet_request.json`.
- Keep silhouette, face, materials, palette, and props consistent across all rows.
- Treat visual identity drift as a blocker even when `qa/review.json` and `final/validation.json` pass.
- Treat forbidden detached effects, chroma-key-adjacent artifacts, shadows, glows, smears, dust, or motion trails as failed rows.
- Treat `qa/review.json` errors as blockers; warnings require visual review.

## Acceptance Criteria

- Final atlas is PNG or WebP, `1536x2704`, transparent-capable, based on `192x208` cells.
- Used cells are non-empty; unused cells are fully transparent.
- Atlas follows the row/frame counts in `scripts/pet_layout.py` / [references/animation-rows.md](references/animation-rows.md).
- Contact sheet and preview videos produced unless explicitly skipped.
- `qa/review.json` has no errors.
- Row-by-row review confirms the animation cycles are complete and identity-consistent.
- `pets/<pet-id>/pet.json` (with `sheet` + `animations` blocks) and `pets/<pet-id>/spritesheet.webp` are saved together.
