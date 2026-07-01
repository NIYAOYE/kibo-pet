# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Shimeji-style **desktop pet with an agent kernel** (Electron + TypeScript). The pet is a transparent always-on-top sprite; its "brain" is a self-built, OpenClaw-inspired agent kernel (pluggable LLM providers, Markdown-defined skills, layered memory). **MVP-01 (skeleton + runnable shell) is done and on `master`**; the agent kernel, tools, skills, and memory are not built yet — their `src/main/*` folders currently hold only README stubs describing intended responsibilities. Read `PROGRESS.md` (repo root) for current status, roadmap (MVP-02..06), and deferred items before starting work.

## Commands

Package manager is **pnpm** (not npm/yarn).

```bash
pnpm install
pnpm dev                         # run in dev mode (electron-vite, HMR)
pnpm build                       # typecheck + build all three bundles
pnpm preview                     # run the built app (more reliable than dev for a visual check)
pnpm test                        # run unit tests (Vitest)
pnpm typecheck                   # tsc --noEmit over both tsconfigs
pnpm vitest run <path/to.test.ts>   # run a single test file
pnpm vitest run -t "<name>"          # run tests matching a name
```

## Critical gotchas (repo-specific, non-obvious)

- **Do NOT add `"type": "module"` to `package.json`.** Electron's main/preload must be CommonJS; ESM main statically importing the CJS `electron` module crashes Node's cjs export preparser. electron-vite emits CJS by default without that flag. (See commit history / `PROGRESS.md`.)
- **Automated checks passing ≠ the app runs.** `typecheck`/`test`/`build` bundle code but cannot prove the window renders. After any main/preload/renderer/shell change, do a real `pnpm dev` or `pnpm preview` and visually confirm.
- If a shell has `ELECTRON_RUN_AS_NODE=1` (some sandboxes/CI), Electron launches as plain Node and crashes (`require('electron').app` is undefined). `unset ELECTRON_RUN_AS_NODE` before launching. Normal dev terminals don't set this.
- `.gitignore` **intentionally ignores `docs/*` and `pets/luluka`** — these exist on disk but are not tracked. Read them by path; don't assume they're absent because `git` doesn't show them.

## Architecture (the big picture)

**Two Electron processes, one bridge.** `src/main` (Node: window, tray, IPC, file I/O, and eventually the agent kernel) and `src/renderer` (the visible pet UI) never talk directly. They communicate ONLY through `src/preload/index.ts`, which uses `contextBridge` to expose a minimal typed `window.petApi`. Channel names and message types live in `src/shared/ipc.ts` — the single source of truth both sides import. Security baseline is deliberate: `contextIsolation:true, sandbox:true, nodeIntegration:false`, CSP in `index.html`, and the renderer gets zero filesystem access (see below). When adding an IPC capability you touch four files in lockstep: `src/shared/ipc.ts` (constant + `PetApi` type), `src/main/index.ts` (handler), `src/preload/index.ts` (expose), and the renderer caller.

**`src/shared` is the cross-process contract.** Pure types + pure functions, no side effects, imported by main, preload, renderer, and tests via the `@shared/*` alias. `petPackage.ts` defines the `pet.json` shape and the pure sprite math (`frameRect`, `frameDurationMs`, `parsePetManifest`); these are unit-tested and reused everywhere rather than re-derived.

**Pet packages are swappable skins.** A pet is a self-contained folder `pets/<id>/` containing `pet.json` (metadata + `sheet{rows,cols,cellWidth,cellHeight}` + `animations{<state>:{row,frames,fps,loop,durations?}}`), `spritesheet.webp` (a fixed 8-col × 13-row atlas, 192×208 cells), and optionally `persona.md` (agent personality, block-structured) / `lines.json` (canned catchphrases) / `voice/` (audio). The main process (`petLoader.ts`) reads `pet.json` at runtime and embeds the spritesheet as a `data:` URL sent over IPC, so the renderer needs no file access. The renderer's `SpritePlayer` plays an animation by state name using the shared frame math; `walk-left` is a distinct drawn row and must NOT be produced by flipping `walk-right`.

**Two separate "skill/tool" trees — don't conflate them.**
- `skills/` = **runtime product skills** the pet's agent will load (each is a dir + `SKILL.md`). Loaded by the (future) loader in `src/main/skills`.
- `tools/hatch-desktop-pet/` = a **dev-time asset-generation tool** (Python, adapted from `hatch-pet`) that generates a pet's spritesheet + `pet.json`. Its `scripts/pet_layout.py` is the single source of truth for atlas geometry, per-row frame counts, durations, and loop flags; every other script imports from it, and `package_custom_pet.py` emits `pet.json` from it. If you change animation timing or the atlas layout, change it there (and keep any already-generated `pets/*/pet.json` in sync).

## Conventions

- Cross-process values go through `src/shared` and the `@shared/*` alias; never hardcode IPC channel strings — use the `IPC` constant.
- TDD for pure logic (write the failing Vitest first); GUI/Electron wiring is verified by running the app.
- Frequent, small commits; conventional-commit style (`feat(scope): ...`). This project follows the superpowers workflow (brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch); plans and specs live under `docs/superpowers/` (on disk, gitignored).

# AI Coding: Ten Honors and Ten Shames

- Be ashamed of guessing APIs; take pride in checking the documentation.
- Be ashamed of acting on vague instructions; take pride in asking for clarification.
- Be ashamed of inventing business logic; take pride in seeking human confirmation.
- Be ashamed of fabricating new interfaces; take pride in reusing existing ones.
- Be ashamed of skipping validation; take pride in proactive testing.
- Be ashamed of breaking the architecture; take pride in following established standards.
- Be ashamed of pretending to understand; take pride in honestly admitting what you do not know.
- Be ashamed of making changes blindly; take pride in refactoring with care.
- Be ashamed of hard-coding magic values; take pride in using configuration, constants, and clear abstractions.
- Be ashamed of vague and inconsistent commits; take pride in writing clear, standardized commit messages in Chinese.