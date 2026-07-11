# 点击宠物打断语音 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击宠物(单击或双击均可)立即打断正在播放的语音,不影响文字生成/气泡框内容。

**Architecture:** 在 `src/renderer/main.ts` 现有的 `mouseup` 点击处理分支里,最前面无条件调用已存在的 `pcmPlayer.stop()`。不新增模块、不新增 IPC、不碰后端取消链路——纯粹是给既有点击手势多加一步。

**Tech Stack:** TypeScript(既有 electron-vite/Vitest 工具链),复用 `src/renderer/voice/pcmPlayer.ts` 已有的 `stop()` 方法。

## Global Constraints

- 打断只停音频播放,不影响 LLM 文字生成/气泡框文字——不得调用 `voiceProvider.stop()`/`IPC.CANCEL_CHAT` 那条更重的"取消整条回复"链路。
- 单击开/关对话框、双击 poke 反应这两种既有语义不变,打断只是在原有点击处理最前面多做一步,不替换/不跳过原有逻辑。
- 不新增判断"当前是否正在说话"的状态——`pcmPlayer.stop()` 没有音频在播时本身就是空操作,无条件调用即可。
- 不加视觉/音效反馈,不新增按钮或快捷键。

---

## Task 1: 点击时打断语音播放(`src/renderer/main.ts`)

对应设计文档 `docs/superpowers/specs/2026-07-11-click-pet-interrupt-voice-design.md` 全文。

**Files:**
- Modify: `src/renderer/main.ts:80-88`

**Interfaces:**
- Consumes: 已有的 `pcmPlayer.stop(): void`(定义在 `src/renderer/voice/pcmPlayer.ts:7`,`main.ts:19` 已经 `const pcmPlayer = createPcmPlayer()` 创建好实例,在闭包内直接可用,不需要新的 import)

- [ ] **Step 1: 确认当前代码与预期一致**

打开 `src/renderer/main.ts`,确认 `window.addEventListener('mouseup', ...)` 的处理函数里,"非拖拽点击"分支(`else` 分支)现在长这样(约第 72-89 行):

```ts
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved) {
      window.petApi.dragEnd()
      controller.send('drop')
      controller.syncBounds().catch((err) => console.warn('syncBounds failed', err))
    } else {
      // 单击 → 开/关对话框;双击 → 戳(poke)。用短延时判别,双击时撤销开框
      if (clickTimer !== null) {
        clearTimeout(clickTimer); clickTimer = null
        controller.poke()
      } else {
        clickTimer = window.setTimeout(() => { clickTimer = null; window.petApi.toggleDialog() }, DBLCLICK_MS)
      }
    }
  })
```

如果实际内容与上面不一致(行号漂移、逻辑已变化等),先停下来——不要凭空猜测插入位置,把差异报告给上级。

- [ ] **Step 2: 加打断调用**

把上面的 `else` 分支替换为:

```ts
    } else {
      // 点击(单击/双击均可)先打断正在播放的语音——pcmPlayer.stop() 在没有音频播放时
      // 本身就是空操作,不需要额外判断"是否正在说话"。
      pcmPlayer.stop()
      // 单击 → 开/关对话框;双击 → 戳(poke)。用短延时判别,双击时撤销开框
      if (clickTimer !== null) {
        clearTimeout(clickTimer); clickTimer = null
        controller.poke()
      } else {
        clickTimer = window.setTimeout(() => { clickTimer = null; window.petApi.toggleDialog() }, DBLCLICK_MS)
      }
    }
```

- [ ] **Step 3: typecheck 确认没有引入类型错误**

Run: `pnpm typecheck`
Expected: 无新增报错(`pcmPlayer` 在同一个 `boot()` 函数作用域内已经声明过,`else` 分支本来就在这个闭包里,直接引用即可)。

- [ ] **Step 4: 全量 Vitest 回归确认没有破坏既有测试**

Run: `pnpm vitest run`
Expected: 全部既有用例 PASS(这是 DOM 事件绑定的 renderer 交互代码,本任务不新增 Vitest 用例——`main.ts` 的 `boot()` 直接绑定真实 `window.petApi`/`window.voiceApi`/canvas,项目里同类交互代码走真机验证,不强行 mock 出单元测试)。

- [ ] **Step 5: 真机验证(不可由 Vitest 覆盖,需在实施完成后由用户确认)**

Run: `pnpm dev` 或 `pnpm preview`

Expected 走查清单:
1. 让宠物说一句较长的话(语音朗读中),说到一半时单击宠物本体 → 语音立即停止,气泡框里的文字继续正常输出/完成,不受影响。
2. 语音朗读中双击宠物本体 → 语音同样立即停止,并且照常触发 poke 反应(动画/台词)。
3. 语音没有在播放时单击宠物 → 行为与改动前一致(照常开/关对话框),没有任何异常报错或卡顿。
4. 语音没有在播放时双击宠物 → 行为与改动前一致(照常 poke),没有任何异常。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/main.ts
git commit -m "feat(voice): 点击宠物打断正在播放的语音"
```

---

## Self-Review Notes

- Spec 的"触发方式"(点击本体,单击/双击均可)、"打断范围"(只停音频,不碰文字生成)、"不做的事"(不新增 IPC/不碰 CANCEL_CHAT/不加视觉反馈/不加按钮快捷键)均由 Task 1 的单一改动覆盖,没有遗漏项。
- 无占位符;Step 2 给出完整可粘贴的代码块。
- 类型/接口一致性:`pcmPlayer.stop()` 的名字与签名和 `src/renderer/voice/pcmPlayer.ts:7`、以及 `main.ts:23` 已有的 `pcmPlayer.stop()` 调用完全一致,没有引入新名字。
