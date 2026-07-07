# MVP-09 设计:UI 选宠物 + 导入宠物包

> 日期:2026-07-04 · 状态:设计已确认,待写实现计划(writing-plans)
> 承接现有「换宠物 = 改 settings.json 的 activePetId 后重启」既定流程。本 MVP 把这套后端能力搬到设置窗 UI 上,并新增「导入外部宠物包」。**不改切换核心逻辑**。

---

## 1. 目标(一句话)

让用户在**设置窗**里从下拉列表选宠物(内置 + 已导入),并能**导入一个外部宠物包文件夹**;切换沿用现有「重启后生效」路径。零热切换、零新窗口、零新依赖。

## 2. 背景与既有基建(为什么这是小增量)

- 宠物在**启动时加载一次**:[src/main/shell/index.ts:57-73](../../../src/main/shell/index.ts) 读 `activePetId` → `ensurePetHome` 播种/定位 `userData/pets/<id>` → `loadPet`。运行期无热重载。
- `activePetId` 已是 `AppSettings` 字段([src/shared/llm.ts](../../../src/shared/llm.ts)),已过 [normalizePetId](../../../src/main/config/settings.ts)(纯字母数字下划线连字符,防路径穿越),拼错/缺包会**自动回退默认宠物**([index.ts:66-71](../../../src/main/shell/index.ts))。
- 设置窗([src/renderer/settings.ts](../../../src/renderer/settings.ts) + settings.html)已存在,但只把 `activePetId` **原样回填/保存**,无选择器。
- 宠物包是自包含文件夹 `pets/<id>/`,由 [parsePetManifest](../../../src/shared/petPackage.ts) 校验(必需字段 + `sheet` 图集几何 + 非空 `animations`)。`ensurePetHome` 已建立「首启从内置只读包整包 `cpSync` 到 userData、记忆随宠物」模型([src/main/pets/petHome.ts](../../../src/main/pets/petHome.ts))。

**关键复用洞察**:切换的全部难点(定位/播种/容错回退/记忆迁移)在 `ensurePetHome` + `index.ts` 里已解决。本 MVP 只需:① 枚举可选宠物给 UI;② 把外部文件夹**校验后落到 `userData/pets/<id>`**,使其对枚举与 `ensurePetHome` 可见;③ 让 UI 写 `activePetId` 并提供重启。三者都不触碰切换核心。

## 3. 已确认的决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 生效方式 | **重启后生效** | 复用既定路径,无热切换的状态一致性风险(对话/加工中途换皮、memory/persona 重绑) |
| 导入形式 | **选文件夹** | 零新依赖(Node fs 即可),契合 petHome 自包含模型 |
| 选择器 UI | **现有设置窗加一栏**,下拉只显示名字(无缩略图) | 改动最小,与 provider/search 同居一窗 |
| id 冲突 | **拒绝并提示改名**,绝不覆盖 | 保护已有目录里用户改过的 persona 与积累的 memory |

## 4. 架构(部件与边界)

### 4.1 `src/main/pets/petCatalog.ts`(新增,纯逻辑 + 薄 I/O)

- `listPets(dirs: { bundledPetsDir: string; userPetsDir: string }): PetSummary[]`
  - 扫描两来源子目录,各读 `pet.json` 过 `parsePetManifest`;按 `id` 去重,**userData 优先**(内置包首启会被播种到 userData,同 id 视为同一只)。
  - 解析失败/缺 `pet.json` 的目录**跳过并 `console.warn`**,一只坏包不炸整表。
  - 产出 `{ id, displayName, description }[]`,按 `displayName` 排序。
- `importPetFolder(srcDir, userPetsDir, opts: { bundledPetsDir }): ImportResult`
  - 校验链(任一失败即返回判别式失败,不复制):
    1. 读 `srcDir/pet.json` → `parsePetManifest`(必需字段 / `sheet` / `animations`)。
    2. `manifest.spritesheetPath` 指向的文件在 `srcDir` 下**存在**。
    3. `manifest.id` 满足 `normalizePetId` 规则(复用同一正则,防路径穿越)。
    4. **冲突检查**:`userPetsDir/<id>` 或 `bundledPetsDir/<id>` 已存在 → 失败 `reason:'id-exists'`。
  - 通过:`cpSync(srcDir, join(userPetsDir, id), { recursive: true })`,返回 `{ ok:true, pet: PetSummary }`。
  - 返回类型:
    ```ts
    type ImportResult =
      | { ok: true; pet: PetSummary }
      | { ok: false; reason: 'no-manifest' | 'invalid-manifest' | 'missing-spritesheet' | 'bad-id' | 'id-exists'; message: string }
    ```
  - **纯度边界**:校验/去重是纯逻辑可单测;`cpSync`/`readFileSync`/`existsSync` 是薄 I/O。`dialog.showOpenDialog` 留在 index.ts 的 handler 里,不进本模块(便于测)。

### 4.2 IPC 契约(lockstep 四处联动)

[src/shared/ipc.ts](../../../src/shared/ipc.ts):
- 常量:`LIST_PETS: 'pets:list'`、`IMPORT_PET: 'pets:import'`、`RELAUNCH_APP: 'app:relaunch'`。
- 类型:`PetSummary { id: string; displayName: string; description: string }`、`ImportResult`(见上)。
- `SettingsApi` 追加:`listPets(): Promise<PetSummary[]>`、`importPet(): Promise<ImportResult>`、`relaunch(): void`。

[src/main/shell/index.ts](../../../src/main/shell/index.ts):三个 handler。
- `LIST_PETS` → `listPets({ bundledPetsDir: petsDir(appRoot), userPetsDir: join(userData,'pets') })`。
- `IMPORT_PET` → `dialog.showOpenDialog({ properties:['openDirectory'] })`;取消则返回 `{ ok:false, reason:'cancelled', message }`(或直接 `null`,UI 静默);否则委托 `importPetFolder`。
- `RELAUNCH_APP` → `app.relaunch(); app.quit()`。

[src/preload/index.ts](../../../src/preload/index.ts):`settingsApi` 暴露三方法(invoke/send 照抄现有范式)。

### 4.3 设置窗 UI([src/renderer/settings.ts](../../../src/renderer/settings.ts) + settings.html)

新增顶部「宠物」栏:
- `<select>` 宠物下拉:初始化时 `listPets()` 填充,选中当前 `activePetId`(记为 `currentActivePetId`)。
- 「导入宠物包…」按钮 → `importPet()`:
  - 成功 → 重新 `listPets()` 刷新下拉,选中新 id,状态区提示「已导入:<名字>」。
  - 失败 → 按 `reason` 给中文提示(如 id 冲突:「该 id 已存在,请修改宠物包 pet.json 的 id 后重试」)。
- 保存:下拉当前值并入现有 `setSettings`(写 `activePetId`)。
- 保存后若 `activePetId !== 保存前的值` → 状态区显示「已保存,重启后生效」并显示**「立即重启」按钮** → `relaunch()`。未变则维持现有「✓ 已保存」。

## 5. 数据流

```
[设置窗打开] → settingsApi.listPets() → 主:扫描 bundled+userData/pets → PetSummary[] → 填下拉
[导入] 按钮 → settingsApi.importPet() → 主:选目录 → importPetFolder(校验+cpSync) → ImportResult → UI 刷新/提示
[保存] → setSettings({...activePetId}) → 写盘;若变更 → 显示「重启生效」+ 按钮
[立即重启] → relaunch() → app.relaunch(); app.quit()
[重启后] index.ts 读 activePetId → ensurePetHome 播种/定位 → loadPet(既有路径,零改动)
```

## 6. 安全 / 边界

- **路径穿越**:导入 id 复用 `normalizePetId` 正则;落地路径固定为 `join(userPetsDir, id)`,不用用户提供的路径拼接。
- **不覆盖**:冲突即拒,绝不 `cpSync` 到已存在目录(护住用户 persona/memory)。
- **坏包容错**:枚举跳过坏包;导入前完整校验;即使漏网,`ensurePetHome`/`loadPet` 失败仍有默认宠物回退兜底。
- 本 MVP **不复制/不读取 spritesheet 之外**的可执行内容;宠物包纯资产(json/webp/md/音频),无代码执行面。

## 7. 测试

**单测(纯逻辑)** `src/main/pets/petCatalog.test.ts`:
- `listPets`:两来源去重(userData 优先)、坏包跳过不炸、按名排序、空目录返回 `[]`。
- `importPetFolder`:缺 `pet.json` / 字段不合法 / spritesheet 缺失 / id 非法 / id 与 bundled 冲突 / id 与 userData 冲突 → 各自 `reason`;合法包 → 复制且返回 `PetSummary`。

**真机验收(自动化证明不了窗口渲染)**:`pnpm build && pnpm preview`(dev server 有 5173 竞态)——
1. 下拉列出内置宠物、当前项预选;
2. 导入一只放到全新 id 的宠物 → 出现在下拉;
3. 导入 id 冲突包 → 明确中文报错、未覆盖;
4. 选另一只 → 保存 → 「立即重启」→ 重启后确认已换皮。

## 8. 范围外(YAGNI)

热切换、缩略图预览、.zip 导入、删除/重命名宠物、覆盖式「更新宠物」、宠物商店/远程下载。均待后续按需独立立项。

## 9. 触及文件清单

- 新增:`src/main/pets/petCatalog.ts`、`src/main/pets/petCatalog.test.ts`
- 改:`src/shared/ipc.ts`(常量+类型+SettingsApi)、`src/main/shell/index.ts`(3 handler)、`src/preload/index.ts`(暴露)、`src/renderer/settings.ts` + `settings.html`(宠物栏)
- 无新依赖;不动 `ensurePetHome`/`loadPet`/切换核心。
