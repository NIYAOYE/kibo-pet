# Pet-Agent — 进度与交接文档

> 更新时间:2026-07-01 · 状态:**MVP-03 已完成、真机验收通过**
> 这份文档给"新开的对话/新会话"快速接手用。先读这里,再按需展开下方链接的文档。

---

## 1. 一句话现状

一个 Shimeji 风格的**桌面宠物 Agent**(Electron + TypeScript)。**MVP-03(对话式 Agent 内核:可插拔 LLM Provider〔Fake/Anthropic/OpenAI 兼容〕+ 密钥 safeStorage 加密 + 首启设置窗 + persona 组装 + Agent 循环护栏 + 逐字流式回复)已做完、真机验收通过**。下一步是 MVP-04(web_search 工具 + Skill 加载器)。

## 2. 怎么跑起来

```bash
pnpm install
pnpm dev          # 开发模式(HMR)。正常终端可用
# 或:构建后预览(更接近打包版,启动更稳)
pnpm build && pnpm preview

pnpm test         # 单元测试(当前 47/47 通过)
pnpm typecheck    # 类型检查
```

**启动看到什么**:透明置顶小窗口显示宠物 **luluka**(魔法少女 chibi),播 idle 动画,可拖拽移动,系统托盘右键可退出,任务栏不显图标,宠物透明区域点击会穿透到下层窗口。

> ⚠️ **环境坑(仅限某些沙箱/CI shell)**:若 shell 里设了 `ELECTRON_RUN_AS_NODE=1`,Electron 会以纯 Node 跑并崩溃(`require('electron').app` undefined)。解决:`unset ELECTRON_RUN_AS_NODE` 后再启动。普通开发终端一般没有此变量。
> 另:沙箱内 `pnpm dev` 偶见 `localhost:5173 ERR_CONNECTION_REFUSED`(dev server 网络/时序),用 `pnpm preview` 可绕开。

## 3. 技术栈与约定

- **pnpm** · **Electron**(CJS 主进程/preload,**不要**加 `"type":"module"`) · **electron-vite** · **TypeScript(strict)** · **Vitest** · electron-builder(打包,MVP-06 才用)
- 三进程入口:`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html`
- 路径别名 `@shared/*` → `src/shared/*`
- 提交粒度:每个任务一提交;TDD(纯逻辑先写测试)

## 4. 代码地图(已实现)

```
src/
  shared/     petPackage.ts(pet.json 类型 + frameRect + frameDurationMs + parsePetManifest;含测试)
              ipc.ts(IPC 通道常量 + PetApi/ChatApi/SettingsApi 等类型 + 三 window.* 全局声明)
              petBrain.ts(纯状态机 reducer:idle/walk/drag/sleep/greet/thinking/talk + applyEvent;含测试)
              llm.ts(MVP-03:跨进程 LLM 纯类型 + 预设 PRESETS + DEFAULT_SETTINGS〔默认 claude-haiku-4-5〕)
  main/       petLoader.ts(读 pet.json + 把 spritesheet 读成 data URL;含测试)
              index.ts(应用入口 → startShell)
              providers/   (MVP-03:llmProvider 接口 + fakeProvider〔含测试〕+ anthropicProvider + openaiCompatProvider + createProvider 工厂)
              agent/       (MVP-03:promptAssembler〔persona+对话窗口→system/messages,含测试〕+ agentLoop〔流式/取消/超时护栏,含测试〕+ testConnection)
              persona/     (MVP-03:personaLoader — persona.md 分块解析 + 缓存,含测试)
              config/      (MVP-03:settings〔原子写+schemaVersion,含测试〕+ secrets〔safeStorage 加密,可注入,含测试〕)
              shell/       (窗口/托盘/热键 + chat〔接 agent 循环:流式/取消/未配置降级到设置〕+ dialogWindow + settingsWindow〔首启设置窗〕+ 全部 IPC 注册)
  preload/    index.ts(contextBridge 暴露 petApi / chatApi〔含流式 onStream/onDone/onError+cancel〕/ settingsApi)
  renderer/   index.html(含 CSP)
              main.ts(启动加载宠物 + 播 idle + 拖拽移窗 + 透明区域点击穿透)
              spritePlayer.ts(精灵动画播放器 + nextFrameIndex + isPetPixel 命中测试;含测试)
              petController.ts(自主行为控制器:基于 petBrain 状态机驱动游走/睡眠/动画切换)
              dialog.ts / dialog.html(对话框:常态薄条〔气泡〕+ 展开双态 + 逐字流式渲染;样式内联于 html)
              settings.ts / settings.html(MVP-03:首启/设置窗 — 预设/baseURL/model/key + 测试连接)
pets/luluka/  宠物包(pet.json + spritesheet.webp + persona.md + lines.json + voice/)  ← 注意:被 .gitignore 忽略,仅在磁盘
tools/hatch-desktop-pet/   资产生成工具(Python,改编自 hatch-pet;生成 8×13 精灵图集 + pet.json)
docs/         设计与计划文档  ← 注意:docs/* 被 .gitignore 忽略,仅在磁盘
```

> MVP-03 依赖:`@anthropic-ai/sdk` + `openai`(官方 SDK,主进程/preload 经 electron-vite `externalizeDepsPlugin` 外置,不打进 bundle)。API key 只经 `safeStorage` 加密落盘,绝不进日志/settings.json;Provider 与 key 只在主进程,渲染层零接触。

## 5. 关键文档(部分被 gitignore,仅在磁盘,新会话直接读路径即可)

- 产品设计文档:`docs/superpowers/specs/2026-06-26-desktop-pet-agent-design.md`(架构、§4 躯壳、§5 内核/人设/台词/边界、§7 记忆、§11 安全基线)
- MVP-01 计划:`docs/superpowers/plans/2026-07-01-mvp-01-skeleton-and-shell.md`
- 执行账本(逐任务结果 + 遗留 Minor):`.superpowers/sdd/progress.md`
- 资产工具用法:`tools/hatch-desktop-pet/SKILL.md`;宠物包契约:`tools/hatch-desktop-pet/references/pet-contract.md`

## 6. 路线图(MVP 分阶段,每个都能独立跑/可测)

- ✅ **MVP-01** 工程骨架 + 可执行躯壳(idle、拖拽、托盘、点击穿透)
- ✅ **MVP-02** 动画状态机(idle/walk/drag/sleep 切换)+ 全局热键/点击唤出对话框壳
- ✅ **MVP-03** LLM Provider 抽象(Fake/Anthropic/OpenAI 兼容)+ 密钥 safeStorage 存储 + 首启设置窗 + Agent 循环护栏 + 逐字流式回复 + §5.6 运行时边界
- ⬜ **MVP-04** web_search 工具 + Skill 加载器 + `skills/web-summary/SKILL.md`
- ⬜ **MVP-05** 分层记忆(短期/工作记忆 + 事实库 + 本地向量库)+ persona 组装
- ⬜ **MVP-06** electron-builder 打包安装 + §11 安全加固

> 更远期(设计文档 §10):情绪/事件驱动行为、口癖台词触发、配音、养成系统、桌面自动化。

## 7. 已知遗留(Minor,记在账本)

- ~~`src/main/petLoader.test.ts` 用 `resolve(__dirname)` 作"缺失 pet.json"目录,略脆 → 改为明确不存在的路径~~ ✅ MVP-02 已清
- ~~`spritePlayer.ts` 每帧 `canvas.width/height` 重设(帧尺寸恒定时可提到 play() 里做一次)~~ ✅ MVP-02 已清
- `parsePetManifest`/`frameDurationMs` 未防 `fps=0` 或 `durations` 含 0/NaN(luluka 数据干净,无实bug)
- 窗口大小 256×288 > 画布 192×208,宠物偏左上(非居中);后续可让窗口贴合或居中
- MVP-03 遗留 Minor(详见账本 `.superpowers/sdd/progress.md`):agentLoop 超时测试用不可中断 sleep 致 ~1s 墙钟(逻辑正确,仅慢);openaiCompat 用 `max_tokens`(为兼容非 OpenAI 端点,刻意);`IPC.HAS_KEY` 常量无消费者(hasKey 走 SettingsSnapshot);settingsWindow 无 `show:false`/`ready-to-show`(首开可能闪白)。
- 真机验收期修的 UI 问题(已修复):长回复挤掉输入条(#history/#bubble 的 flex `min-height:0` + 输入条钉底)、常态气泡不可滚动(no-drag + 显示时 pointer-events)、`resizable:false` 致 `setSize` 无法缩小(临时 setResizable 绕过)、设置下拉对比度。

## 8. 给新会话的提醒

- 这是 superpowers 工作流项目:改需求先 brainstorming,写计划用 writing-plans,执行用 subagent-driven-development,收尾用 finishing-a-development-branch。
- **别再加 `"type":"module"`**(会让 Electron 主进程崩)。
- `.gitignore` 有意忽略了 `docs/*` 和 `pets/luluka`(体积/内容取舍),它们只在磁盘;源码/`src`/`tools`/`skills` 正常跟踪。
- 自动化检查过≠能跑,**动 UI/躯壳后一定要真机 `pnpm dev`/`preview` 肉眼验收**。
