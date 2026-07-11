# Kibo Rename + Tray Icon Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the leftover luluka tray icon with the original code-drawn design, and rename the app's display name to "Kibo" and its package name to "kibo-pet" everywhere a user or developer would see it.

**Architecture:** (1) Extend the existing `make_app_icon_original.py` script to also export a 32×32 PNG over `resources/tray.png`, reusing its existing drawing logic — no new art, no new file. (2) A mechanical find-and-replace rename across `package.json`, `electron-builder.yml`, three TypeScript files, `settings.html`, and two markdown docs, each edit shown verbatim below.

**Tech Stack:** TypeScript/Electron, Python 3 + Pillow (icon script), electron-builder.

## Global Constraints

- Display name (productName, tray tooltip, error dialog title, settings window title/header, README/PROGRESS current-state prose) → **"Kibo"**.
- Package name (`package.json` `"name"`) → **"kibo-pet"**.
- electron-builder `appId` → **`com.kibo.pet`**.
- Do **not** touch `src/main/automation/win32Bridge.ts`'s internal `PetAgentAutomation` PowerShell/C# namespace — it's invisible to users and out of scope.
- Do **not** rename the repo folder on disk or touch git remotes — outside what's safe to do from within a running session in that directory.
- Do **not** add any `userData` migration logic — a fresh `%APPDATA%\Kibo` directory replacing the old `%APPDATA%\Pet-Agent` is the accepted, explicitly-approved behavior.
- Do **not** edit `PROGRESS.md` line 125 (the MVP-06 crash-postmortem paragraph) or any `docs/superpowers/**` file — these are dated historical records of what was true under the old name at the time; rewriting them misrepresents history.
- Package manager is pnpm; do not add `"type": "module"` to `package.json`.

---

### Task 1: Tray icon — regenerate from the original design

**Files:**
- Modify: `tools/hatch-desktop-pet/scripts/make_app_icon_original.py`
- Modify: `resources/tray.png` (regenerated binary output, not hand-edited)

**Interfaces:**
- Consumes: nothing from other tasks (fully standalone).
- Produces: `resources/tray.png` — consumed by `src/main/shell/tray.ts`'s existing `createTray(iconPath, ...)` call (unchanged call site, `join(appRoot, 'resources/tray.png')`), and by `electron-builder.yml`'s existing `extraResources: - from: resources, to: resources` (unchanged).

- [ ] **Step 1: Extend the icon script's `__main__` block**

In `tools/hatch-desktop-pet/scripts/make_app_icon_original.py`, the current `__main__` block (lines 79-84) reads:
```python
if __name__ == "__main__":
    canvas = build()
    out = os.path.join(ROOT, "build", "icon.ico")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", out)
```
Change it to:
```python
if __name__ == "__main__":
    canvas = build()

    icon_out = os.path.join(ROOT, "build", "icon.ico")
    os.makedirs(os.path.dirname(icon_out), exist_ok=True)
    canvas.save(icon_out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", icon_out)

    # 系统托盘图标(src/main/shell/tray.ts 读 resources/tray.png):用同一套构图重新
    # 缩到 32x32,保持托盘图标和安装包/exe 图标视觉一致,不再是旧的 luluka 立绘。
    tray_out = os.path.join(ROOT, "resources", "tray.png")
    os.makedirs(os.path.dirname(tray_out), exist_ok=True)
    canvas.resize((32, 32), Image.LANCZOS).save(tray_out)
    print("wrote", tray_out)
```
Also update the module docstring's first line (currently `"""从零画一个原创应用图标 build/icon.ico(开发期一次性)。`) to mention both outputs, e.g.:
```python
"""从零画一个原创应用图标:build/icon.ico(安装包/exe 图标)+ resources/tray.png(系统托盘图标)。开发期一次性。
```
(keep the rest of the docstring paragraph as-is — it already explains the copyright-safe original-drawing rationale, which still applies to both outputs).

- [ ] **Step 2: Run the script and verify both outputs**

Run (repo root):
```bash
conda run -n peticon python tools/hatch-desktop-pet/scripts/make_app_icon_original.py
```
If the `peticon` conda env is unavailable, fall back to plain `python tools/hatch-desktop-pet/scripts/make_app_icon_original.py` (verify Pillow is importable first with `python -c "import PIL; print(PIL.__version__)"` if needed — it was already confirmed importable on this machine's base interpreter in a prior session).

Expected output:
```
wrote <repo>\build\icon.ico
wrote <repo>\resources\tray.png
```
Confirm both files were modified: `git status` should show `build/icon.ico` and `resources/tray.png` as modified (binary changes). Confirm `resources/tray.png` is still 32×32 (e.g. via Python: `python -c "from PIL import Image; print(Image.open('resources/tray.png').size)"` should print `(32, 32)`).

- [ ] **Step 3: Visual sanity check**

Open `resources/tray.png` (e.g. drag into a browser tab, or `powershell -c "Invoke-Item resources/tray.png"`) and confirm it shows the same rounded-gradient-badge/cat-ear-helmet/glowing-eyes design as `build/icon.ico` — NOT the old luluka character portrait — and is legible at 32px (no illegible mush; this is the standard risk of shrinking a detailed icon, so look carefully).

- [ ] **Step 4: Commit**

```bash
git add tools/hatch-desktop-pet/scripts/make_app_icon_original.py build/icon.ico resources/tray.png
git commit -m "fix(icon): 系统托盘图标沿用原创机器猫设计,替换遗留的 luluka 立绘"
```

---

### Task 2: Rename app/package identifiers in source and config

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml`
- Modify: `src/main/shell/tray.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/settings.html`
- Modify: `src/main/shell/settingsWindow.ts`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 1).
- Produces: nothing consumed by other tasks (Task 3 touches only markdown docs, no code dependency on this task).

- [ ] **Step 1: `package.json`**

Change line 2 from:
```json
  "name": "pet-agent",
```
to:
```json
  "name": "kibo-pet",
```
(leave every other field — version, description, scripts, dependencies — untouched).

- [ ] **Step 2: `electron-builder.yml`**

Change the first two lines from:
```yaml
appId: com.petagent.app
productName: Pet-Agent
```
to:
```yaml
appId: com.kibo.pet
productName: Kibo
```
(leave `directories`, `files`, `asarUnpack`, `extraResources`, `win`, `nsis` sections untouched).

- [ ] **Step 3: `src/main/shell/tray.ts`**

Change line 10 from:
```typescript
  tray.setToolTip('Pet Agent')
```
to:
```typescript
  tray.setToolTip('Kibo')
```

- [ ] **Step 4: `src/main/index.ts`**

Change line 17 from:
```typescript
  try { targets.push(join(tmpdir(), 'pet-agent-startup.log')) } catch { /* ignore */ }
```
to:
```typescript
  try { targets.push(join(tmpdir(), 'kibo-startup.log')) } catch { /* ignore */ }
```

Change line 43 from:
```typescript
      dialog.showErrorBox('Pet-Agent 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
```
to:
```typescript
      dialog.showErrorBox('Kibo 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
```

- [ ] **Step 5: `src/renderer/settings.html`**

Change line 38 from:
```html
      <header><h1>宠物大脑设置</h1></header>
```
to:
```html
      <header><h1>Kibo 设置</h1></header>
```

- [ ] **Step 6: `src/main/shell/settingsWindow.ts`**

Change line 16 from:
```typescript
      title: '设置',
```
to:
```typescript
      title: 'Kibo 设置',
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (All 6 edits are string-literal changes with no type implications; this just confirms no typo broke syntax.)

- [ ] **Step 8: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS, same 599/599 count as before this task (none of these files have associated unit tests — string-literal UI/config text, verified by running the app per this repo's convention, not by test).

- [ ] **Step 9: Commit**

```bash
git add package.json electron-builder.yml src/main/shell/tray.ts src/main/index.ts src/renderer/settings.html src/main/shell/settingsWindow.ts
git commit -m "feat: 应用改名为 Kibo,包名改为 kibo-pet"
```

---

### Task 3: Rename in README.md and PROGRESS.md

**Files:**
- Modify: `README.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: `README.md` — all 6 occurrences**

Line 1, change:
```markdown
# Pet-Agent · 桌面宠物 Agent
```
to:
```markdown
# Kibo · 桌面宠物 Agent
```

Line 7, change:
```markdown
双击 `dist/Pet-Agent Setup <版本>.exe` 走安装向导即可,**不需要装 Node、不需要命令行**。默认**每用户安装、免管理员**(装到 `%LOCALAPPDATA%\Programs\Pet-Agent`,可在向导里改安装目录),并创建桌面 / 开始菜单快捷方式。
```
to:
```markdown
双击 `dist/Kibo Setup <版本>.exe` 走安装向导即可,**不需要装 Node、不需要命令行**。默认**每用户安装、免管理员**(装到 `%LOCALAPPDATA%\Programs\Kibo`,可在向导里改安装目录),并创建桌面 / 开始菜单快捷方式。
```

Line 39, change:
```markdown
一只宠物 = 一个**自包含文件夹**,首次启动后落在用户目录 `%APPDATA%\Pet-Agent\pets\<宠物id>\`,内含:
```
to:
```markdown
一只宠物 = 一个**自包含文件夹**,首次启动后落在用户目录 `%APPDATA%\Kibo\pets\<宠物id>\`,内含:
```

Line 49, change:
```markdown
**换 / 改宠物**:安装包内置了多只宠物;改 `%APPDATA%\Pet-Agent\settings.json` 里的 `activePetId` 为想要的宠物 id,重启即可切换(该宠物首次激活会自动播种到用户目录)。id 拼错 / 指向不存在的宠物时会自动回退到默认宠物。
```
to:
```markdown
**换 / 改宠物**:改 `%APPDATA%\Kibo\settings.json` 里的 `activePetId` 为想要的宠物 id,重启即可切换(该宠物首次激活会自动播种到用户目录)。id 拼错 / 指向不存在的宠物时会自动回退到默认宠物。
```
(Note: this line also drops the now-inaccurate "安装包内置了多只宠物" clause — a prior change already stopped bundling pet packages by default, so the installer no longer ships any pets. This is a one-line factual correction, not scope creep on the rename — the sentence is about pet switching, and leaving "安装包内置了多只宠物" would actively mislead a reader of the current README.)

Line 53, change:
```markdown
宠物拥有分层记忆,数据存在**该宠物文件夹**的 `memory/` 里(`%APPDATA%\Pet-Agent\pets\<id>\memory\`;设置窗有「打开记忆文件夹」按钮):
```
to:
```markdown
宠物拥有分层记忆,数据存在**该宠物文件夹**的 `memory/` 里(`%APPDATA%\Kibo\pets\<id>\memory\`;设置窗有「打开记忆文件夹」按钮):
```

Line 63, change:
```markdown
**API Key 不随宠物包迁移**:key 经 Windows 凭据存储(safeStorage / DPAPI)加密,**与本机本用户绑定、不可移植**;它存在 `%APPDATA%\Pet-Agent` 根目录(不在宠物包内),换机器需重新填。
```
to:
```markdown
**API Key 不随宠物包迁移**:key 经 Windows 凭据存储(safeStorage / DPAPI)加密,**与本机本用户绑定、不可移植**;它存在 `%APPDATA%\Kibo` 根目录(不在宠物包内),换机器需重新填。
```

Line 65, change:
```markdown
卸载应用**不会删除** `%APPDATA%\Pet-Agent` 下的记忆与配置。
```
to:
```markdown
卸载应用**不会删除** `%APPDATA%\Kibo` 下的记忆与配置。
```

- [ ] **Step 2: `PROGRESS.md` — 2 of 3 occurrences (leave line 125 alone)**

Line 1, change:
```markdown
# Pet-Agent — 进度与交接文档
```
to:
```markdown
# Kibo — 进度与交接文档
```

Line 22, change:
```markdown
pnpm dist         # 打包 Windows 安装包 → dist/Pet-Agent Setup <ver>.exe(见 README「打包构建说明」的 winCodeSign 符号链接坑)
```
to:
```markdown
pnpm dist         # 打包 Windows 安装包 → dist/Kibo Setup <ver>.exe(见 README「打包构建说明」的 winCodeSign 符号链接坑)
```

Do **not** touch line 125 (the MVP-06 crash-postmortem paragraph mentioning `%APPDATA%\Pet-Agent\pets\luluka\memory` and `%TEMP%\pet-agent-startup.log`) — per Global Constraints, this is a dated historical record and must stay as it was written.

- [ ] **Step 3: Verify scope**

Run: `grep -n "Pet-Agent" README.md PROGRESS.md` (or equivalent search)
Expected: `README.md` has zero matches; `PROGRESS.md` has exactly one match, at line 125 (the untouched historical paragraph).

- [ ] **Step 4: Commit**

```bash
git add README.md PROGRESS.md
git commit -m "docs: README/PROGRESS 里的 Pet-Agent 改成 Kibo(保留历史记录段落不动)"
```

---

### Task 4: Final verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS, same count as before this plan (599/599, per the last completed feature) — none of these changes touch tested logic.

- [ ] **Step 3: Full build**

Run: `pnpm build`
Expected: PASS (typecheck + electron-vite build, all three bundles).

- [ ] **Step 4: Confirm no stray "Pet-Agent"/"pet-agent" left in live source**

Run: `grep -rn "Pet-Agent\|pet-agent" package.json electron-builder.yml src/ README.md` (should only match, if anything, comments/identifiers explicitly marked out-of-scope by Global Constraints — currently that's nothing in these paths except the internal `PetAgentAutomation` identifier in `src/main/automation/win32Bridge.ts`, which is a different string and won't match this exact pattern anyway — a clean run should show zero output, or `win32Bridge.ts`'s errors don't match this exact casing/pattern, so zero output is expected).

- [ ] **Step 5: Real-app smoke test (manual, likely deferred)**

Run `pnpm preview`. Expected: tray icon shows the new robot-cat design (not luluka), tray tooltip reads "Kibo", Settings window title bar and in-page header both read "Kibo 设置". This requires a real display — if unavailable in the execution environment, state that explicitly and defer to the user rather than looping on it.
