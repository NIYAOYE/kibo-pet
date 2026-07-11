<div align="center">

# 🐾 Kibo

**桌面宠物 · 自带 Agent 内核**

一只趴在桌面上的透明小可爱，背后跑着一个自研的 Agent 内核 —— 会聊天、会用工具、会记住你，还能读出声来。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#安装打包版)
[![Electron](https://img.shields.io/badge/Electron-31-47848F.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)

[下载安装](#安装打包版) · [核心特性](#核心特性) · [开发](#开发) · [宠物包](#宠物包可移植可编辑可换)

</div>

---

## 这是什么

Kibo 是一只 Shimeji 风格的桌面宠物：透明背景、始终置顶、可以拖着满屏跑。但它不只是一个动图播放器 —— 它内置了一个自研的 Agent 内核（受 OpenClaw 启发），接了真实的 LLM，能对话、能调用工具、能分层记忆，还能开口说话。

## 核心特性

- 🗨️ **能聊会用工具** —— 接入 Claude / 任意 OpenAI 兼容端点，联网搜索、查天气、深度读网页（Firecrawl）、剪贴板文字加工，工具调用循环自动多轮回灌
- 🧠 **分层记忆** —— 事实库（人类可读、可编辑）+ 可选向量召回 + 对话摘要，长期记得你是谁、说过什么
- 🎙️ **会开口说话** —— 内置 TTS 语音合成，逐句流式播放不卡顿，点击宠物可打断
- 🎭 **人设可编辑** —— `persona.md` 直接改，重启即生效，想要什么性格自己调
- 👋 **有反应会互动** —— 闲置念叨、戳一下有反应、拖起来会叫、早晚问候、久坐提醒，不是干站着的贴图
- 🖱️ **能替你动手** —— 截屏、点击、打字、操作浏览器网页（默认关闭，开启前强确认 + 执行时悬浮提示 + 你一抓鼠标立刻中断）
- 🖼️ **看得懂图片** —— 选图 / 拖拽 / 粘贴 / 框选截屏，丢给支持视觉的模型识图，图片不落盘
- 🎨 **换皮无痛** —— 一只宠物 = 一个自包含文件夹，拷走即备份，改配置即换宠物

## 安装（打包版）

前往 [Releases](https://github.com/NIYAOYE/kibo-pet/releases) 下载最新的 `Kibo Setup <版本>.exe`，双击走安装向导。**不需要装 Node、不需要命令行**。

默认**每用户安装、免管理员**（装到 `%LOCALAPPDATA%\Programs\Kibo`，可在向导里改目录），并创建桌面 / 开始菜单快捷方式。

> ⚠️ **未签名提示**：安装包未做代码签名，首次运行 Windows SmartScreen 可能拦截 →「更多信息」→「仍要运行」。

首次启动会弹出设置窗：选择 Provider（Claude / OpenAI 兼容端点）、填入 API Key 即可开始对话。

## 开发

包管理器是 **pnpm**（不是 npm/yarn）。

```bash
pnpm install
pnpm dev                         # 开发模式（HMR）
pnpm build                       # 类型检查 + 构建三个 bundle
pnpm preview                     # 跑打包后的产物（比 dev 更接近真实环境）
pnpm test                        # 单元测试（Vitest）
pnpm dist                        # 打包 Windows 安装包 → dist/Kibo Setup <版本>.exe
```

<details>
<summary>打包构建说明（Windows 坑）</summary>

`pnpm dist` 用 electron-builder 出 NSIS 安装包。它会下载 `winCodeSign` 工具包，该包内含 macOS 的 `.dylib` **符号链接**，Windows 下解压创建符号链接需要权限，普通终端会报
`Cannot create symbolic link ... 客户端没有所需的特权` 并失败（即使不做签名）。三选一解决：

1. **开启 Windows 开发者模式**（设置 → 隐私和安全性 → 开发者选项 → 开发人员模式），之后普通终端即可创建符号链接；或
2. 用**管理员终端**跑 `pnpm dist`；或
3. **预解压缓存**（跳过 darwin 符号链接）——一次性，之后 `pnpm dist` 正常：
   ```bash
   SEVENZ="node_modules/7zip-bin/win/x64/7za.exe"
   CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
   "$SEVENZ" x "$CACHE"/*.7z -o"$CACHE/winCodeSign-2.6.0" -xr'!'darwin -y
   ```

</details>

## 宠物包：可移植、可编辑、可换

一只宠物 = 一个**自包含文件夹**，首次启动后落在用户目录 `%APPDATA%\Kibo\pets\<宠物id>\`，内含：

| 文件 | 作用 |
|---|---|
| `pet.json` | 元数据 + 动画清单（改 `displayName` 即改宠物显示名） |
| `spritesheet.webp` | 美术素材 |
| `persona.md` | **人设**，可直接编辑调教宠物，重启生效 |
| `lines.json` | 台词库 |
| `voice/` | 语音音色配置 |
| `memory/` | **这只宠物的长期记忆**（见下） |

整个 `pets\<id>\` 文件夹可直接拷走（U 盘 / 网盘）备份，或迁移到另一台机器 —— 性格 + 记忆一起走。设置窗内可直接**选择 / 导入**新的宠物包。

## 记忆与隐私

宠物拥有分层记忆，数据存在**该宠物文件夹**的 `memory/` 里（设置窗有「打开记忆文件夹」按钮）：

- `facts.json` —— 宠物记住的关于你的事实，唯一权威源，人类可读，可手动编辑/删除
- `vector-index.json` —— 由事实生成的向量索引，可随时删除会自动重建
- `summary.json` / `transcript.json` —— 对话摘要与最近对话历史

**Embedding**：如果在设置里配置了 embedding 端点，被记住的事实文本会发去做向量化用于按话题召回；**留空即完全本地**，功能照常可用。

**识图/截屏**：图片仅本次发送使用，**不写入本地记忆**；截屏 / 桌面控制类工具默认关闭，开启前需要你手动确认。

**API Key**：经 Windows 凭据存储（safeStorage / DPAPI）加密，与本机本用户绑定、不可移植，换机器需重新填。

卸载应用**不会删除** `%APPDATA%\Kibo` 下的记忆与配置。

## 技术栈

Electron · TypeScript（strict）· electron-vite · Vitest · electron-builder，主进程/渲染进程通过 `contextBridge` 暴露的最小 IPC 通信，`contextIsolation` + `sandbox` + 无 `nodeIntegration` 的安全基线。

更多设计细节见 [PROGRESS.md](PROGRESS.md)；后续演进方向见 [ROADMAP.md](ROADMAP.md)。

## License

[MIT](LICENSE)
