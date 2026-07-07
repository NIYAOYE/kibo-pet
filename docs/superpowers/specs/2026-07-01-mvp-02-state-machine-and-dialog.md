# MVP-02 设计文档 · 动画状态机 + 唤出对话框壳

- **日期**: 2026-07-01
- **状态**: 已评审通过(用户认可),待写实现计划
- **范围**: MVP-02(动画状态机 + 全局热键/点击唤出对话框壳;无 LLM,占位闭环)
- **上游**: 产品设计文档 `docs/superpowers/specs/2026-06-26-desktop-pet-agent-design.md` §4(躯壳)、§4.4(状态机)、§5.5(台词库)、§11(安全基线);进度见 `PROGRESS.md`

---

## 1. 目标

在 MVP-01(透明置顶躯壳 + idle + 拖拽移窗 + 托盘 + 点击穿透)基础上,交付:

1. **自主动画状态机**:宠物自己在 `idle ↔ walk` 之间随机游走、长时间无交互后 `sleep`;被拖拽时切 `drag`,放下回 `idle`。
2. **唤出对话框壳**:单击宠物或全局热键 `Ctrl+Shift+Space` 开/关一个**独立置顶小窗**;发送消息走**占位闭环**(无 LLM),并与宠物动画联动(thinking→talk)。
3. **§4.4 预留钩子**:状态机暴露"外部事件驱动状态切换"的入口,供 Phase 2 情绪/事件驱动接入;对话框事件即通过该入口驱动宠物动画。

**明确不做(MVP-02 外):** 真 LLM/agent 回复(MVP-03)、识图/多模态(见 §9)、台词库随机触发的完整落地(§5.5 Phase 2)、纵向移动/跨多显示器游走、开机自启。

---

## 2. 现状与改动边界

MVP-01 已实现(见 `PROGRESS.md` §4):

- `src/shared/petPackage.ts`:`pet.json` 类型 + `frameRect` + `frameDurationMs` + `parsePetManifest`(纯逻辑,已测)。
- `src/shared/ipc.ts`:`IPC` 通道常量 + `PetApi`/`LoadedPet`/`MoveDelta` 类型 + `window.petApi` 声明。
- `src/main/index.ts`:透明置顶窗口 + 托盘 + IPC(`GET_PET`/`MOVE_WINDOW`/`SET_IGNORE_MOUSE`/`QUIT`),全部内联。
- `src/preload/index.ts`:contextBridge 暴露最小 `petApi`。
- `src/renderer/main.ts`:加载宠物 + 播 idle + 拖拽移窗 + 透明区域点击穿透。
- `src/renderer/spritePlayer.ts`:`SpritePlayer`(按 state 名播动画)+ `nextFrameIndex` + `isPetPixel`(已测)。
- `pets/luluka/pet.json`:已含全部 13 个动画(idle/walk-left/walk-right/drag/sleep/greet/thinking/talk/…)。**故 MVP-02 是"接线"而非"造美术"。**

**关键约束(沿用):** 主进程/preload 必须 CJS(不加 `"type":"module"`);跨进程只经 preload 白名单 API;IPC 通道用 `IPC` 常量、不硬编码字符串;纯逻辑 TDD、GUI 真机 `pnpm preview` 验收。

---

## 3. 架构决策

**状态机放 `src/shared` 做纯函数 reducer,渲染进程驱动时钟。**

- "下一步是什么状态/朝哪走/走多远/何时睡"抽成**纯函数 reducer**,无副作用、注入随机源,可 Vitest TDD——贴合本项目"纯逻辑进 shared + 先写测试"约定。
- 渲染进程跑时钟,每 tick 调 `step()`,把返回的 effects 落地成 `player.play(anim)` 与 `petApi.moveWindow({dx})`。
- 走路所需屏幕边界,渲染进程在**走路开始时**向主进程查一次(新 IPC `getWindowBounds`)。
- `step()` 的**事件入口**天然就是 §4.4 要求的"外部事件/情绪驱动"预留接口。

**被否方案(主进程掌管状态机 + 移窗)**:屏幕逻辑虽集中,但状态机与其驱动的动画被 IPC 割裂在两进程,纯逻辑难单测,且与现有"渲染层播动画"结构相悖。

**进程边界总览:**

```
渲染层(宠物窗)                          主进程(shell/)
  SpritePlayer(播帧)                     petWindow / dialogWindow(BrowserWindow)
  PetController(时钟 → step → effects)    hotkeys(globalShortcut)
  petBrain.step()  ← 来自 @shared         tray
        │  moveWindow(dx) ─────────────►  移窗(clamp 在主进程外,边界查询在主进程)
        │  getWindowBounds() ──────────►  返回 workArea + 窗口矩形
        │  toggleDialog() ─────────────►  开/关对话窗
        └─ PET_EVENT ◄─────────────────  messageSent/replyDone/dialogOpen 推给状态机
对话层(对话窗)
  chat UI(输入框 + 消息列表)
        │  chatSend(text) ─────────────►  占位回复(读 lines.json/固定串)
        └─ CHAT_REPLY ◄────────────────  回填对话框 + 触发宠物 thinking→talk→idle
```

---

## 4. 组件设计

### 4.1 纯状态机 reducer — `src/shared/petBrain.ts`(TDD)

**逻辑状态:** `idle | walk | drag | sleep | greet | thinking | talk`。
`walk` 带方向 `dir: 'left' | 'right'`,映射到动画名 `walk-left`/`walk-right`;其余状态名直接对应 `pet.json` 动画键。

**类型草案(以实现为准):**

```ts
export type PetLogicalState = 'idle' | 'walk' | 'drag' | 'sleep' | 'greet' | 'thinking' | 'talk'
export type PetEvent = 'pickup' | 'drop' | 'wake' | 'dialogOpen' | 'messageSent' | 'replyDone'
export interface Bounds { x: number; y: number; width: number; height: number } // 工作区
export interface PetBrainCtx {
  state: PetLogicalState
  dir: 'left' | 'right'
  stateSince: number      // 进入当前状态的时间戳
  idleAccumMs: number     // 无交互累计时长(用于 sleep 判定)
  walkRemainingPx: number // walk 剩余距离
  // …调度所需的内部字段
}
export interface StepInput {
  now: number
  event?: PetEvent
  bounds: Bounds
  windowPos: { x: number; y: number }
  rng: () => number       // 注入随机源,测试可用确定序列
}
export interface StepEffects { animation: string; move?: { dx: number } }
export function initBrain(now: number): PetBrainCtx
export function step(ctx: PetBrainCtx, input: StepInput): { ctx: PetBrainCtx; effects: StepEffects }
```

**自主调度规则(具体阈值在实现/计划期定为常量,便于调):**

- `idle`:进入后随机停留一段(如 2–6s)。到点后按概率:转 `walk`(在工作区内随机选方向 + 目标距离)或继续 `idle`。
- `walk`:每 tick 依步速吐 `move.dx`(方向决定正负),`walkRemainingPx` 递减;走完 or 目标越出工作区边缘 → 回 `idle`。撞边缘时钳制,不走出屏幕。
- `sleep`:`idleAccumMs` 超阈值(如 30–60s 无交互)→ `sleep`。
- 事件(§4.4 钩子)覆盖自主调度:
  - `pickup` → `drag`(清零 idle 累计);`drop` → `idle`。
  - 睡眠中收到任意交互事件(`pickup`/`dialogOpen`/`wake`)→ `wake` → `idle`(可选先播一次 `greet`)。
  - `dialogOpen` → 播一次 `greet` 后回 `idle`(表示"注意到你")。
  - `messageSent` → `thinking`;`replyDone` → 播 `talk` 后回 `idle`。
- **确定性:** 所有随机走 `input.rng`;测试注入固定序列断言状态迁移与 `dx` 序列。

### 4.2 渲染层驱动 — `src/renderer/petController.ts` + `main.ts` 接线

- `PetController` 持有 `SpritePlayer` + `PetBrainCtx`,跑一个固定间隔时钟(如 `setInterval` ~16–33ms 或 rAF)。每 tick:
  1. 取 `now`;若有待处理事件则带上;必要时(walk 开始)已缓存的 `bounds`。
  2. 调 `step()`,拿 `effects`。
  3. `effects.animation` 变了才 `player.play(name)`(避免重复重启动画)。
  4. `effects.move` 存在则 `petApi.moveWindow({ dx })`。
- **交互 → 事件**(改造现有 `main.ts` 的鼠标逻辑):
  - `mousedown` + 移动超阈值(如 >4px)→ 判定拖拽 → 送 `pickup`,拖拽期间沿用现有 `moveWindow`;`mouseup` → `drop`。
  - `mousedown`→`mouseup` 位移 < 阈值且时长短 → 判定**单击** → `petApi.toggleDialog()`。
  - 透明区域点击穿透(`isPetPixel`)逻辑保留不变。
- **走路边界:** `PetController` 在决定要走路的那一刻 `await petApi.getWindowBounds()`,把 `bounds`/`windowPos` 喂给后续 `step()`。(拖拽会改窗口位置,故按需查询而非缓存过久。)

### 4.3 对话框独立窗口 — `src/main/shell/dialogWindow.ts`

- 新建 BrowserWindow:`frame:false`、**`transparent:true`**、圆角 + 阴影靠内部 CSS 面板绘制、`alwaysOnTop:true`、`skipTaskbar:true`、`resizable:false`、**可获焦(不设 ignoreMouseEvents)**。
- 定位:出现在宠物窗旁(读宠物窗当前位置计算,避免遮住宠物)。
- 独立渲染入口 `src/renderer/dialog.html` + `src/renderer/dialog.ts`。含自己的 CSP(与 `index.html` 同基线)。
- 复用同一 preload;preload 依 `location`/初始化参数决定暴露 `petApi` 还是 `chatApi`,或统一暴露一个包含两段的对象(实现期二选一,保持最小暴露面)。
- 开/关:`toggleDialog()` 显示则聚焦、隐藏则 `hide()`(不销毁,保留会话与位置)。

**双态 UI(常态薄 / 展开看全貌):**

- **常态(collapsed,默认):** 小而薄——一条输入条 + 其上方浮**一句最新回复气泡**;右侧一个 ⤢ 展开钮。透明背景,只有面板本身是圆角半透明。**最新回复气泡在显示数秒后(默认约 4s,可调常量)平滑淡出**(CSS transition/opacity),之后常态只剩输入条 + ⤢ 钮;下次收到新回复再淡入。展开态不受此淡出影响(展开态始终显示完整历史)。

  ```
  ╭──────────────────╮
  │ 等我接上大脑~     │   ← 最新回复气泡(仅常态显示最新一条)
  ╰──────────────────╯
  ╭─────────────┬──╮
  │ 说点什么…    │⤢│   ← 输入条 + 展开钮
  ╰─────────────┴──╯
  ```

- **展开(expanded):** 点 ⤢ 切换成完整面板——**滚动的历史消息列表**(用户/宠物气泡)在上,输入条在下,展开钮变 ⤡ 收起。

  ```
  ╭─────────────────────╮
  │ 你: 在吗          ⤡ │   ← 收起钮
  │ 露露卡: 等我接上… │
  │ 你: …             │
  │ …(可滚动历史)     │
  ├─────────────┬───────┤
  │ 说点什么…    │  发送 │
  ╰─────────────┴───────╯
  ```

- **切换机制:** 渲染层维护 `collapsed` 布尔;切换时向主进程发 `DIALOG_SET_SIZE`(见 §5),主进程 `win.setSize(w, h)` 调整窗口高度(常态矮、展开高),渲染层同步换布局。宽度两态可相同。窗口 `resizable:false`,尺寸完全由这两个预设态驱动(不做手动拖拉,契合无边框圆角面板)。
- **常态与展开共享同一会话状态**:切换只换布局与窗口高度,消息列表不清空;常态气泡显示列表里最后一条 `pet` 回复。

### 4.4 触发:单击 + 全局热键 — `src/main/shell/hotkeys.ts`

- 宠物单击 → IPC `TOGGLE_DIALOG` → 主进程 toggle 对话窗。
- `globalShortcut.register('CommandOrControl+Shift+Space', toggle)`;`app.on('will-quit')` 里 `globalShortcut.unregisterAll()`。
- 注册失败(被占用)时记日志、不崩(热键为增强,非必需)。

### 4.5 占位聊天闭环(MVP-02,无 LLM) — `src/main/shell/` 内的临时 stub

**对话记录(transcript)由主进程持有,对话框只是视图**(见 §10 记忆接缝)。主进程维护一个内存数组 `ChatMessage[]` 作当前会话。

- 对话窗**显示**时:主进程经 `CHAT_UPDATE` 把当前 transcript 推给对话框渲染(故重开/reload 不丢已发生的会话)。
- 对话框 `chatSend(text)` →(send)主进程:
  1. 主进程把用户消息 append 进 transcript,`CHAT_UPDATE` 推回对话框(渲染用户气泡)。
  2. 主进程向**宠物窗**推 `PET_EVENT: messageSent`(宠物 → `thinking`)。
  3. 短延迟(如 600–1000ms,可取消)后,取一句**占位台词**:优先读 `pets/luluka/lines.json` 的 `task_done`/`greet` 随机一条;缺失则固定串"(还没接上大脑,等我 MVP-03 再好好聊~)"。
  4. 把宠物回复 append 进 transcript,`CHAT_UPDATE` 推回对话框(渲染回复 + 常态气泡取最后一条 `pet`);向宠物窗推 `PET_EVENT: replyDone`(宠物 → `talk` → `idle`)。
- **明确标注为 stub**:代码注释与文档都写明,这段"取占位台词"在 MVP-03 由真 agent 循环替换(读同一份 transcript);`lines.json` 的正式随机触发在 Phase 2 落地(此处仅借读一条演示联动)。transcript 目前仅存内存、不落盘——持久化/摘要/召回全留 MVP-05。

### 4.6 主进程 shell 抽取(顺带、就地改良)

把窗口/托盘/热键/对话窗从 `src/main/index.ts` 挪进 `src/main/shell/`,对齐已预留的目录结构(见 `src/main/shell/README.md`):

```
src/main/shell/
  petWindow.ts     # 创建/持有宠物透明置顶窗(MVP-01 现有逻辑迁入)
  dialogWindow.ts  # 创建/toggle 对话窗
  hotkeys.ts       # globalShortcut 注册/注销
  tray.ts          # 托盘图标与菜单
  index.ts         # 组装以上,导出给 main/index.ts 调用
```

`src/main/index.ts` 变薄:仅 `app.whenReady()` 里装配 IPC + shell。**不做无关重构**,只搬动已有代码 + 新增对话窗/热键。

---

## 5. IPC 增量(四文件同步:`shared/ipc.ts` · main handler · preload 暴露 · 调用方)

新增通道(名字以实现为准,统一进 `IPC` 常量):

| 通道 | 方向 | 类型 | 用途 |
|---|---|---|---|
| `TOGGLE_DIALOG` | renderer(宠物)→ main | `send` | 单击宠物 → 开/关对话窗 |
| `GET_WINDOW_BOUNDS` | renderer(宠物)→ main | `invoke` | 返回 `{ workArea: Bounds, window: Bounds }`,供走路规划 |
| `CHAT_SEND` | renderer(对话)→ main | `send` | 发送用户消息(主进程 append 进 transcript 并触发占位回复) |
| `CHAT_UPDATE` | main → renderer(对话) | `send`(事件) | 推送当前 transcript 给对话框渲染(对话框显示时、每次消息追加后;为将来流式预留) |
| `PET_EVENT` | main → renderer(宠物) | `send`(事件) | 推 `messageSent`/`replyDone`/`dialogOpen` 给状态机 |
| `DIALOG_SET_SIZE` | renderer(对话)→ main | `send` | 常态/展开切换 → 主进程 `setSize` 调整对话窗高度 |

**聊天消息模型(可扩展形状,为识图预留 —— 见 §9):**

```ts
export interface ChatAttachment { kind: 'image'; /* 预留:dataUrl?/path?/mime? */ }
export interface ChatMessage {
  role: 'user' | 'pet'
  text: string
  attachments?: ChatAttachment[]  // MVP-02 恒为空;识图落地时填充
}
export interface ChatSendPayload { text: string; attachments?: ChatAttachment[] }
```

`PetApi` 扩展 `toggleDialog()` / `getWindowBounds()` / `onPetEvent(cb)`;对话窗侧 `chatApi` 暴露 `send(payload)` / `onUpdate(cb: (msgs: ChatMessage[]) => void)` / `setSize(collapsed)`。所有 IPC handler 校验 payload(§11 安全基线)。

---

## 6. 单元 / 集成边界

- **纯逻辑(Vitest,TDD 先行):** `petBrain.step` / `initBrain`——
  - idle 停留到点后按 rng 转 walk 或续 idle;
  - walk 依方向吐 dx、走完回 idle、撞边界钳制;
  - idle 累计超时 → sleep;
  - 事件:pickup→drag、drop→idle、messageSent→thinking、replyDone→talk→idle、睡眠中交互→wake;
  - 注入固定 rng 断言确定性序列。
- **动画名映射**(walk+dir → walk-left/right)可做纯函数单测。
- **GUI/热键/对话窗/点击穿透**:不写脆弱的 E2E,靠 `pnpm preview` 真机肉眼验收(改躯壳必做)。

---

## 7. 验收标准(真机 `pnpm preview`)

1. 启动后宠物自己会在屏幕上**水平游走**并回到 idle,长时间不管会**睡着**。
2. **拖拽**宠物时切 `drag` 动画,放下回 idle,且不走出屏幕工作区。
3. **单击**宠物弹出对话框(**常态薄条**:输入条 + 最新回复气泡);**再次单击或 `Ctrl+Shift+Space`** 关闭;热键在其他窗口聚焦时也生效。
4. 对话框输入并发送 → 宠物播 `thinking`→`talk`→`idle`,对话框显示一句占位回复。
5. 点 **⤢** 展开成完整面板(滚动历史),点 **⤡** 收回常态薄条;切换时窗口高度平滑伸缩,会话不丢。
6. 拖拽与单击不误触(拖动不弹框、单击不移窗)。
7. 透明区域点击仍穿透到下层窗口(MVP-01 行为不回归)。
8. 托盘退出正常,退出时全局热键被注销(不残留)。

---

## 8. 顺带清理(PROGRESS.md §7 中与本次相关的 Minor,可选)

- `spritePlayer.ts` 每帧重设 `canvas.width/height` → 帧尺寸恒定时提到 `play()` 做一次(本次要频繁切状态,收益变大)。
- `petLoader.test.ts` 用 `resolve(__dirname)` 作"缺失 pet.json"目录偏脆 → 改明确不存在路径。
- (可选)`frameDurationMs`/`parsePetManifest` 对 `fps=0`/`durations` 含 0/NaN 的防御。

不阻塞主线;计划期决定是否纳入。

---

## 9. 识图预留(**非 MVP-02 实现**,仅记方向 + 形状对齐)

用户后续想要两类识图,均落在 MVP-03/04+,MVP-02 只做零成本形状对齐、不加实现逻辑:

1. **用户丢图给它看**(往对话框粘贴/拖放图片,让宠物读图回答)
   - 真接口在:**对话框输入支持附件** + **Provider 多模态消息**(MVP-03,§5.2)。
   - MVP-02 预留:聊天消息模型 `ChatMessage.attachments?` 与 `ChatSendPayload.attachments?` 已留可选字段(§5),将来加图是**纯增量**,不改契约。MVP-02 恒为空、UI 不渲染附件。
2. **宠物看桌面 / 截屏**(截取当前屏幕并理解)
   - 真接口在:一个**屏幕捕获 tool**(主进程 `desktopCapturer`,与 `web_search` 同层,属工具系统)+ 多模态 Provider(MVP-04+)。需独立 IPC/工具与**权限告知**(§11.2)。
   - MVP-02 **完全不碰**(不建投机接口,遵 YAGNI)。

---

## 10. 记忆系统接缝(**非 MVP-02 实现**,仅把数据归属放对)

MVP-02 不实现分层记忆(那是 MVP-05:短期对话窗 + 滚动工作记忆摘要 + 结构化事实库 + 本地向量库)。但它碰到一个决定"记忆能否干净插入"的接缝——**对话记录(transcript)的归属**。

**决策:transcript 由主进程持有,对话框只是视图(§4.5)。** 依据产品设计文档 §5.4,每次对话的 system prompt = `[人设] + [召回的长期记忆] + [工作记忆摘要] + [当前对话窗口]`,其中"当前对话窗口"就是短期记忆本身,而记忆系统/agent 循环都住主进程(§3、`src/main/memory`)。故对话记录须待在 IPC 边界的主进程侧,后续接记忆才无需搬家。

**各记忆部件将来如何挂上(MVP-03/05,非本次):**

| 记忆部件(设计文档 §7) | 挂接点 | 阶段 |
|---|---|---|
| 短期:当前对话窗口 | **即主进程持有的 transcript 本身** | 已在 MVP-02 放对侧 |
| 短期:滚动工作记忆摘要 | 对 transcript 超长时滚动总结 | MVP-05 |
| 长期:结构化事实库 + 本地向量库 | 从 transcript 抽取事实、落盘、RAG 召回 | MVP-05 |
| §5.4 prompt 组装消费"对话窗口" | agent 循环读同一份 transcript | MVP-03 |

**MVP-02 坚决不做(YAGNI):** transcript 仅存内存、不落盘;无摘要、无向量、无事实抽取、无 `schemaVersion`、无可移植 `memory/` 目录。只保证归属正确,别的一概留后。

---

## 11. 安全基线复核(§11)

- 新对话窗沿用渲染安全三件套:`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`;自带 CSP。
- 新增 IPC 全部**校验发送方与 payload**;不接受任意路径/命令。占位回复只读固定的 `pets/luluka/lines.json`,路径写死、不接受渲染层传入路径。
- 全局热键失败不崩;退出注销,避免残留占用。
- 主进程仍只做轻量编排;占位延迟用可取消的定时器,不阻塞窗口/热键。

---

## 12. 交付物清单

- 新增:`src/shared/petBrain.ts`(+ `petBrain.test.ts`)、`src/renderer/petController.ts`、`src/renderer/dialog.html`、`src/renderer/dialog.ts`、`src/main/shell/{petWindow,dialogWindow,hotkeys,tray,index}.ts`。
- 修改:`src/shared/ipc.ts`(通道 + 类型)、`src/preload/index.ts`(暴露)、`src/renderer/main.ts`(接线状态机 + 单击/拖拽区分)、`src/renderer/spritePlayer.ts`(切状态优化)、`src/main/index.ts`(变薄)、`electron.vite.config.ts`(renderer 加 `dialog.html` 第二入口)。
- 文档:完成后更新 `PROGRESS.md`(MVP-02 勾选 + 现状)。
```
