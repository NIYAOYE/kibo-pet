# MVP-10 提醒 / 待办 设计

> 2026-07-04 · brainstorming 定稿。承接 ROADMAP.md 待做项 **②提醒 / 定时 / 待办**。
> 前置:MVP-08(文字加工助手)确立的"注入式 Agent 工具 + toolRegistry"机制;MVP-06 的可移植宠物包 + IPC 校验;MVP-04 的 agentLoop 回灌循环。
> 本 MVP 独立成一条链(brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch)。

## 0. 一句话

给桌宠加"主动提醒 + 待办清单"能力:用户用自然语言让宠物记提醒/待办(Agent 工具),也可在一个常驻**待办面板**里手动增删勾选;到点时宠物**主动跳出来**——系统通知 + greet 动画 + 气泡 + 自动弹开面板高亮。全本地、零外部依赖。

## 1. 设计决策(brainstorming 结论)

| 维度 | 决定 | 理由 |
| --- | --- | --- |
| 交互形态 | **对话(Agent 工具)+ 独立待办面板** | 兼顾"桌宠原生"的自然语言创建与"随时可见/可手动操作"的清单 |
| 数据模型 | **统一为"待办项" TodoItem**;`dueAt` 有值即为提醒 | 提醒=带到期时间的待办,倒计时=相对时间算出的 `dueAt`,一套数据/工具/面板 |
| 重复提醒 | **只做一次性**(每条响一次) | YAGNI,调度器只需一个时间戳;循环留作后续单独 MVP |
| 到点行为 | **系统通知(OS Toast)+ 宠物动画/气泡 + 自动弹开面板高亮**(三件套) | 最强"主动提醒"体感 |
| 过期(关闭期间错过) | **启动时补提醒一次**,面板标"已过期" | 不丢事,符合直觉;多条合并 |
| 存储位置 | **全局 `userData/todos.json`**(非 per-pet) | 待办属于用户而非宠物皮肤,换宠物不该丢待办(刻意区别于 MVP-06 的 per-pet 记忆) |
| 提醒动画 | **复用现有 `greet` 动画**,不画新精灵行 | 零资产工作;luluka 图集无空行 |

## 2. 数据模型 — `src/shared/todo.ts`(纯逻辑 + 单测)

跨进程契约,走 `@shared/*` 别名,主/渲染/工具/测试共用。

```ts
export interface TodoItem {
  id: string          // 生成的唯一 id(不引入依赖:时间戳 + 随机后缀)
  title: string
  createdAt: number   // epoch ms
  dueAt: number | null   // null = 无提醒的纯待办;有值 = 到点提醒
  done: boolean
  doneAt: number | null
  firedAt: number | null // 提醒已响过的时间戳;防重复响 + 面板标"已提醒/已过期"
}

export interface TodoFile { version: number; items: TodoItem[] }
export const TODO_SCHEMA_VERSION = 1
```

纯函数(全部单测):
- `sortTodos(items)`:过期未完成置顶 → 按 `dueAt` 升序 → 无 `dueAt` 的纯待办垫底;已完成沉底。
- `isOverdue(item, now)`:`!done && dueAt != null && dueAt <= now`。
- `classify(item, now)`:`'done' | 'overdue' | 'upcoming' | 'plain'`,面板与文本工具复用。
- `nextDueAt(items, now)`:最近一条未完成未响且 `dueAt > now` 的时间戳(调度器用),无则 `null`。
- `overdueUnfired(items, now)`:已过期、未完成、`firedAt == null` 的项(启动补提醒选取)。

`title` 上限常量(如 500 字)在此声明,面板/校验/工具共用。

## 3. 存储 — `src/main/todos/todoStore.ts`

全局 `userData/todos.json`,原子写(`.tmp` + `renameSync`),完全照 [`src/main/config/settings.ts`](../../../src/main/config/settings.ts) 的 load/save 套路。

- `load(file): TodoFile` — 解析失败 / 校验失败 → 退化 `{version, items: []}`(同 `loadSettings`)。归一化每条(丢弃缺 `id`/`title` 的坏项,补默认布尔/时间戳)。
- 变更方法:`add(item)`、`update(id, patch)`、`toggleDone(id, now)`、`remove(id)`、`markFired(id, now)`、`list()`。每次变更后 `save`。
- **单一数据源**:面板与 Agent 工具都经此 store;它对外暴露一个 `onChange` 订阅,shell 用来 ①推面板更新 ②重算调度器。

纯归一化/变更逻辑用临时目录单测。

## 4. 调度器 — `src/main/todos/scheduler.ts`

主进程模块。持**一个** `setTimeout`,指向 `nextDueAt` 的最近一条。

- 依赖注入:`now()`、`setTimeout`/`clearTimeout`(测试可替身)、`store`、`onFire(item)` 回调。
- `rearm()`:清旧定时器 → 算 `nextDueAt` → 若有,`delay = due - now`;**Node 定时器上限 ~2^31 ms(~24.8 天)**,超出则设封顶定时器(到点仅重新 `rearm`,不误触发);到点触发 `fire(item)`。
- `fire(item)`:`store.markFired(id, now)` → `onFire(item)` → 再 `rearm()`(取下一条)。
- `start()`:**启动补提醒** —— 取 `overdueUnfired(items, now)`,逐条 `markFired` 并交给 `onFire`(shell 侧合并成一条通知);随后 `rearm()`。
- store `onChange` → `rearm()`(增删改后即时校准)。

纯逻辑(最近项选取、补提醒选取、封顶续弦判定)单测;真实定时器交互用注入的假 timer 测。

## 5. 到点行为 — 接在 `shell/index.ts` 的 `onFire`

`onFire(item)`(单条)与启动补提醒批量,统一走一个 shell 侧处理器:

1. **系统通知**:`new Notification({ title: '⏰ 提醒', body: item.title }).show()`(Electron 主进程 `Notification`;Windows 需 `app.setAppUserModelId`,MVP-06 打包已具备 appId,确认即可)。多条过期合并为 `title: '⏰ N 条提醒已过期'`。
2. **宠物动画 + 气泡**:`emitPetEvent('remind')`。在 [`src/shared/petBrain.ts`](../../../src/shared/petBrain.ts) 的 `PetEvent` 增加 `'remind'`,`applyEvent` 里映射为进入 `greet`(复用动画,`idleAccumMs=0`)。对话框常态气泡推提醒文字(复用 `pushStatus` 或追加一条 `role:'pet'` 系统气泡——落 transcript 与否见 §8 决策:不落 transcript,仅 UI 展示)。
3. **自动弹开面板 + 高亮**:打开待办面板窗口,`TODO_FIRED` 推该条 id 让面板高亮。

## 6. Agent 工具 — `src/main/tools/todoTools.ts`(注入式,注册进 [`chat.ts`](../../../src/main/shell/chat.ts))

照 MVP-08 clipboardTools 的注入式风格(不 import electron,收 store 门面),每次发送在 `createToolRegistry([...])` 里挂上:

- `add_todo({ title: string, dueAt?: string })` —— `dueAt` 为 ISO-8601 本地时间字符串(可省 = 纯待办)。解析成 epoch ms;非法/过去时间 → **错误回灌不抛**(守 toolRegistry 契约),提示 LLM 换个时间。返回确认文案含格式化后的本地时间。
- `list_todos()` —— 返回当前未完成项(标注即将到期/已过期)的文本清单。
- `complete_todo({ id?: string, title?: string })` —— 勾选完成;`title` 模糊匹配到唯一项才动,否则回灌"请明确是哪条"。
- `remove_todo({ id?: string, title?: string })` —— 删除,同上匹配策略。

**当前时间注入**:让 LLM 能把"20分钟后""今天下午3点"算成绝对 `dueAt` —— 在 [`promptAssembler`](../../../src/main/agent/promptAssembler.ts) 的 system 段注入一行"当前时间:<本地 ISO>"。工具内自身也用注入的 `now()` 做过去时间校验。

工具变更经同一个 `todoStore` → 触发 `onChange` → 面板更新 + 调度器重算(与面板手动操作同路径)。

## 7. 待办面板 — `renderer/todoPanel.{html,ts}` + `shell/todoWindow.ts`

新 `BrowserWindow`,复用 dialog/settings 的 `preload` + `contextBridge` 模式与安全基线(`contextIsolation/sandbox/nodeIntegration` 同现有窗口;`todoPanel.html` 内联 CSP)。

- 入口:托盘菜单新增"待办清单";到点由 `onFire` 自动弹。
- 列表按 `sortTodos` 渲染:每行 = 勾选框(完成)、标题、到期时间(相对如"20 分钟后"+ 绝对)、删除按钮;过期项红色标记,已响项标"已提醒"。
- 顶部 `+ 添加` 内联表单:标题 + 可选日期时间(HTML `datetime-local`)→ 走 `ADD_TODO`,**不经 LLM 手动增**(选"面板"形态的价值所在)。
- 时间格式化用极简本地纯函数(相对时间),避免引入 date 库(零新依赖,延续项目习惯)。

## 8. IPC 契约 — 四文件锁步(照 CLAUDE.md)

在 [`src/shared/ipc.ts`](../../../src/shared/ipc.ts) 增通道常量 + `TodoApi` 类型 + `window.todoApi` 全局声明;主进程注册 handler;`preload/index.ts` expose;渲染层调用。

新增通道:
- `LIST_TODOS`(handle→`TodoItem[]`)、`ADD_TODO`、`TOGGLE_TODO`、`REMOVE_TODO`(handle,改后返回新列表)
- `TODO_UPDATE`(主→面板推全量列表)、`TODO_FIRED`(主→面板推高亮 id)、`OPEN_TODO_PANEL`

`src/shared/ipcValidation.ts` 给 `ADD_TODO`(标题非空且 ≤ 上限、`dueAt` 缺省或有限数值/合法字符串)、`TOGGLE_TODO`/`REMOVE_TODO`(id 为非空字符串)加校验,非法直接丢弃(延续 MVP-06 §11.2)。

**决策:提醒气泡不落 transcript**(仅 UI 展示,与 MVP-08 快捷动作"不进记忆"一致——提醒不是对话轮次)。待办数据只在 `todos.json`,不进对话历史/记忆库。

## 9. 测试 & 验收

- **TDD 纯逻辑**:`todo.ts`(排序/过期/分类/nextDueAt/overdueUnfired)、`scheduler`(最近项、补提醒选取、封顶续弦,用假 timer)、`todoStore`(临时目录 load/save/归一化/变更)、`todoTools`(add/list/complete/remove happy + 非法 dueAt/过去时间/歧义匹配回灌)、`ipcValidation` 新增 payload。
- **人工真机验收**(项目惯例,无 GUI 自动化驱动):面板增删勾选、自然语言创建提醒、到点三件套(通知/动画气泡/面板弹开高亮)、关应用错过后重启补提醒、换宠物待办仍在。见 writing-plans 阶段的验收清单。

## 10. 非目标(YAGNI / 后续)

- 循环/重复提醒(每天/每周);贪睡(snooze);提醒声音;提醒通知的开关设置项(默认全开,需要再加设置)。
- 待办分组/标签/优先级/子任务。
- 跨设备同步。

## 11. 影响面小结(改动清单)

- 新增:`src/shared/todo.ts`(+test)、`src/main/todos/{todoStore,scheduler}.ts`(+test)、`src/main/tools/todoTools.ts`(+test)、`src/main/shell/todoWindow.ts`、`renderer/todoPanel.{html,ts}`。
- 改:`src/shared/petBrain.ts`(+`'remind'` 事件)、`src/shared/ipc.ts`、`src/shared/ipcValidation.ts`、`src/preload/index.ts`、`src/main/shell/{index,tray,chat}.ts`、`src/main/agent/promptAssembler.ts`(注入当前时间)。
- 零新第三方依赖。
```
