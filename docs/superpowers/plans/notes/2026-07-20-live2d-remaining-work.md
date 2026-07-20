# Live2D 呈现改造 — 剩余任务清单

> 更新时间:2026-07-20。目的:把整个 8 阶段 Live2D 改造(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)截至目前"做完了什么 / 还剩什么"汇总到一处,供后续会话或用户直接对照执行,不必再翻散落在各 commit/ledger/memory 里的记录。

## 总览进度

| 阶段 | 状态 |
|---|---|
| Phase 0:GPU reboot-degrade | 代码基本完成 + 真机验证过,**未合并进 main**,需 reconcile |
| **Phase 1:Electron 31→43 升级 + 全回归** | **代码+自动化完成,已合并 `main` 并推送 `origin/main`(`3b1f8bb`)。真机 GUI/安装验收待用户** |
| Phase 2:宠物包 v2 + 导入器 + 资源协议 | 未开始(计划未写) |
| Phase 3:PetRenderer 抽象 + 精灵兼容驱动 | 未开始 |
| Phase 4:PixiJS/Live2D 最小加载 | 未开始(依赖引擎已克隆待 spike,见下) |
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

### 1.3 GPU 双模式回归(阻塞于 Phase 0 reconcile,见下)

- [ ] Phase 0 合并后,补做硬件加速实验开关模式下的完整回归(本阶段只验证了默认软件渲染模式)

完整过程记录:`docs/superpowers/plans/notes/2026-07-20-phase1-baseline.md`;实施计划:`docs/superpowers/plans/2026-07-20-live2d-phase1-electron-upgrade.md`。

---

## 2. Phase 0(GPU reboot-degrade)——待办

- worktree `.claude/worktrees/gpu-accel-reboot-degrade`(分支 `worktree-gpu-accel-reboot-degrade`,HEAD `66a0cda`)代码基本完成、**用户真机验证过**:新增 `src/shared/gpuBootDecision.ts`+test、设置页"尝试启用硬件加速渲染(实验性)"复选框、`main/index.ts` 接入 GPU 启动决策 + reboot-degrade(默认仍软渲染,勾选才走重启升级 + 启动标记文件兜底崩溃)。
- **该 worktree branch 早于 2026-07-20 的"对话框重做 + 宠物热切换"合并**,已与当前 `main` 分叉(diff 显示它缺 `petSession.ts`、双栏对话框等)。
- [ ] **待办:reconcile 该 worktree 到当前 main,解决分叉,合并进 main。** 这是 Live2D 60FPS WebGL 目标的硬前提(全项目当前仍是 `app.disableHardwareAcceleration()` 静态软渲染,PixiJS WebGL 模型跑不到 60FPS)。
- 合并后回来补 Phase 1 的 GPU 双模式回归(见上 §1.3)。

---

## 3. Phase 2-8——规划阶段的已知隐患(写 plan 前必须处理)

审查 2026-07-20 设计文档(`docs/superpowers/specs/2026-07-20-live2d-renderer-design.md`)时发现、尚未被任何计划覆盖的问题,写后续 plan 时需处理:

1. **🟠 引擎 API 未做深度验证**:`untitled-pixi-live2d-engine@1.3.5` 已克隆到 `D:\LProject\claude_Project\untitled-pixi-live2d-engine`(peer 锁 `pixi.js@^8.13.1`+`@pixi/sound`,带 `cubism/`+`Core/`,基础存在性已确认)。**Phase 4 动手前必须先做 API spike**:Motion Group/HitArea/参数写入/生命周期的真实调用方式,不能照抄设计文档假设的接口形状。
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

1. **Phase 0 reconcile**(阻塞 Phase 1 的 GPU 双模式回归 + 后续所有 Live2D 渲染阶段)
2. 用户完成 §1 的 Phase 1 真机验收清单
3. 就绪后,针对 Phase 2(宠物包 v2 + 导入器 + 资源协议)走 brainstorming → writing-plans 流程,写入上面 §3 的隐患清单
