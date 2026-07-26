# Live2D LLM Performance Controls Design

## Goal

Enable an LLM to trigger a loaded Live2D pet's declared expressions and temporary parameter performances in response to a chat turn. The framework must work for arbitrary Cubism models rather than relying on a BQD-specific list of parameters.

The LLM receives concrete Live2D parameter IDs and their model-defined ranges. It may only set parameters that the runtime has classified as visible-performance controls, and every request is validated again before reaching the renderer.

## Non-goals

- Do not expose filesystem paths, model resource URLs, arbitrary JavaScript, or direct Cubism Core access to the LLM.
- Do not add autonomous LLM calls for AFK, reminders, or foreground-application signals in this phase. The capability is available during normal chat agent turns only.
- Do not add a per-model hand-authored animation library. Author overrides exist only to correct automatic classification.
- Do not alter the existing mouse tracking, lip-sync, sprite renderer, or non-Live2D tool behavior.

## Capability discovery

After `Live2DModel.from()` resolves and before the model is made active, the renderer enumerates Cubism Core parameters by index. For every parameter it collects:

- `id`, via `getParameterId(index)`;
- `min`, `max`, and `default`, via the corresponding Core APIs;
- optional human-readable name and group information from the model's `.cdi3.json`, if present.

The renderer also reports the model's expression names. The main process stores the capability snapshot with the active pet session and discards it during a pet switch, failed load, renderer disposal, or GPU reload. The main process never accepts a caller-supplied capability list.

### Visible-control classifier

Cubism does not encode a portable "visible parameter" flag. The runtime therefore classifies candidates conservatively:

- reject non-finite or invalid ranges;
- reject separator IDs/names (for example `Divider`);
- reject known internal/control-chain tokens, case-insensitively and in Chinese/Japanese where applicable: physics, input, output, RAM, cache, controller, calculation/operation, and their common equivalents;
- retain the remaining parameters as visible-performance candidates.

Each pet may persist an optional local override with explicit `allow` and `deny` parameter ID lists. `deny` always wins. Overrides correct models with non-standard naming but never create a parameter absent from the runtime snapshot.

## Agent tool

The agent receives one dynamic, generic tool: `live2d.perform`. Its stable schema is deliberately not expanded into hundreds of per-parameter functions.

```json
{
  "expression": "optional declared expression name",
  "parameters": [
    { "id": "ParamAngleX", "value": 12, "weight": 0.7 }
  ],
  "durationMs": 1600,
  "fadeInMs": 160,
  "fadeOutMs": 260
}
```

For an active Live2D pet, the prompt adds a compact capabilities section containing every classified parameter's exact ID, `[min, max]`, default value, and the available expression names. Thus the LLM chooses concrete model controls, not a BQD-specific semantic abstraction.

The tool is included only when a verified Live2D capability snapshot is available. Sprite pets and failed/unready Live2D loads retain today's tool set unchanged.

### Validation and limits

`live2d.perform` performs deep validation itself because the existing registry intentionally validates only top-level fields.

- `expression`, if supplied, must match a declared expression name exactly.
- Every parameter entry must have an ID in the current classified capability list, a finite numeric value, and an optional finite `weight`.
- Values are clamped to the Core-reported range. Weights are clamped to `[0, 1]`.
- A call may contain at most eight parameter entries.
- `durationMs` is clamped to 150–5000 ms; fade durations are non-negative and constrained to the performance duration.
- At most one performance layer is active. A new valid performance replaces the previous one.
- Calls are rate-limited per active pet session to prevent tool-loop flooding.

Invalid requests return an explanatory tool error to the agent loop and cause no renderer mutation. The active-pet/session check prevents a stale tool call from affecting a newly switched model.

## Renderer performance layer

The renderer owns application of the performance instruction because it owns the Live2D model instance. It maintains one ephemeral layer with target parameter values, weights, start time, duration, and fade timings.

On each render tick it computes a fade envelope and applies only the layer's parameters after baseline Live2D updates. The first phase deliberately supports one target pose only: interpolate continuously during fade-in, hold the target parameters for the requested duration, then interpolate continuously out during fade-out. It is not a static frame switch, but it is also not a multi-step/keyframe choreography system. When the envelope reaches zero, it removes the layer instead of writing defaults, allowing normal motion, Cubism physics, and model defaults to resume naturally.

Multi-keyframe performances (for example, lower head then raise it and tilt) are deferred until this single-pose pipeline has been verified on real models. A later extension may add bounded keyframe tracks and easing curves without changing the validation or capability-discovery boundary.

Parameter ownership is explicit:

- lip-sync retains priority for the configured `interaction.lipSyncParameter`;
- mouse tracking retains priority for the model's look-target controls;
- the LLM layer controls all other validated candidate parameters;
- model motion/physics remain the baseline below these temporary overlays.

An expression is applied once when the instruction begins. It may be combined with parameter overlays or used by itself, which fixes models such as BQD that contain expressions but no `.motion3.json` resources.

## IPC and lifecycle

Two narrowly scoped IPC paths are added:

1. Renderer to main: report the verified capability snapshot after model load/preparation.
2. Main to renderer: apply an already validated `Live2DPerformanceInstruction` to the current session.

Both payloads are typed in `src/shared/ipc.ts`. Session IDs/request epochs tie a capability snapshot and instruction to the active renderer. Hot-switch preparation does not expose capabilities until commit. GPU recovery and reload rebuild the snapshot before re-enabling the tool.

## BQD outcome

BQD has no Motion Groups and four declared expressions: `眯眯眼`, `泪珠`, `眼泪`, and `笑咪咪`. After this work it becomes immediately performable by `live2d.perform`, including expression-only calls. Its existing invalid `Recovered` / `sy` state mapping is replaced with a safe no-motion baseline and no fabricated expression names.

## Tests and verification

Pure logic is test-first with Vitest:

- parameter capability normalization and classifier behavior, including overrides and multilingual internal names;
- performance-instruction validation, clamping, stale-session rejection, and rate limiting;
- fade envelope and ownership priority rules;
- expression-only resolution, while preserving ordinary motion-plus-expression behavior;
- lifecycle behavior across prepare/commit/discard/reload.

Integration-level unit tests verify the tool is absent without a current Live2D capability snapshot and receives the current pet's capabilities after successful activation. BQD's manifest is verified to contain only names present in its model resources.

Before handoff run targeted Vitest suites, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. A real Electron preview with BQD verifies expression-only invocation, parameter fade/restore, mouse tracking, lip-sync, and hot switching.
