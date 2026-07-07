# MVP-06 设计文档 — 打包安装 + 可移植宠物包 + 安全加固

- **日期**: 2026-07-03
- **状态**: 待用户评审
- **前置**: MVP-05(分层记忆)已完成、真机验收通过,`develop`/`main` 同处 `387bdf9`
- **对应总设计**: `docs/superpowers/specs/2026-06-26-desktop-pet-agent-design.md` 的 §8(部署与首次启动)+ §11(安全与可靠性基线)

---

## 1. 目标与范围

把 MVP-05 的代码变成**双击即装的 Windows 应用**,并把宠物做成**可快速移植/热插拔的自包含包**,同时补齐 §11 安全基线的最后缺口(IPC payload 校验)。

三块工作:

- **(A) electron-builder 打包** —— 产出 Windows NSIS 安装包(.exe),双击即装,免 Node、免命令行。
- **(B) 可移植宠物包 + 首启播种** —— 宠物的美术/人设/台词/**该宠物的记忆**放进一个可拷走的文件夹;活跃宠物由设置项决定(**宠物名称/id 可修改**)。
- **(C) IPC payload 校验加固** —— 落实 §11.2「所有 IPC 消息校验发送方与 payload」。

### 1.1 明确不做(Out of Scope)

- **代码签名**:无证书,产物为未签名 .exe;接受首次运行 Windows SmartScreen 提示(README 告知「更多信息 → 仍要运行」)。
- **自动更新**(electron-updater / 更新服务器)。
- **多宠物切换 UI**:活跃宠物通过设置项切换、重启生效;不做图形化宠物管理器。
- **跨机器可移植 API key**:key 经 `safeStorage`(DPAPI)机器/用户绑定,**不可移植**,始终留在全局 `userData`,不进宠物包。

### 1.2 §11 现状核对(避免重复造轮子)

以下 §11 条目 MVP-01..05 已满足,本轮**只复核不重写**:`contextIsolation:true`/`sandbox:true`/`nodeIntegration:false`(§11.1);CSP meta(§11.1);外链走系统浏览器(§11.1);API key 经 `safeStorage` 加密、不进日志/JSON(§11.2);不可信文本(搜索/技能/记忆)注入前声明来源、防 prompt injection(§11.2);在线 embedding 外发告知(§11.2 / README);主进程重活异步 I/O(§11.3)。

本轮**新增**的 §11 缺口只有一条:**§11.2「所有 IPC 消息校验发送方与 payload」** —— 见第 4 节。

---

## 2. (A) electron-builder 打包

### 2.1 配置

新增 `electron-builder.yml`(仓库根),关键字段:

- `appId: com.petagent.app`
- `productName: Pet-Agent`
- `directories.output: dist`
- `files: [ "out/**", "package.json" ]`(electron-vite 已把三进程打进 `out/`)
- `asar: true`(依赖 `@anthropic-ai/sdk`/`openai` 均为纯 JS,无原生模块,可入 asar)
- **`extraResources`**:把磁盘上的 `pets/`(含被 `.gitignore` 忽略的 `luluka`)与 `skills/` 拷进安装包的 `resources/`:
  ```yaml
  extraResources:
    - from: pets
      to: pets
    - from: skills
      to: skills
  ```
  使打包版 `process.resourcesPath/pets|skills` 存在。现有 `appRoot = app.isPackaged ? process.resourcesPath : repoRoot` 逻辑(`shell/index.ts:35`)已就绪,**无需改动**。
- **`win.target: nsis`**、`win.icon: build/icon.ico`。
- **`nsis`**:`oneClick: false`、`perMachine: false`(**每用户安装、免管理员**,装到 `%LOCALAPPDATA%\Programs\Pet-Agent`)、`allowToChangeInstallationDirectory: true`、`createDesktopShortcut: true`、`createStartMenuShortcut: true`。

### 2.2 应用图标

- 产出 `build/icon.ico`(含 256×256 等多尺寸),来源为 **luluka 的 idle 首帧**(从 `pets/luluka/spritesheet.webp` 按 `pet.json` 的 `sheet` 网格裁第 0 行第 0 帧 → 裁到不透明包围盒 → 缩放 → 合成多尺寸 .ico)。
- 用一个开发期脚本完成:`tools/hatch-desktop-pet/scripts/` 下新增 `make_app_icon.py`(复用该工具已有的 Pillow 依赖与几何常量思路),经 **conda 虚拟环境** 运行(按需 `pip install pillow`)。
- 图标为**开发期一次性生成物**,产物 `build/icon.ico` 提交入库;脚本失败不阻塞打包(可临时用占位 ico,后补)。

### 2.3 脚本

`package.json` 新增:
```json
"dist": "pnpm build && electron-builder --win"
```

---

## 3. (B) 可移植宠物包 + 首启播种

### 3.1 核心概念:活跃宠物家目录(pet home)

**活跃宠物家目录** = `userData/pets/<activePetId>/`,是一个**自包含、可拷走的宠物包**,内含:

```
userData/pets/luluka/
  ├── pet.json            # 元数据 + 动画清单(displayName 可编辑 → 改宠物显示名)
  ├── spritesheet.webp    # 美术
  ├── persona.md          # 人设(用户可直接编辑调教,呼应总设计 §5.4)
  ├── lines.json          # 台词
  ├── voice/              # 配音(可选)
  └── memory/             # ← 该宠物的长期记忆(facts.json / vector-index.json / transcript.json / summary)
```

把 memory 收进宠物家目录后,**整个 `userData/pets/<id>/` 就是一个可 U 盘/网盘拷走的宠物包(性格 + 记忆一起走)**,落实用户诉求「宠物相关资源/设定/记忆放一个包里、可快速移植/热插拔」,也与总设计 §7.5(memory 可整体拷走)一致。

**不进宠物包**(留在 `userData` 根,机器绑定):`settings.json`、`secrets*.bin`(API key / Tavily key / embedding key)。

### 3.2 活跃宠物 id 可配置(宠物名称可修改)

- `AppSettings` 新增字段 **`activePetId: string`**(默认 `"luluka"`);`SETTINGS_SCHEMA_VERSION` 由 `3` → `4`。
- `config/settings.ts` 的 `normalize()` 补一行:`activePetId` 为非空 string 则采用,否则回退默认(沿用现有「idempotent 归一化即迁移」模式,无需显式版本分支;旧 v3 文件读入自动补默认)。
- 换/改宠物 = 改 `activePetId`(手改 `settings.json`,或设置窗新增一个文本输入项)+ **重启生效**(宠物窗口/记忆在启动时绑定 id;运行时热切留后续)。
- **宠物显示名** 直接编辑该宠物 `pet.json` 的 `displayName` 即可(宠物包已在可写的 userData 下)。

> 设置窗是否新增 activePetId 输入框由实现计划决定;最低限度保证 `settings.json` 可手改并被读取。

### 3.3 首启播种与迁移模块

新增单一职责模块 **`src/main/pets/petHome.ts`**(纯路径 + 文件操作,依赖注入 fs / 源目录 / 目标目录,便于单测;沿用 `config/secrets.ts`、`config/settings.ts` 的可注入风格):

职责(给定 `activePetId`、`bundledPetsDir`(= `petsDir(appRoot)`)、`userDataDir`):

1. **计算** `petHome = join(userDataDir, 'pets', activePetId)`。
2. **首启播种**:若 `petHome` 不存在 → 从 `join(bundledPetsDir, activePetId)` **整包递归复制**到 `petHome`(美术/persona/lines/voice;不含 memory —— 内置包无 memory)。源不存在则报明确错误(activePetId 拼错 / 该宠物未随包分发)。
3. **记忆迁移(一次性)**:若旧全局 `join(userDataDir, 'memory')` 存在、且 `join(petHome, 'memory')` 不存在 → 把旧 memory **移动**进宠物家目录(保住 MVP-05 真机验收攒下的记忆,不丢)。仅对默认宠物迁移一次;之后旧路径不再使用。
4. **返回** `{ petHome, memoryDir: join(petHome, 'memory') }`。

### 3.4 接线(`shell/index.ts`)

- 启动时读 `settings.json` 拿 `activePetId`,调用 petHome 模块得到 `petHome` 与 `memoryDir`。
- `petDir`(`:40`)从 `join(petsDir(appRoot), 'luluka')` 改为 `petHome`(供 `loadPet` / persona / lines / chat 使用)。
- `memoryDir`(`:63`)从 `join(userData,'memory')` 改为返回的 `memoryDir`。
- `skills`(`:65`)**不变**:技能是全局只读资源、非宠物专属,仍从 `join(appRoot, 'skills')` 加载,随 `extraResources` 分发。
- API key/settings 路径(`:59-62`)**不变**,留在 `userData` 根。

---

## 4. (C) IPC payload 校验加固(§11.2)

### 4.1 校验层

新增 **`src/shared/ipcValidation.ts`**(纯函数,TDD;跨进程契约,置于 `@shared`)。为每个**渲染器 → 主进程、带 payload** 的通道提供校验/解析器,非法输入返回 `null`/`false` 或抛可捕获错误,**绝不把未校验值喂给 fs/provider/window API**。

需校验的通道与规则:

| 通道 | payload | 校验规则 |
|---|---|---|
| `MOVE_WINDOW` | `MoveDelta` | `dx`/`dy` 为**有限数**(拒 NaN/Infinity);`clamp` 为可选 boolean |
| `SET_IGNORE_MOUSE` | `boolean` | 严格 boolean |
| `DIALOG_SET_SIZE` | `boolean`(collapsed) | 严格 boolean |
| `CHAT_SEND` | `ChatSendPayload` | `text` 为 string 且长度 ≤ 上限(如 8000);`attachments` 若有须为合法数组 |
| `SET_SETTINGS` | `AppSettings` | 复用/包裹 `config/settings.ts` 的 `normalize()` 思路做形状校验后再落盘 |
| `SET_API_KEY` / `SET_SEARCH_KEY` / `SET_EMBEDDING_KEY` | `string` | string 且长度 ≤ 上限 |
| `TEST_CONNECTION` | `ProviderSettings` + `string` | provider 形状(kind ∈ 枚举、model 为 string)+ key 为 string |

无 payload 的通道(`TOGGLE_DIALOG`/`QUIT`/`CANCEL_CHAT`/`OPEN_SETTINGS`/`OPEN_MEMORY_DIR`/各 `GET_*`)无需 payload 校验。

### 4.2 接线

`shell` 里各 `ipcMain.handle/on` 入口**先过校验**:非法 payload 直接拒绝(`handle`:返回错误/安全默认;`on`:忽略并可选 `console.warn`,不含敏感值)。已有 `normalize()`(settings)天然属于此层,纳入统一叙述。

### 4.3 复核(不新增代码,验证既有)

- 打包版渲染器走 `file://` 载入,确认 `index.html`/`dialog.html`/`settings.html` 的 **CSP meta 仍生效**;`ELECTRON_RENDERER_URL` 仅 dev 存在。
- grep 审计:确认 API key 不出现在任何 `console.*` / 错误消息 / settings.json。

---

## 5. 测试与验证

### 5.1 单元测试(TDD,先写失败测试)

- **`petHome.ts`**:① 目标不存在 → 从源整包复制(断言文件出现在目标);② 目标已存在 → 不覆盖(幂等);③ 旧全局 memory 存在且新位置无 → 迁移(移动);④ 新位置已有 memory → 不迁移;⑤ 源宠物不存在 → 抛明确错误。用临时目录 + 注入路径。
- **`ipcValidation.ts`**:每个校验器的合法/非法用例(数字型 NaN/Infinity、非 string、超长、错枚举、缺字段)。
- **`settings.ts`**:`activePetId` 归一化(缺省补默认、非法回退、v3→v4 读入)。

### 5.2 回归

`pnpm test`(现 184/184,新增测试后应全绿)、`pnpm typecheck`、`pnpm build` 全通过。

### 5.3 真机验证(打包版不能只靠自动化 —— 项目铁律)

1. `pnpm dist` → 产出 `dist/*.exe`。
2. 安装 → 从开始菜单/桌面快捷方式启动。
3. 确认:宠物 luluka 渲染、可拖拽、托盘退出、点击穿透;对话可跑;记忆落到 `userData/pets/luluka/memory/`。
4. **可移植性**:编辑 `userData/pets/luluka/persona.md` → 重启 → 人设变化生效;把整个 `userData/pets/luluka/` 拷到别处仍是完整宠物包(含记忆)。
5. **宠物名称可改**:改 `pet.json` 的 `displayName` / 或改 `settings.json` 的 `activePetId` → 生效。
6. **卸载**:卸载后 `userData`(记忆/配置)仍在。

---

## 6. 影响文件一览

**新增**:`electron-builder.yml`、`build/icon.ico`、`tools/hatch-desktop-pet/scripts/make_app_icon.py`、`src/main/pets/petHome.ts`(+ 测试)、`src/shared/ipcValidation.ts`(+ 测试)。

**修改**:`package.json`(`dist` 脚本)、`src/shared/llm.ts`(`activePetId` + schemaVersion 4)、`src/main/config/settings.ts`(归一化 `activePetId`,+ 测试)、`src/main/shell/index.ts`(接线 petHome / 各 IPC 入口过校验)、`README.md`(安装/SmartScreen/可移植宠物包说明)、`.gitignore`(确认 `dist/` 忽略、`build/icon.ico` 不被误忽略)、`PROGRESS.md`(收尾更新)。

**不改**:`appRoot`/`petsDir` 逻辑、skills 加载路径、secrets/settings 存储位置、Electron 安全开关(已满足)。
