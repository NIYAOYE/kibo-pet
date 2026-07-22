# Live2D 行为隔离(拆分自主游走) — 设计文档

## 背景

Phase 5(动态窗口/锚点/命中/无闪烁热切换)真机验收通过并推送后,用户在准备 Phase 6(鼠标追踪/口型/设置预览)前指出一个更基础的问题:Live2D 宠物和精灵包共用同一套行为状态机(`src/shared/petBrain.ts`),但两者的动作模组并不契合——精灵包的 `walk-left`/`walk-right` 是画师手绘的、包含真实肢体动作的独立帧,而多数 Live2D 模型(包括本项目已导入的真实模型)根本没有对应的走路动作;而且自主游走要求整个宠物窗口在桌面上持续平移,这个"整窗口平移"的呈现方式对 Live2D 也不自然。设计文档 §7.3 早就承认"Live2D 模型通常没有独立左右行走动作",但当时只处理了镜像朝向(`setFacing()`/`mirrorOnWalk`),没有处理"要不要让 Live2D 宠物也自主游走"这个更根本的问题——且经确认,`setFacing()`/`mirrorOnWalk` 从 Phase 4 写好至今从未被任何调用方触发,是尚未激活的死代码。

brainstorming 阶段与用户确认的核心决定:**Live2D 宠物不再自主游走,只能由用户拖拽移动**;`walk` 相关的一切(状态、方向、位移效果)在类型层面对 Live2D 彻底不存在,而不是运行时判断"这只宠物能不能走"。

## 目标

1. 新增 `src/shared/live2dPetBrain.ts`,只包含 `idle/drag/sleep/greet/thinking/talk` 六个状态,不包含 `walk`/`Direction`/`dirY`/`walkRemainingPx`/`moveX`/`moveY` 等任何与自主位移相关的类型或字段。
2. `src/shared/petBrain.ts`(精灵包用)保持完全不变,不做任何重构或抽象提取——两套模块各自独立演化,互不 import。
3. `PetController` 按 `rendererType`(Phase 5 已经在追踪这个字段)选择对应的行为模块,`tick()` 的分叉范围只到"调用哪个 step 函数、从返回值提取 moveX/moveY(live2d 分支缺省为 0)",往后的"动画变化检测→驱动渲染器 `playState()`→喂给反应规划器"保持一份共享逻辑,不重复。

## 非目标

- **不改动 `reactionPlanner.ts`**——台词触发(idle/long_idle/wake/click/drag/app_focus/break 等分类)和"宠物能不能自主移动"正交,`stepReaction()` 的输入/输出契约不变。
- **不改动精灵包的任何行为**——`petBrain.ts` 原封不动,精灵包的自主游走、`walk-left`/`walk-right` 独立绘制行规则不受影响。
- **不清理 `mirrorOnWalk`/`setFacing()` 死代码**——brainstorming 阶段确认这两处虽然目前没有调用方,但用户选择保留不动,不在本次改造范围内(`setFacing()` 是 `PetRenderer` 接口上的通用方法,未来可能有 walk 之外的用途)。
- **不做 Phase 6 的鼠标追踪/口型/设置预览**——那是下一阶段,本次改造是 Phase 6 之前的独立前置修正。
- **不改变 `PetEvent`/`Bounds` 的定义**——这两个类型是纯粹的事件词汇表/几何图元,和"走不走"无关,`live2dPetBrain.ts` 直接从 `petBrain.ts` 导入复用,不重复定义、不新建。

## 1. `live2dPetBrain.ts` 的状态/字段设计

```ts
import type { PetEvent } from './petBrain' // 事件词汇表和"走不走"无关,直接复用

export type Live2DPetState = 'idle' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'

export interface Live2DBrainConfig {
  sleepAfterIdleMs: number
  greetMs: number
  talkMs: number
}

export const DEFAULT_LIVE2D_BRAIN_CONFIG: Live2DBrainConfig = {
  sleepAfterIdleMs: 45000,
  greetMs: 900,
  talkMs: 1200
}

export interface Live2DBrainCtx {
  state: Live2DPetState
  stateElapsedMs: number  // greet/talk 到点后自动回落到 idle,仍需要计时
  idleAccumMs: number     // 距上次用户交互的累计时长,驱动 idle→sleep,语义与 petBrain.ts 一致
  paused: boolean         // 对话框打开时冻结 idle→sleep,仍响应拖拽/对话事件
  config: Live2DBrainConfig
}

export interface Live2DStepInput {
  dtMs: number
  event?: PetEvent
  rng: () => number
}

/** 与 petBrain.ts 的 StepEffects 刻意不同:没有 moveX/moveY——Live2D 宠物结构上
 *  不可能产出自主位移,这条约束在类型层面强制,不是运行时判断出来的。 */
export interface Live2DStepEffects { animation: string }

export function initLive2DBrain(config: Partial<Live2DBrainConfig> = {}): Live2DBrainCtx
export function stepLive2D(ctx: Live2DBrainCtx, input: Live2DStepInput): { ctx: Live2DBrainCtx; effects: Live2DStepEffects }
```

`applyEvent` 的事件→状态映射和 `petBrain.ts` 完全对应(`pickup`→drag、`drop`/`wake`/`dialogClose`→idle、`dialogOpen`→greet+paused、`messageSent`→thinking、`replyDone`→talk、`remind`→greet),纯粹是把原来 `enterState()`/`applyEvent()` 里和 walk 无关的那部分照搬过来。

`idle` 状态的处理比 `petBrain.ts` 简单:原版 `idle` 到点后要在"继续 idle"和"进入 walk"之间掷骰子(`enterWalk` vs `enterIdle`,需要 `dwellMs` 重新随机);Live2D 版本没有"走"这个选项,`idle` 只需要持续累加 `idleAccumMs` 直到触达 `sleepAfterIdleMs` 阈值,不需要 `dwellMs`/骰子机制——这也是为什么 `Live2DBrainCtx` 里没有 `dwellMs` 字段。

`greet`/`talk` 保留原有的"到点自动回落 idle"逻辑(`stateElapsedMs >= cfg.greetMs`/`talkMs`);`drag`/`thinking`/`sleep` 和原版一样持续到相应事件触发切换,不在 `step()` 里自动退出。

## 2. `PetController` 改造

新增一个带判别式的字段保存"当前用哪套行为",而不是两个 ctx 都放着只用一个:

```ts
type BehaviorState =
  | { kind: 'sprite'; ctx: PetBrainCtx }
  | { kind: 'live2d'; ctx: Live2DBrainCtx }
```

构造函数/`prepareReload()`/`commitReload()`(Phase 5 已经在这几处按 `rendererType` 分叉热切换渲染器)在切换渲染器类型的同一时机,一并把 `behavior` 切到对应的初始状态(`initBrain()` 或 `initLive2DBrain()`)——两件事(换渲染器、换行为模块)本来就应该在同一次热切换里原子发生,不新增额外的时序耦合点。

`tick()` 的改动范围严格限定在"调用哪个 step 函数"这一小段:

```ts
private tick(): void {
  const now = performance.now()
  const dtMs = now - this.lastTs
  this.lastTs = now
  // ...既有的 contextSignal/event/prevState 逻辑不变...

  let animation: string
  let moveX = 0
  let moveY = 0
  if (this.behavior.kind === 'sprite') {
    const { ctx, effects } = step(this.behavior.ctx, { dtMs, event, bounds: this.workArea, windowX: this.windowX, windowWidth: this.windowWidth, windowY: this.windowY, windowHeight: this.windowHeight, rng: Math.random })
    this.behavior = { kind: 'sprite', ctx }
    animation = effects.animation
    moveX = effects.moveX
    moveY = effects.moveY
  } else {
    const { ctx, effects } = stepLive2D(this.behavior.ctx, { dtMs, event, rng: Math.random })
    this.behavior = { kind: 'live2d', ctx }
    animation = effects.animation
  }

  // ...往后"animation !== this.currentAnim 则 playState + syncBounds"、
  // "moveX/moveY !== 0 则 moveWindow"、反应规划器喂入——完全保持现有共享逻辑,
  // 只是改用上面统一出来的局部变量 animation/moveX/moveY,不重复分支。
}
```

`moveX/moveY !== 0` 的既有判断天然对 live2d 分支恒为 false(因为压根没被赋值成非零),不需要额外的类型分叉或 `'moveX' in effects` 判断。

## 3. 测试策略

- `live2dPetBrain.test.ts`(新建,纯函数 TDD,和 `petBrain.test.ts` 并列):覆盖空闲累计触发睡眠、`pickup`/`drop`/`dialogOpen`/`dialogClose`/`messageSent`/`replyDone`/`remind` 各自的状态转换、`paused` 语义(对话框开着时不会自动入睡)、`greet`/`talk` 到点自动回落 idle。不需要专门测试"没有 walk/moveX/moveY"——这条约束在编译期就由类型系统保证,测试证明不了比编译器更多的东西。
- `petController.test.ts` 补两条新用例(复用 Phase 5 已经建立的 fake renderer 测试模式):构造/热切换到 `sprite` 类型时 `behavior.kind==='sprite'` 且驱动 `petBrain` 的 `step`;到 `live2d` 类型时 `behavior.kind==='live2d'` 且驱动 `live2dPetBrain` 的 `stepLive2D`,且全程不产生 `moveWindow` 调用(因为 live2d 分支的 `moveX/moveY` 恒为 0)。
- `petBrain.ts`/`petBrain.test.ts` 不改动,现有测试原样保留,回归其为"零变化"。
