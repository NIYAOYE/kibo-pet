# Pet-Agent · 桌面宠物 Agent

Shimeji 风格的桌面宠物(Electron + TypeScript),内置自研 agent 内核:可插拔 LLM Provider、Markdown 技能、分层记忆。

## 安装(打包版)

双击 `dist/Pet-Agent Setup <版本>.exe` 走安装向导即可,**不需要装 Node、不需要命令行**。默认**每用户安装、免管理员**(装到 `%LOCALAPPDATA%\Programs\Pet-Agent`,可在向导里改安装目录),并创建桌面 / 开始菜单快捷方式。

> ⚠️ **未签名提示**:安装包未做代码签名,首次运行 Windows SmartScreen 可能拦截 →「更多信息」→「仍要运行」。

首次启动会弹出设置窗:选择 Provider(Claude / OpenAI 兼容端点)、填入 API Key 即可对话。

## 开发

```bash
pnpm install
pnpm dev          # 开发模式
pnpm build && pnpm preview   # 构建后预览
pnpm test         # 单元测试
pnpm dist         # 打包 Windows 安装包(见下方构建说明)
```

### 打包构建说明(Windows 坑)

`pnpm dist` 用 electron-builder 出 NSIS 安装包。它会下载 `winCodeSign` 工具包,该包内含 macOS 的 `.dylib` **符号链接**,Windows 下解压创建符号链接需要权限,普通终端会报
`Cannot create symbolic link ... 客户端没有所需的特权` 并失败(即使我们不做签名)。三选一解决:

1. **开启 Windows 开发者模式**(设置 → 隐私和安全性 → 开发者选项 → 开发人员模式),之后普通终端即可创建符号链接;或
2. 用**管理员终端**跑 `pnpm dist`;或
3. **预解压缓存**(跳过 darwin 符号链接)——一次性,之后 `pnpm dist` 正常:
   ```bash
   SEVENZ="node_modules/7zip-bin/win/x64/7za.exe"
   CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
   "$SEVENZ" x "$CACHE"/*.7z -o"$CACHE/winCodeSign-2.6.0" -xr'!'darwin -y
   ```

## 宠物包:可移植、可编辑、可换

一只宠物 = 一个**自包含文件夹**,首次启动后落在用户目录 `%APPDATA%\Pet-Agent\pets\<宠物id>\`,内含:

- `pet.json` —— 元数据 + 动画清单(改 `displayName` 即改宠物显示名)
- `spritesheet.webp` —— 美术
- `persona.md` —— **人设(可直接编辑调教宠物)**,重启生效
- `lines.json` —— 台词
- `memory/` —— **这只宠物的长期记忆**(见下)

**整个 `pets\<id>\` 文件夹可直接拷走**(U 盘 / 网盘)备份或迁移到另一台机器——性格 + 记忆一起走。

**换 / 改宠物**:安装包内置了多只宠物;改 `%APPDATA%\Pet-Agent\settings.json` 里的 `activePetId` 为想要的宠物 id,重启即可切换(该宠物首次激活会自动播种到用户目录)。id 拼错 / 指向不存在的宠物时会自动回退到默认宠物。

## 记忆与隐私(重要)

宠物拥有分层记忆,数据存在**该宠物文件夹**的 `memory/` 里(`%APPDATA%\Pet-Agent\pets\<id>\memory\`;设置窗有「打开记忆文件夹」按钮):

- `facts.json` —— 宠物记住的关于你的事实(唯一权威源,人类可读,可手动编辑/删除)
- `vector-index.json` —— 由事实生成的向量索引,可随时删除,会自动重建
- `summary.json` / `transcript.json` —— 对话摘要与最近对话历史

**Embedding 隐私告知**:如果你在设置的「记忆」小节配置了 embedding 端点,被记住的事实文本会发送到该端点做向量化(用于按话题召回)。**留空即完全本地**(按最近记忆召回),功能照常可用。对话本身始终会发送给你配置的聊天 Provider。

**API Key 不随宠物包迁移**:key 经 Windows 凭据存储(safeStorage / DPAPI)加密,**与本机本用户绑定、不可移植**;它存在 `%APPDATA%\Pet-Agent` 根目录(不在宠物包内),换机器需重新填。

卸载应用**不会删除** `%APPDATA%\Pet-Agent` 下的记忆与配置。
