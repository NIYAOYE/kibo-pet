# Live2D 呈现改造 — 剩余任务清单

> 更新时间:2026-07-21。目的:把整个 8 阶段 Live2D 改造(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)截至目前"做完了什么 / 还剩什么"汇总到一处,供后续会话或用户直接对照执行,不必再翻散落在各 commit/ledger/memory 里的记录。

## 总览进度

| 阶段 | 状态 |
|---|---|
| Phase 0:GPU reboot-degrade | **已 reconcile 并合并进 `main`(`01db719`,squash 单提交,本地未推送)** |
| **Phase 1:Electron 31→43 升级 + 全回归** | **代码+自动化完成,已合并 `main` 并推送 `origin/main`(`3b1f8bb`)。真机 GUI/安装验收待用户** |
| Phase 2:宠物包 v2 + 导入器 + 资源协议 | 未开始(计划未写) |
| Phase 3:PetRenderer 抽象 + 精灵兼容驱动 | 未开始 |
| Phase 4:PixiJS/Live2D 最小加载 | 本体未开始;**前置真实模型加载 spike 已完成并真机验证,结论见 spec §17** |
| Phase 5:动态窗口/锚点/命中/无闪烁热切换 | 未开始 |
| Phase 6:鼠标追踪/口型/设置预览 | 未开始 |
| Phase 7:安全/恢复/性能/真机验收 | 未开始 |
| Phase 8:Live2D 发布许可 + 公开包 | 未开始(许可审核是外部流程,非代码任务) |

---

## 1. Phase 1(本次已完成)——仍需用户做的事

代码/自动化部分已 100% 完成并合并推送(`main` @ `3b1f8bb`,含一次 push 后修的 `electron-builder@26.x` 打包 yallist 版本冲突坑,见 README「打包构建说明」)。**以下必须真机人工验收,agent 会话无法自动化**:

### 1.1 GUI 走查清单

- [ ] 透明置顶窗渲染 luluka + idle 动画(冒烟测试只确认窗口存在,未确认内容正确渲染)
- [ ] 点击穿透:透明区域点击穿透、宠物像素上不穿透
- [ ] 拖拽移窗:跟手、跨屏/不同 DPI 不漂移
- [ ] 托盘:右键菜单、退出;任务栏不显图标
- [ ] 全局热键呼出/关闭对话框
- [ ] 设置窗、聊天流式回复、Markdown 渲染、来源链接外开
- [ ] 气泡窗跟随 + 自适应高度
- [ ] 待办面板增删改 + 到点提醒
- [ ] 截屏 + 桌面控制(click_at/type_text/focus_window 实际生效、提示条显示、人工接管中断)
- [ ] 浏览器控制(Playwright 隔离 profile)
- [ ] 语音 Sidecar 实际发声 + 切宠物端口释放重启
- [ ] 图像往返:png/jpg 识图、宠物头像、托盘图标
- [ ] **v43 dialog 默认目录变化**:选图/导入宠物文件夹/选语音安装路径/语音运行时导出压缩包,默认目录变 Downloads——确认可接受(非破坏性 UX 变化,不是 bug)

### 1.2 安装包验收

- [ ] 在 C: 和 D: 各装一次 `dist/Kibo Setup 0.0.1.exe` 并运行,确认:宠物渲染/托盘/对话/记忆落盘(`%APPDATA%\Pet-Agent\...`)/编辑 persona 生效/拷走宠物文件夹可移植/卸载不丢数据
- [ ] **尤其确认不复现 MVP-06 的打包秒退**(GPU 子进程 `0xC0000135` 崩溃根因,当时靠 `app.disableHardwareAcceleration()` 修复;新 Electron/Chromium 的 GPU 子进程行为可能与 31 不同,若崩溃按 WER LocalDumps → minidump 解析法重新诊断,详见记忆 `packaged-gui-gpu-crash`)
- [ ] E: 盘符(非标准 ACL)已知会触发该崩溃,用户已接受装 C:/D:,本阶段不特别验证 E:

### 1.3 GPU 双模式回归(已完成)

- [x] 硬件加速实验开关模式下的完整回归——2026-07-20 用户真机验证通过(happy path + 模拟崩溃自愈路径均符合预期)。

完整过程记录:`docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md`;实施计划:`docs/superpowers/plans/2026-07-20-live2d-phase1-electron-upgrade.md`。

---

## 2. Phase 0(GPU reboot-degrade)——已 reconcile

- 2026-07-20:用 `git merge --squash worktree-gpu-accel-reboot-degrade`(12 个提交,含已废弃的 overlay-render-spike 真机结论记录)一次性解决与 main 的分叉(唯一重叠文件 `chat.test.ts` 无重叠行,无冲突),squash 成单提交 `01db719` 后 fast-forward 合并进 `main`。typecheck 通过,796/796 测试通过。**本地已合并,尚未 push 到 `origin/main`。**
- 内容:新增 `src/shared/gpuBootDecision.ts`+test、设置页"尝试启用硬件加速渲染(实验性)"复选框、`main/index.ts` 接入 GPU 启动决策 + reboot-degrade(默认仍软渲染,勾选才走重启升级 + 启动标记文件兜底崩溃)。`AppSettings.schemaVersion` 13→14。
- 原 worktree(`.claude/worktrees/gpu-accel-reboot-degrade`)已清理(`git worktree remove` + 删除分支)。
- [x] 已 push 到 `origin/main`(`01db719`+`3c4535b`)。
- [x] Phase 1 的 GPU 双模式回归(见上 §1.3)已完成。

---

## 3. Phase 2-8——规划阶段的已知隐患(写 plan 前必须处理)

审查 2026-07-20 设计文档(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)时发现、尚未被任何计划覆盖的问题,写后续 plan 时需处理:

1. ~~🟠 引擎 API 未做深度验证~~ **✅ 已完成(2026-07-21 真实模型加载 spike)**:`Live2DModel.from()`/`hitTest()`/参数读写全部按假设的接口形状工作,但发现三处必须处理的真实坑——(a) 必须用 `untitled-pixi-live2d-engine/cubism` 子路径,不能用默认导出(会背上不需要的 Cubism 2 legacy 依赖);(b) Live2D 官方 Cubism Core 运行时不通过 npm 分发,需单独下载,直接印证了下面 Phase 8 隐患是真实的;(c) `untitled-pixi-live2d-engine@1.3.5` 和最新官方 Cubism Core 5 之间有一处版本不兼容(`drawables.renderOrders` 字段访问方式变了),已验证一个运行时 patch 能绕过,但 Phase 4 正式做之前要确认是升级引擎版本还是固定兼容的 Core 版本。另外发现贴图尺寸对帧率有实测 2-3 倍的影响(见下条)、购买模型可能自带需要额外处理的防盗版水印保护。完整结论见 `docs/superpowers/specs/2026-07-20-live2d-renderer-design.md` §17,过程记录见 `docs/superpowers/plans/2026-07-20-live2d-phase4-prespike.md`。
2. **🟠 情绪状态凭空发明**:spec §4.1 的 `stateMap` 键列表里 `happy/sad/cry/surprised/love` 在当前代码里没有任何产出(`src/shared/petBrain.ts` 的 `PetLogicalState` 只有 `idle/walk/drag/sleep/greet/thinking/talk`)。**Phase 4/5 写 plan 时**:情绪态应 scope down 为"有对应 Expression 就用、否则回 idle",不新造状态机分支。另需解决 `setFacing()` 与 `walk-left/walk-right` stateMap 键重复表达朝向的歧义。
3. **🟡 `PET_WINDOW_SIZE`(256×288)被写死在多处**:`src/main/shell/index.ts:651-655/665/671/673` 的 moveWindow 边界夹取逻辑 + `petController.ts` 默认值。**Phase 5 动态窗口改动面比设计文档描述的大**,且窗口尺寸只能在加载/切换时改一次,不能进每帧循环(参考记忆 `electron-isvisible-setresizable-drift` 的 `setResizable` 抖动教训)。
4. **prepare-commit 热切换需要新 IPC**:当前 `PET_CHANGED`([src/shared/ipc.ts](src/shared/ipc.ts))是单向无回执推送,spec §11 的"旧模型显示中加载新模型、完成后再提交"需要新增 renderer→main 的"模型就绪"ACK 通道。
5. **语音固定端口 × 重叠热切换需要串行化**:视觉模型可以重叠加载,但 `petSession.ts` 的语音 sidecar 用固定端口,必须严格"先拆旧再起新",不能像视觉那样重叠。
6. **`LoadedPet`/`loadPet` 的 data-URL 内嵌是跨进程契约改动**:拓宽成 sprite/live2d 判别式需要同步改 `ipc.ts`/`main`/`preload`/`renderer` 四件套。
7. **`.staging` 目录需要排除出 `petCatalog.ts` 的 `listPets` 扫描**。
8. **气泡锚点**:当前贴宠物窗口上沿([bubbleWindow.ts](src/main/shell/bubbleWindow.ts)),spec 的 `bubbleAnchorX/Y` 要把锚点数据从 manifest thread 到主进程的 `bubblePlacement`。

详细审查记录:`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md` 的审查结论(本次会话内已口头交付给用户,未单独存档为文档——如需要可整理成独立审查报告)。

---

## 下一步建议

1. ~~Phase 0 reconcile~~ **已完成**,已 push。
2. ~~Phase 1 真机验收清单(含 GPU 双模式回归)~~ **已完成**。
3. ~~Phase 4 前置真实模型加载 spike~~ **已完成**(结论见 spec §17)。收尾:删除 `scripts/live2d-spike/` 一次性诊断代码、决定 worktree `live2d-phase4-prespike` 的合并/清理方式、决定是否 push 剩余的本地 spec/plan/结论提交到 `origin/main`。
4. 就绪后,针对 Phase 2(宠物包 v2 + 导入器 + 资源协议)走 brainstorming → writing-plans 流程,把上面 §3 的隐患清单(含本次 spike 新确认的三条:引擎版本兼容性、Cubism Core 运行时获取、防盗版水印场景)一并纳入设计范围。
