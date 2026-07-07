# 设置窗分类重构(左侧边栏)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平铺的设置窗改成「左侧边栏分类导航 + 右侧分页内容」,4 个分类(宠物 / 模型·API / 工具能力 / 记忆),底部单个全局保存。

**Architecture:** 纯渲染层重构,只改 `src/renderer/settings.html`(DOM 结构 + 样式)与 `src/renderer/settings.ts`(新增侧边栏切页接线;保存/测试/init 逻辑复用不动),外加 `src/main/shell/settingsWindow.ts` 一处窗口尺寸常量微调。所有表单字段仍全部留在 DOM(未激活页 `display:none`),因此单个全局保存照旧一次读全部字段、写整快照——这是低风险的关键。

**Tech Stack:** Electron 渲染层(TypeScript strict + electron-vite),原生 DOM(无框架/无路由库),Vitest(仅用于 typecheck/回归,GUI 由真机验收)。

## Global Constraints

- 包管理器是 **pnpm**(不是 npm/yarn)。
- **不要**给 `package.json` 加 `"type":"module"`。
- 零新依赖:不引任何路由/框架/状态库。
- 不改数据模型:`ProviderSettings`、`search`、`memory`、`textTools`、`activePetId`、`SETTINGS_SCHEMA_VERSION` 全部不变。
- 不改 IPC 契约、preload、主进程业务逻辑(唯一例外:`settingsWindow.ts` 的窗口尺寸常量)。
- 所有现有表单字段的 **id 必须保持不变**(`petSelect` `importPet` `relaunch` `preset` `baseURL` `model` `key` `searchBackend` `searchKeyRow` `searchKey` `embBaseURL` `embModel` `embKey` `autoCopyResult` `openMemoryDir` `test` `save` `status`)——保存/测试/init 逻辑靠这些 id 取元素。
- 维持**单个全局保存,原子写整快照**;不做分页独立保存。
- CSP 不放宽:`settings.html` 的 `<meta http-equiv="Content-Security-Policy">` 保持 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`(样式仍走内联 `<style>`)。
- GUI/Electron 接线由**真机 `pnpm dev` / `pnpm preview` 肉眼验收**;自动化只保证 `pnpm typecheck` / `pnpm build` / `pnpm test` 全绿。
- 默认落地页 = **模型 · API**。
- 提交粒度小、conventional-commit 风格、**中文**提交信息。

---

## File Structure

- **Modify** `src/renderer/settings.html` — 重排 DOM 为 header + `#layout`(`nav#sidenav` + `#pages` 内 4 个 `<section class="page">`)+ 固定 footer;`<style>` 增加侧边栏/分页/激活态样式。字段 id 全部保留。
- **Modify** `src/renderer/settings.ts` — 新增侧边栏切页接线(点击 nav → 切 `.active`);把「测试连接」按钮的视觉位置移入模型页(选择器/逻辑不变);保存、测试、init、导入宠物等既有逻辑**不改**。
- **Modify** `src/main/shell/settingsWindow.ts` — 窗口尺寸常量微调(`width` 460→~560,`height` 视观感保持或略减)。

**任务顺序**:先 HTML 结构(Task 1)→ 再 TS 切页接线(Task 2)→ 再窗口尺寸 + 真机验收(Task 3)。三者串行,每个结束都能编译/构建通过。

---

### Task 1: 重排 settings.html 为侧边栏 + 分页结构

**Files:**
- Modify: `src/renderer/settings.html`

**Interfaces:**
- Consumes: 无(起始任务)。
- Produces: 一个含 `nav#sidenav`(4 个 `button.navitem[data-page]`)、`#pages`(4 个 `section.page[data-page]`)、固定 `footer` 的 DOM;**保留全部原字段 id**;新增样式类 `.navitem` `.navitem.active` `.page` `.page.active`。供 Task 2 的切页接线消费。

- [ ] **Step 1: 备份确认当前字段清单**

先通读 `src/renderer/settings.html` 当前 22–76 行,确认要搬运的元素 id 一个不漏(见 Global Constraints 的 id 清单)。这是核对步骤,不产出改动。

- [ ] **Step 2: 重写 `<style>` 段,加入侧边栏/分页样式**

把 `src/renderer/settings.html` 的 `<style>`(第 6–19 行)整体替换为下面内容(保留原有 token,新增 `#layout`/`#sidenav`/`.navitem`/`.page`/`footer` 规则):

```html
    <style>
      html, body { margin: 0; font-family: system-ui, sans-serif; font-size: 13px; background: #1e1e28; color: #f0f0f4; }
      #app { display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
      header { padding: 12px 16px 8px; }
      h1 { font-size: 15px; margin: 0; }
      #layout { flex: 1; display: flex; min-height: 0; }
      /* 左侧边栏 */
      #sidenav { flex: 0 0 118px; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-right: 1px solid rgba(255,255,255,0.08); }
      .navitem { text-align: left; border: none; border-radius: 8px; padding: 9px 10px; cursor: pointer; background: transparent; color: #c8c8d4; font-size: 13px; }
      .navitem:hover { background: rgba(255,255,255,0.08); }
      .navitem.active { background: rgba(90,110,200,0.95); color: #fff; }
      /* 右侧分页内容 */
      #pages { flex: 1; min-width: 0; overflow-y: auto; padding: 12px 16px; }
      .page { display: none; flex-direction: column; gap: 10px; }
      .page.active { display: flex; }
      .page h2 { font-size: 13px; margin: 0 0 2px; opacity: 0.9; }
      .hint { opacity: 0.8; line-height: 1.5; }
      label { display: flex; flex-direction: column; gap: 4px; }
      input { border: none; border-radius: 8px; padding: 8px; background: rgba(255,255,255,0.12); color: #f0f0f4; }
      /* select 用不透明底色,option 单独给高对比配色(半透明背景会让 OS 下拉列表很淡看不清) */
      select { border: none; border-radius: 8px; padding: 8px; background: #34344a; color: #f5f5f8; }
      select option { background: #34344a; color: #f5f5f8; }
      .row { display: flex; gap: 8px; align-items: center; }
      button { border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; background: rgba(90,110,200,0.95); color: #fff; }
      button.secondary { background: rgba(255,255,255,0.16); }
      /* 底部固定操作条 */
      footer { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.08); }
      #status { flex: 1; min-height: 18px; opacity: 0.85; }
    </style>
```

- [ ] **Step 3: 重写 `<body>` 内 `#app` 为 header + 分页 + footer**

把 `src/renderer/settings.html` 的 `<div id="app">…</div>`(第 22–76 行)整体替换为:

```html
    <div id="app">
      <header><h1>宠物大脑设置</h1></header>
      <div id="layout">
        <nav id="sidenav">
          <button class="navitem" data-page="model" type="button">模型 · API</button>
          <button class="navitem" data-page="pet" type="button">宠物</button>
          <button class="navitem" data-page="tools" type="button">工具能力</button>
          <button class="navitem" data-page="memory" type="button">记忆</button>
        </nav>
        <div id="pages">

          <section class="page" data-page="model">
            <h2>模型 · API</h2>
            <label>Provider 预设
              <select id="preset"></select>
            </label>
            <label>Base URL(可留空用默认)
              <input id="baseURL" type="text" placeholder="https://..." />
            </label>
            <label>模型
              <input id="model" type="text" />
            </label>
            <label>API Key
              <input id="key" type="password" placeholder="仅本机加密存储,不外传" />
            </label>
            <div class="row">
              <button id="test" class="secondary">测试连接</button>
            </div>
          </section>

          <section class="page" data-page="pet">
            <h2>宠物</h2>
            <label>当前宠物(重启后生效)
              <select id="petSelect"></select>
            </label>
            <div class="row">
              <button id="importPet" class="secondary">导入宠物包…</button>
              <button id="relaunch" class="secondary" style="display:none">立即重启</button>
            </div>
          </section>

          <section class="page" data-page="tools">
            <h2>工具能力</h2>
            <label>搜索后端
              <select id="searchBackend">
                <option value="duckduckgo">免费·内置(默认)</option>
                <option value="tavily">Tavily(需 API key)</option>
              </select>
            </label>
            <label id="searchKeyRow" style="display:none">Tavily API Key
              <input id="searchKey" type="password" placeholder="仅本机加密存储,不外传" />
            </label>
            <label style="display:flex;align-items:center;gap:8px;flex-direction:row">
              <input id="autoCopyResult" type="checkbox" style="width:auto" />
              <span>快捷加工结果自动复制到剪贴板(会覆盖当前剪贴板)</span>
            </label>
          </section>

          <section class="page" data-page="memory">
            <h2>记忆(可选)</h2>
            <div class="hint">配置 embedding 后,宠物记住的事实会发送到该端点做向量化,以便按话题召回;三项留空则记忆完全本地(按最近记忆召回)。</div>
            <label>Embedding Base URL
              <input id="embBaseURL" type="text" placeholder="https://...(OpenAI 兼容,如 DashScope)" />
            </label>
            <label>Embedding 模型
              <input id="embModel" type="text" placeholder="如 text-embedding-v3" />
            </label>
            <label>Embedding API Key
              <input id="embKey" type="password" placeholder="留空且与聊天同 Base URL 时自动复用聊天 Key" />
            </label>
            <div class="row">
              <button id="openMemoryDir" class="secondary">打开记忆文件夹</button>
            </div>
          </section>

        </div>
      </div>
      <footer>
        <div id="status"></div>
        <button id="save">保存</button>
      </footer>
    </div>
```

- [ ] **Step 4: 运行 typecheck + build,确认 HTML 未破坏渲染层编译**

Run: `pnpm typecheck`
Expected: PASS(无类型错误)。

Run: `pnpm build`
Expected: 三包构建成功(此时 settings.ts 尚未加切页逻辑,但页面 `.page` 全部无 `.active` → 内容区暂时空白,属预期,Task 2 修复)。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings.html
git commit -m "refactor(settings): 设置窗 DOM 重排为侧边栏+分页结构(4分类)"
```

---

### Task 2: settings.ts 接入侧边栏切页 + 默认页

**Files:**
- Modify: `src/renderer/settings.ts`

**Interfaces:**
- Consumes: Task 1 产出的 `nav#sidenav` 内 `button.navitem[data-page]` 与 `#pages` 内 `section.page[data-page]`;全部原字段 id 不变。
- Produces: 一个 `showPage(page: string)` 行为(切 `.active`),init 时默认激活 `model` 页。保存/测试/init/导入逻辑不变。

- [ ] **Step 1: 加入切页函数与 nav 点击接线**

在 `src/renderer/settings.ts` 顶部选择器区(现有 `const petSelect = ...` 等之后、`for (const p of PRESETS)` 之前)加入切页逻辑:

```typescript
// 侧边栏分页:点击 navitem → 显示对应 .page,高亮当前项
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('#sidenav .navitem'))
const pages = Array.from(document.querySelectorAll<HTMLElement>('#pages .page'))

function showPage(page: string): void {
  for (const s of pages) s.classList.toggle('active', s.dataset.page === page)
  for (const n of navItems) n.classList.toggle('active', n.dataset.page === page)
}

for (const n of navItems) {
  n.addEventListener('click', () => showPage(n.dataset.page ?? 'model'))
}
```

- [ ] **Step 2: init 时默认激活「模型·API」页**

在 `src/renderer/settings.ts` 末尾 init 的 IIFE(`void (async () => { ... })()`)内,最后一行 `status.textContent = ...` 之后,加入默认页设置:

```typescript
  showPage('model') // 默认落地页:模型 · API
```

- [ ] **Step 3: typecheck 确认无类型错误**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 全量回归 + 构建**

Run: `pnpm test`
Expected: 全部通过(渲染层无关单测不受影响,数量与改前一致)。

Run: `pnpm build`
Expected: 三包构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings.ts
git commit -m "feat(settings): 侧边栏切页接线 + 默认落地模型页"
```

---

### Task 3: 调整设置窗尺寸 + 真机验收

**Files:**
- Modify: `src/main/shell/settingsWindow.ts:13-15`

**Interfaces:**
- Consumes: Task 1/2 完成的侧边栏设置界面。
- Produces: 容得下侧边栏、无横向溢出的最终窗口尺寸;真机验收结论。

- [ ] **Step 1: 调宽设置窗**

在 `src/main/shell/settingsWindow.ts` 的 `new BrowserWindow({ ... })` 里,把宽度从 `460` 改为 `560`(高度 `520` 暂保持;真机若偏高可在 Step 3 后微调):

```typescript
    const w = new BrowserWindow({
      width: 560,
      height: 520,
      title: '设置',
      resizable: false,
```

- [ ] **Step 2: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 均通过。

- [ ] **Step 3: 真机验收(人工,按 spec §7 清单)**

Run: `pnpm dev`(或 `pnpm build && pnpm preview` 更稳),从托盘或热键打开设置窗,逐项确认:

1. 四个分类可点击切换,右侧内容随之切换,激活项高亮正确。
2. **从任意一页点保存,都能写全部字段**:在模型页改 model → 切到记忆页 → 点保存 → 关窗重开,model 仍生效。
3. 重开设置窗,各页字段被正确回填(含 Tavily/Embedding「已配置」占位提示)。
4. 测试连接在模型页可用。
5. 工具页切换搜索后端为 Tavily 时,Tavily key 行出现;切回免费后端时隐藏。
6. 首启提示文案仍在(`status` 初始文案)。
7. 宠物页导入/切换/重启提示流程不变。
8. 窗口容得下侧边栏,无横向溢出/裁切;若内容偏矮,可回 `settingsWindow.ts` 把 `height` 调小并重验。

> 注:本仓库无 Electron GUI 自动化驱动,GUI 交互按项目既有约定由人工在真实窗口走一遍(同 MVP-09/07/06 惯例)。

- [ ] **Step 4: 提交**

```bash
git add src/main/shell/settingsWindow.ts
git commit -m "feat(settings): 设置窗调宽以容纳侧边栏"
```

---

## Self-Review

**1. Spec coverage:**
- §3 架构(纯渲染层 / DOM 结构 / 导航机制 / 默认页 / 样式)→ Task 1(结构+样式)+ Task 2(导航+默认页)。✅
- §4 分类映射(4 页字段归属 + 测试连接移入模型页 + 底部 footer)→ Task 1 Step 3 的 DOM。✅
- §5 数据流(切页/保存/测试/init/错误不变)→ Task 2 复用既有逻辑,不改保存/测试/init。✅
- §6 窗口尺寸 → Task 3 Step 1。✅
- §7 测试与验收(typecheck/build/test 全绿 + 8 项真机清单)→ 各 Task 的 typecheck/build/test 步骤 + Task 3 Step 3 清单。✅
- §8 影响面(三个文件 + 零改动项)→ File Structure + Global Constraints 覆盖。✅

**2. Placeholder scan:** 无 TBD/TODO/「稍后实现」;所有代码步骤都给了完整代码块。✅

**3. Type consistency:** `showPage(page: string)` 在 Task 2 Step 1 定义、Step 2 调用,签名一致;`data-page` 值(`model`/`pet`/`tools`/`memory`)在 HTML(Task 1)与 TS(Task 2)间一致;所有字段 id 与 settings.ts 现有选择器一致(Global Constraints 已锁定)。✅
