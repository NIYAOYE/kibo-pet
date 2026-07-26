# Live2D LLM Performance Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chat agent invoke declared Live2D expressions and temporary single-pose parameter performances using the active model's verified visible controls.

**Architecture:** Renderer code enumerates and owns Cubism parameters plus the temporary fade layer. Main code retains only the active renderer's snapshot, exposes one dynamic `live2d.perform` tool, deeply validates every nested argument, then forwards an instruction through typed IPC.

**Tech Stack:** Electron, TypeScript, Vitest, PixiJS, untitled-pixi-live2d-engine Cubism Core.

---

## File map

- Create `src/shared/live2dPerformance.ts`: shared types, classifier, validator, capability prompt formatter.
- Create `src/shared/live2dPerformance.test.ts`: pure validation/classification coverage.
- Create `src/renderer/live2dPerformanceLayer.ts` and test: fade-in/hold/fade-out envelope.
- Create `src/main/tools/live2dPerformance.ts` and test: dynamic tool factory and cooldown.
- Create `src/main/shell/live2dCapabilityStore.ts` and test: active-pet snapshot lifetime.
- Modify `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/petRenderer.ts`, `src/renderer/spriteRenderer.ts`, `src/renderer/live2dRenderer.ts`, `src/renderer/main.ts`, `src/renderer/petController.ts`, `src/renderer/live2dStateMapResolver.ts`, `src/main/shell/chat.ts`, `src/main/shell/petSession.ts`, and `src/main/shell/index.ts`.
- Modify user data only: `C:\\Users\\xzy\\AppData\\Roaming\\kibo-pet\\pets\\BQD\\pet.json`; never stage it.

### Task 1: Shared capability and instruction contract

**Files:**
- Create: `src/shared/live2dPerformance.ts`
- Test: `src/shared/live2dPerformance.test.ts`

- [ ] **Step 1: Write failing classifier/validator tests**

```ts
it('排除物理、运算缓存和分隔符，同时保留可见参数', () => {
  expect(classifyVisibleParameters([
    { id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 },
    { id: 'ParamPhysicsRAM_BodyX', min: -1, max: 1, defaultValue: 0 },
    { id: 'ParamDivider_1', min: 0, max: 1, defaultValue: 0 }
  ])).toMatchObject([{ id: 'ParamAngleX' }])
})

it('拒绝未知表情并将值、权重、时长裁剪到限制内', () => {
  const snapshot = { petId: 'BQD', expressions: ['笑咪咪'], parameters: [{ id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 }] }
  expect(validatePerformanceInstruction({ expression: '笑咪咪', parameters: [{ id: 'ParamAngleX', value: 99, weight: 2 }], durationMs: 6000 }, snapshot))
    .toMatchObject({ ok: true, value: { durationMs: 5000, parameters: [{ value: 30, weight: 1 }] } })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run src/shared/live2dPerformance.test.ts`

Expected: FAIL because `live2dPerformance.ts` does not exist.

- [ ] **Step 3: Implement the contract**

```ts
export interface Live2DParameterCapability { id: string; min: number; max: number; defaultValue: number; name?: string; group?: string }
export interface Live2DCapabilitySnapshot { petId: string; expressions: string[]; parameters: Live2DParameterCapability[] }
export interface Live2DPerformanceInstruction {
  expression?: string
  parameters: Array<{ id: string; value: number; weight: number }>
  durationMs: number; fadeInMs: number; fadeOutMs: number
}
```

Implement `classifyVisibleParameters()` with finite-range checks, deny-before-allow overrides, and case-insensitive internal tokens: `physics`, `input`, `output`, `ram`, `cache`, `divider`, `controller`, plus `物理`, `运算`, `输入`, `输出`, `控制`, `区切`. Implement `validatePerformanceInstruction()`: require either an expression or at least one parameter, accept at most eight entries, clamp values to Core bounds, clamp weights to 0–1, and clamp duration to 150–5000 ms. Export `formatLive2DCapabilities()` with exact IDs, ranges, defaults, and expression names.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `pnpm vitest run src/shared/live2dPerformance.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/live2dPerformance.ts src/shared/live2dPerformance.test.ts
git commit -m "feat(Live2D): 增加表演能力契约"
```

### Task 2: Pure single-pose fade layer

**Files:**
- Create: `src/renderer/live2dPerformanceLayer.ts`
- Test: `src/renderer/live2dPerformanceLayer.test.ts`

- [ ] **Step 1: Write a failing envelope test**

```ts
it('连续完成淡入、保持和淡出', () => {
  const layer = { instruction: { parameters: [], durationMs: 1000, fadeInMs: 200, fadeOutMs: 300 }, startedAtMs: 1000 }
  expect(performanceWeightAt(layer, 1100)).toBe(0.5)
  expect(performanceWeightAt(layer, 1500)).toBe(1)
  expect(performanceWeightAt(layer, 1850)).toBeCloseTo(0.5)
  expect(performanceWeightAt(layer, 2000)).toBe(0)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run src/renderer/live2dPerformanceLayer.test.ts`

Expected: FAIL because `performanceWeightAt` is absent.

- [ ] **Step 3: Implement only the single target-pose evaluator**

```ts
export interface ActivePerformanceLayer { instruction: Live2DPerformanceInstruction; startedAtMs: number }
export function performanceWeightAt(layer: ActivePerformanceLayer, nowMs: number): number {
  const elapsed = nowMs - layer.startedAtMs
  const { durationMs, fadeInMs, fadeOutMs } = layer.instruction
  if (elapsed < 0 || elapsed >= durationMs) return 0
  if (fadeInMs > 0 && elapsed < fadeInMs) return elapsed / fadeInMs
  if (fadeOutMs > 0 && elapsed > durationMs - fadeOutMs) return (durationMs - elapsed) / fadeOutMs
  return 1
}
```

Clamp the result to 0–1. Do not add queues, keyframes, curves, or concurrent layers.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `pnpm vitest run src/renderer/live2dPerformanceLayer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dPerformanceLayer.ts src/renderer/live2dPerformanceLayer.test.ts
git commit -m "feat(Live2D): 增加单姿势表演淡入淡出"
```

### Task 3: Renderer discovery, expression-only states, and overlay

**Files:**
- Modify: `src/renderer/live2dStateMapResolver.ts`, `src/renderer/live2dRenderer.ts`, `src/renderer/petRenderer.ts`, `src/renderer/spriteRenderer.ts`, `src/renderer/petController.ts`
- Test: `src/renderer/live2dStateMapResolver.test.ts`; create `src/renderer/live2dRenderer.test.ts`

- [ ] **Step 1: Write failing expression-only tests**

```ts
it('解析只有 expression 的状态', () => {
  expect(resolveStateMotion({ greet: { expression: '笑咪咪' } }, 'greet'))
    .toMatchObject({ motionGroup: undefined, expression: '笑咪咪' })
})
it('仅表情状态不调用 motion', async () => {
  const { renderer, model } = makeLive2DRendererHarness({ greet: { expression: '笑咪咪' } })
  renderer.playState('greet'); await flushPromises()
  expect(model.expression).toHaveBeenCalledWith('笑咪咪')
  expect(model.motion).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/renderer/live2dStateMapResolver.test.ts src/renderer/live2dRenderer.test.ts`

Expected: FAIL because resolver currently requires `motionGroup`.

- [ ] **Step 3: Implement renderer behavior**

Make `ResolvedMotion.motionGroup` optional; resolve entries that contain either a motion or expression. Call `model.motion()` only when a group exists, but call `model.expression()` whenever an expression exists.

Extend `PetRenderer` with:

```ts
getLive2DCapabilities(): Live2DCapabilitySnapshot | null
applyLive2DPerformance(instruction: Live2DPerformanceInstruction, nowMs: number): void
```

Sprite implementation returns `null` and no-ops. In `Live2DPetRenderer`, enumerate Core parameters by index after `setupModel()` using `getParameterCount/getParameterId/getParameterMinimumValue/getParameterMaximumValue/getParameterDefaultValue`; classify them and capture expression-manager definitions. Store a single active layer. Apply it on a post-baseline Pixi ticker callback using `setParameterValueByIndex(index, value, weight * performanceWeightAt(...))`. Skip `interaction.lipSyncParameter` and focus-controller-owned controls; clear the layer on destroy, discard, and commit swap.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run src/renderer/live2dStateMapResolver.test.ts src/renderer/live2dRenderer.test.ts src/renderer/live2dPerformanceLayer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/live2dStateMapResolver.ts src/renderer/live2dStateMapResolver.test.ts src/renderer/live2dRenderer.ts src/renderer/live2dRenderer.test.ts src/renderer/petRenderer.ts src/renderer/spriteRenderer.ts src/renderer/petController.ts
git commit -m "feat(Live2D): 支持仅表情和参数表演"
```

### Task 4: Typed IPC and active capability lifetime

**Files:**
- Create: `src/main/shell/live2dCapabilityStore.ts`
- Test: `src/main/shell/live2dCapabilityStore.test.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/main.ts`, `src/main/shell/index.ts`

- [ ] **Step 1: Write a failing active-pet store test**

```ts
it('只接受活动宠物的快照并在 clear 后失效', () => {
  const store = createLive2DCapabilityStore()
  store.activate('BQD')
  expect(store.report({ petId: 'other', expressions: [], parameters: [] })).toBe(false)
  expect(store.report({ petId: 'BQD', expressions: ['笑咪咪'], parameters: [] })).toBe(true)
  store.clear()
  expect(store.current()).toBeNull()
})
```

- [ ] **Step 2: Run it and verify RED**

Run: `pnpm vitest run src/main/shell/live2dCapabilityStore.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement store and bridge**

Add IPC names `REPORT_LIVE2D_CAPABILITIES` and `LIVE2D_PERFORM`. Expose `petApi.reportLive2DCapabilities(snapshot)` and `petApi.onLive2DPerform(callback)`. Report only after initial load or committed reload; never report a prepared model. In main, accept reports only from `petWin.webContents`, activate/clear the store around switches, and send a performance only if the current snapshot pet ID equals `session.petId`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/main/shell/live2dCapabilityStore.test.ts && pnpm typecheck`

Expected: PASS and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/renderer/main.ts src/main/shell/index.ts src/main/shell/live2dCapabilityStore.ts src/main/shell/live2dCapabilityStore.test.ts
git commit -m "feat(Live2D): 接入表演能力IPC"
```

### Task 5: Dynamic agent tool and BQD repair

**Files:**
- Create: `src/main/tools/live2dPerformance.ts`, `src/main/tools/live2dPerformance.test.ts`
- Modify: `src/main/shell/chat.ts`, `src/main/shell/petSession.ts`, `src/main/shell/chat.test.ts`
- Modify outside repository: `C:\\Users\\xzy\\AppData\\Roaming\\kibo-pet\\pets\\BQD\\pet.json`

- [ ] **Step 1: Write failing tool test**

```ts
it('验证并分派当前模型的表演指令', async () => {
  const sent: Live2DPerformanceInstruction[] = []
  const tool = createLive2DPerformanceTool({
    snapshot: { petId: 'BQD', expressions: ['笑咪咪'], parameters: [{ id: 'ParamAngleX', min: -30, max: 30, defaultValue: 0 }] },
    now: () => 1000, dispatch: (x) => { sent.push(x); return true }
  })
  await tool.run({ expression: '笑咪咪', parameters: [{ id: 'ParamAngleX', value: 99 }], durationMs: 900 }, { signal: new AbortController().signal })
  expect(sent[0]?.parameters[0]?.value).toBe(30)
})
```

- [ ] **Step 2: Run it and verify RED**

Run: `pnpm vitest run src/main/tools/live2dPerformance.test.ts`

Expected: FAIL because the factory is absent.

- [ ] **Step 3: Implement and wire the tool**

Create a `ToolSpec` named `live2d.perform`, with generic shallow JSON schema and deep `validatePerformanceInstruction()` validation. Put `formatLive2DCapabilities(snapshot)` into its description, use a closure-local 500 ms cooldown, and return an error without IPC when dispatch rejects a stale pet. Construct the tool during `createChatStore.handleSend()` only when `getLive2DCapabilitySnapshot()` returns a snapshot; inject the store getter/dispatcher through `PetSessionDeps` from shell index. Do not change provider APIs or make an extra model request.

- [ ] **Step 4: Run tool and chat tests**

Run: `pnpm vitest run src/main/tools/live2dPerformance.test.ts src/main/shell/chat.test.ts`

Expected: PASS.

- [ ] **Step 5: Repair BQD user data**

Copy `C:\\Users\\xzy\\AppData\\Roaming\\kibo-pet\\pets\\BQD\\pet.json` to a timestamped backup in the same directory. Replace `render.stateMap` with `{}`; its current `Recovered` motion group and `sy` expression do not exist. Do not stage this user-data edit. Add a shared test fixture proving BQD's real expression names `眯眯眼`, `泪珠`, `眼泪`, and `笑咪咪` validate and `sy` fails.

- [ ] **Step 6: Commit repository changes**

```bash
git add src/main/tools/live2dPerformance.ts src/main/tools/live2dPerformance.test.ts src/main/shell/chat.ts src/main/shell/petSession.ts src/main/shell/chat.test.ts src/shared/live2dPerformance.test.ts
git commit -m "feat(Agent): 支持Live2D动态表演工具"
```

### Task 6: Full verification and handoff

**Files:**
- Verify: repository and BQD user data

- [ ] **Step 1: Run complete automated checks**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 2: Run Electron acceptance with BQD**

Run `pnpm preview` after unsetting `ELECTRON_RUN_AS_NODE`. Confirm a chat reply can invoke `live2d.perform`, BQD expression-only calls work, a pose continuously fades in/holds/fades out, TTS mouth movement and mouse tracking retain control, a second performance replaces the first, and switching to a sprite pet removes the tool.

- [ ] **Step 3: Consolidate feature commits**

Inspect `git status --short` and preserve unrelated changes. Squash only this feature's intermediate commits, including the two approved design commits, into one final conventional Chinese commit:

```bash
git commit -m "feat(Live2D): 支持LLM动态参数表演"
```

Do not push unless the user asks.

