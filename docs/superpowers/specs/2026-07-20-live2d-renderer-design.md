# Kibo Live2D 渲染模式 — 设计文档

> 2026-07-20 与用户 brainstorming 确认。目标是在 Windows 版 Kibo 中，把 Live2D Cubism 3/4/5 模型作为新的默认宠物显示方式，同时保留现有 Agent、状态机、热切换、人设、台词、语音和记忆能力。产品公开发行时只提供播放器壳，不随程序分发模型，并允许用户导入自己有权使用的任意 Live2D 模型。

## 1. 背景与结论

当前宠物窗口由 `SpritePlayer` 在 2D Canvas 上播放 8×13 WebP 精灵图集。`PetController` 以约 30 Hz 驱动 `idle/walk/drag/sleep/talk` 等状态，并依赖 `SpritePlayer.play()` 与逐像素 `getImageData()` 命中检测。窗口固定为 256×288；宠物包通过 `pet.json` 描述精灵图和动画。

这套实现无法直接承载 Live2D：

- Live2D 是包含 MOC、纹理、Motion、Expression、Physics、Pose 等资源的多文件格式。
- 模型更新与 WebGL 绘制需要独立的高频渲染循环。
- 任意模型的 Motion Group、HitArea、尺寸和参数命名都不相同。
- 当前逐鼠标事件读取 Canvas 像素会在 WebGL 模式下造成 GPU→CPU 同步。
- 固定窗口尺寸不适合不同长宽比的模型。

经比较，确定使用以下方案：

```text
Electron Renderer
  └─ PetRenderer 内部接口
       ├─ SpritePetRenderer（兼容已有宠物）
       └─ Live2DPetRenderer（新默认）
            └─ PixiJS 8 WebGL
                 └─ untitled-pixi-live2d-engine
                      └─ 官方 Cubism 5 Core
```

不采用：

- 直接基于官方 Cubism Web Framework 编写全部播放器能力：控制力最高，但模型生命周期、动作、命中、缩放、口型和 Pixi 集成均需自行实现，开发与维护成本过高。
- `pixi-live2d-display`：主要面向 PixiJS 6，维护活跃度和现代 Cubism 支持弱于选定方案。
- Kage/Live2DViewerEX 独立进程：会引入第二个窗口、第二个 WebGL/Chromium 上下文、WebSocket、双进程生命周期和额外打包复杂度，无法与 Kibo 现有拖拽、状态机和热切换紧密集成。

选定的社区引擎只能通过 `Live2DPetRenderer` 使用，业务代码不得依赖其内部对象。若未来更换为官方 Cubism Framework，只替换 Renderer 实现。

## 2. 已确认的产品边界

### 2.1 目标

- Windows 10/11 x64 优先。
- 只支持 Cubism 3/4/5 的 `*.model3.json`；不支持 Cubism 2.1 `*.model.json`。
- 用户选择普通 `model3.json` 即可导入，不要求预先制作 Kibo 宠物包。
- 不随应用分发任何 Live2D 模型。
- 保留并复用现有 `persona.md`、`lines.json`、`voice/` 和宠物作用域 `memory/`。
- 保留现有精灵宠物读取能力，作为兼容与回滚路径；新导入默认使用 Live2D。
- 模型活动时目标 60 FPS，待机/睡眠自动降帧，不可见时停止渲染。
- 模型导入、热切换和 GPU 故障不能拖垮 Agent、托盘、设置或聊天能力。
- 用户可以通过设置界面调整模型尺寸、位置、锚点、朝向、视线追踪和动作映射。

### 2.2 非目标

- Cubism 2.1。
- macOS、Linux。
- 摄像头面捕、全身动作捕捉。
- 多模型同屏。
- Live2D 模型编辑器或 Motion 文件生成器。
- 用户自定义 JavaScript、HTML、着色器或插件代码。
- LLM 自动制作动作或修改模型文件。
- 随应用提供演示、默认或测试模型。

## 3. 许可与发行边界

本产品允许用户通过添加文件使用不特定数量的模型，明确符合 Live2D 对“Expandable Application（可扩展应用）”的描述。公开发行前需要 Live2D 审核并签署专项出版许可；一般用户和小规模团队不自动豁免。完全免费应用原则上也不保证获得批准。

因此设立硬门槛：

- 开发、内部 PoC 和本地测试可以先进行。
- 未取得 Live2D 对该产品形态的书面批准前，不公开发行包含 Cubism Core 的完整播放器。
- 发布版按最终协议加入指定 Logo、声明、EULA 条款、Showcase 信息、销售报告或收入分成要求。
- EULA 明确：应用不提供模型；用户只能导入自己有权使用的模型；模型版权责任由导入者承担。
- `THIRD_PARTY_NOTICES` 记录 PixiJS、社区引擎、Cubism Framework/Core 及对应版本和许可。

官方参考：

- https://www.live2d.com/en/sdk/license/
- https://www.live2d.com/en/sdk/license/expandable/

本文只记录产品发布门槛，不构成法律意见；最终以 Live2D 的书面审核结果和签署协议为准。

## 4. 宠物包 v2

### 4.1 可区分渲染类型的清单

新增 `schemaVersion: 2` 和 `render` 判别联合：

```json
{
  "schemaVersion": 2,
  "id": "my_character",
  "displayName": "My Character",
  "description": "",
  "render": {
    "type": "live2d",
    "model": "model/character.model3.json",
    "viewport": {
      "width": 360,
      "height": 480,
      "resolutionCap": 1.5
    },
    "transform": {
      "scale": 1,
      "offsetX": 0,
      "offsetY": 0,
      "anchorX": 0.5,
      "anchorY": 1,
      "bubbleAnchorX": 0.5,
      "bubbleAnchorY": 0
    },
    "interaction": {
      "mirrorOnWalk": true,
      "mouseTracking": true,
      "lipSyncParameter": "ParamMouthOpenY"
    },
    "stateMap": {
      "idle": {
        "motionGroup": "Idle",
        "selection": "random",
        "loop": true
      },
      "greet": {
        "motionGroup": "TapBody",
        "selection": "random",
        "loop": false,
        "fallback": "idle"
      },
      "talk": {
        "motionGroup": "Idle",
        "selection": "random",
        "loop": true,
        "lipSync": true,
        "fallback": "idle"
      }
    }
  }
}
```

`stateMap` 的键沿用 Kibo 已有视觉状态：

```text
idle
walk-left
walk-right
drag
sleep
greet
thinking
talk
happy
sad
cry
surprised
love
```

每个映射允许：

- `motionGroup`：模型 Motion Group。
- `selection`：`random`、`sequential` 或固定索引。
- `loop`：必要时覆盖模型动作的循环标记。
- `expression`：动作期间应用的可选 Expression。
- `lipSync`：该状态是否接受口型包络。
- `fallback`：目标组不存在或播放失败时回退的 Kibo 状态，最终必须收敛到 `idle`。

`voice` 继续保留在清单顶层，沿用当前 GPT-SoVITS/Genie-TTS 配置。

### 4.2 精灵格式兼容

现有无 `schemaVersion`、包含 `spritesheetPath/sheet/animations` 的清单继续合法。解析器把它归一化为内部 `render.type = "sprite"`，交给 `SpritePetRenderer`。不要求现有宠物立即迁移，不改变其“左右行走必须使用独立绘制行”的规则。

### 4.3 目录结构

```text
userData/pets/my_character/
├─ pet.json
├─ persona.md              可选
├─ lines.json              可选
├─ voice/                  可选
├─ memory/                 运行时自动创建
└─ model/
   ├─ character.model3.json
   ├─ character.moc3
   ├─ textures/
   ├─ motions/
   ├─ expressions/
   ├─ physics3.json
   └─ pose3.json
```

没有 `persona.md` 时沿用现有空人设降级；没有 `lines.json` 时不说环境台词；没有 `voice/` 时保持无 TTS。导入器不替用户编造角色设定。

## 5. 导入流程

### 5.1 用户流程

1. 用户点击“导入 Live2D 模型”。
2. 文件选择器选择一个 `*.model3.json`。
3. 以该文件所在目录为模型源根目录；模型引用不得逃出该目录。
4. 主进程解析 `model3.json`，验证 MOC、纹理、Motion、Expression、Physics、Pose 和 UserData 引用。
5. 导入预览显示模型，用户填写显示名称并调整尺寸、位置、脚底锚点和气泡锚点。
6. 导入器列出 Motion Group，按常见命名给出状态映射建议，用户可以修正。
7. 将源目录复制到 `userData/pets/.staging/<random>/model/`。
8. 生成并验证 Kibo `pet.json`。
9. 完整验证成功后，原子移动到 `userData/pets/<id>/`。
10. 通过准备—提交热切换立即启用，不要求重启。

若源目录已有合法的 Kibo `pet.json/persona.md/lines.json`，可以复用；其中所有路径仍需重新验证，且 `render.model` 必须指向用户选择的模型。

### 5.2 自动动作映射

导入器按不区分大小写的组名和关键词提出候选：

- `idle` → `Idle`。
- `walk-*` → `Walk`。
- `drag` → `Drag`、`Flick`。
- `sleep` → `Sleep`。
- `greet` → `Greeting`、`TapBody`。
- 情绪状态 → 对应英文情绪词、Expression 名称或用户选择。

自动匹配只生成建议，不伪造不存在的 Motion。缺失映射不阻止导入，运行时回退到 Idle 或自然呼吸/眨眼。

### 5.3 安全验证

- 拒绝绝对路径、UNC 路径、盘符路径、`..` 穿越和解码后穿越。
- 拒绝源目录中的符号链接、Windows junction 和 reparse point。
- 只复制数据文件，不执行其中的 JS、HTML、EXE、DLL、BAT、CMD、PS1 或其他脚本。
- 路径解析后再次确认目标仍位于宠物根目录内。
- ID 只允许字母、数字、下划线和连字符；冲突时拒绝覆盖。
- staging 未完整提交前不出现在宠物列表；失败或下次启动时清理残留。

软性能预算：

```text
纹理不超过 4 张 4096×4096
Drawable 不超过约 800
模型目录不超过 500 MB
```

超过软预算时允许导入，但显示性能警告并默认降低分辨率或帧率。

安全硬限制：

```text
单张纹理最大 8192×8192
纹理数量最大 16
目录总大小最大 1 GB
单个 JSON 最大 10 MB
递归文件数量最大 5000
```

超过硬限制直接拒绝。

## 6. 受限模型资源协议

Live2D 引擎必须按相对路径加载多文件资源，因此不继续使用单文件 Data URL，也不把本机绝对路径交给 Renderer。

主进程注册：

```text
kibo-pet://<session-token>/model/character.model3.json
kibo-pet://<session-token>/model/textures/texture_00.png
kibo-pet://<session-token>/model/motions/idle.motion3.json
```

协议设计：

- 在 `app.ready` 之前以 `standard:true`、`secure:true`、`supportFetchAPI:true` 注册。
- 不启用 `bypassCSP`、Service Worker、扩展或其他无关权限。
- `session-token` 是每次加载生成的随机不透明令牌，只映射到一个已验证的宠物根目录。
- Handler 对 URL 解码、规范化、扩展名、根目录包含关系和 reparse point 再验证。
- 只返回允许的模型资源，并设置正确 MIME；不支持列目录。
- 热切换完成或失败后撤销旧/临时令牌。
- Renderer 只收到 `resourceBaseUrl` 和清单，不收到 Windows 文件路径。

宠物窗口 CSP 只在模型所需位置加入 `kibo-pet:`：

```text
connect-src 'self' kibo-pet:
img-src 'self' data: kibo-pet:
media-src 'self' kibo-pet:
```

其余安全基线保持：`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、不关闭 `webSecurity`。

## 7. Renderer 边界

### 7.1 接口

```ts
interface PetRenderer {
  load(source: PetRenderSource): Promise<void>
  playState(state: PetVisualState): void
  setFacing(direction: 'left' | 'right'): void
  setLipSync(level: number): void
  hitTest(x: number, y: number): PetHitResult
  resize(viewport: PetViewport): void
  setVisible(visible: boolean): void
  destroy(): Promise<void>
}
```

`PetController` 只依赖此接口。它继续负责：

- Kibo 行为状态。
- 约 30 Hz 状态机 tick。
- Windows 宠物窗口移动。
- 拖拽、睡眠、情境信号和 Agent 事件。
- 状态改变时调用 `playState()`。

`Live2DPetRenderer` 负责：

- Pixi Application、WebGL Context 和 Ticker。
- Cubism 模型、纹理、Motion、Expression 和参数更新。
- 模型变换、朝向、命中、鼠标追踪、口型和资源释放。

业务状态机 tick 与画面刷新解耦，不在 60 FPS 循环中执行 IPC、Agent 逻辑或窗口移动。

### 7.2 动作优先级

```text
用户交互动作
  > 说话/情绪动作
  > 状态切换动作
  > Idle Motion
  > 呼吸、眨眼和视线等自然参数
```

一次性动作结束后回到 `PetController` 当前持续状态。Idle 不得打断点击、问候或说话。目标 Motion 不存在或播放失败时按 `fallback` 收敛到 Idle。

### 7.3 朝向

Live2D 模型通常没有独立左右行走动作。默认向左时水平镜像，向右时使用原始方向；`mirrorOnWalk:false` 可关闭。镜像只作用于模型变换，HitArea、气泡锚点和窗口坐标使用统一变换后的结果。

## 8. 交互、自然行为和口型

### 8.1 点击穿透与部位命中

移除逐鼠标事件 `canvas.getImageData()`：

1. 优先使用 `model3.json` 中的 HitArea。
2. 将 HitArea 几何变换到屏幕坐标后命中。
3. 模型没有 HitArea 时退化为变换后的模型可见边界。
4. 命中返回 `Head/Body/...`，用于选择互动 Motion。
5. 非模型区域继续通过 `setIgnoreMouseEvents(true, { forward:true })` 穿透。

该方案不保证模型内部每个细小透明空洞都穿透，但避免常驻 GPU→CPU 像素读回。

现有交互语义保持：

- 单击：开关对话框。
- 双击：`poke`。
- 拖动：移动窗口并进入 `drag`。
- 拖动期间暂停视线追踪，放下后平滑恢复。

### 8.2 视线、呼吸、眨眼

- 鼠标位于宠物附近时有限度驱动眼睛和头部；离开后平滑回正。
- 睡眠时停止追踪。
- 优先使用模型已有呼吸、眨眼和参数配置。
- 模型没有相应参数时不写入未知参数。
- 自然参数不得覆盖高优先级 Motion 正在驱动的值。
- 设置页允许关闭鼠标追踪。

### 8.3 TTS 口型

```text
Voice PCM Chunk
  ├─ PcmPlayer 播放
  └─ LipSyncEnvelope 计算与播放时间对齐的 RMS
        └─ PetRenderer.setLipSync()
              └─ ParamMouthOpenY 或清单指定参数
```

- 不重复解码音频，在 PCM 缓冲进入现有播放器时计算音量包络。
- 使用 attack/release 平滑。
- 语音播放结束、停止、打断、宠物切换和错误时平滑归零。
- 没有口型参数时只播放 Talk Motion。
- TTS 未启用时不生成随机假口型。

## 9. 动态窗口与锚点

移除固定 `256×288` 假设。窗口逻辑尺寸来自 `render.viewport`，并夹取到：

```text
最小 192×256
默认 360×480
最大 800×900
```

GPU 实际像素再乘受限 DPR。

窗口改变尺寸或切换模型时固定“脚底中心点”：

```text
旧窗口脚底中心 = 新窗口脚底中心
```

随后按当前显示器工作区夹取，因此切换不同身高模型时不会跳离桌面位置。气泡使用 `bubbleAnchorX/Y`，默认位于角色头顶中央，不再仅依赖窗口左上角。

导入预览和设置页提供：

- 缩放和水平/垂直偏移。
- 窗口宽高。
- 脚底锚点、气泡锚点。
- 镜像开关。
- 鼠标追踪。
- 状态到 Motion Group/Expression 的映射。
- HitArea 点击测试和动作预览。

配置保存前验证，成功后热更新 Renderer。

## 10. 性能策略

Windows 默认使用 WebGL，不启用仍存在实现差异的 WebGPU。

| 场景 | 目标帧率 |
|---|---:|
| 拖拽、行走、说话、动作播放 | 60 FPS |
| 普通待机 | 30 FPS |
| 睡眠 | 15 FPS |
| 隐藏、最小化、锁屏 | 0 FPS |

具体措施：

- 一个宠物窗口只创建一个 Pixi Application、一个 WebGL Context 和一个私有 Ticker。
- 热切换只替换模型，不重建 Electron Renderer。
- `resolution = min(devicePixelRatio, resolutionCap)`，默认 `resolutionCap=1.5`。
- 默认关闭 MSAA；透明边缘由模型纹理处理。
- 4096px 以上纹理默认使用引擎 `single-auto` LOD。
- 不强制唤醒独立显卡，由 Chromium 选择 GPU，避免常驻桌宠异常耗电。
- 保持 Electron `backgroundThrottling`，并在页面不可见时显式停止 Ticker。
- 销毁模型时释放纹理、Motion、Expression、Ticker listener、Cubism 实例和资源令牌。

## 11. 无闪烁热切换

采用准备—提交协议：

1. 主进程预验证目标宠物，创建临时资源令牌。
2. Renderer 在旧模型仍显示时加载新模型并完成首帧。
3. Renderer 返回 `ready`。
4. 主进程提交 `activePetId`，切换宠物作用域 Agent 会话、记忆、情境监听和语音。
5. Renderer 原子交换舞台模型。
6. 销毁旧模型并撤销旧令牌。

任一步失败：

- 旧宠物继续显示和运行。
- 不修改 `activePetId`。
- 不切换 Agent/记忆/语音会话。
- 撤销临时令牌和临时模型资源。
- 设置页显示结构化错误。

这修正当前“主进程先切会话、Renderer 后加载身体”可能出现的视觉/会话不一致。

## 12. 错误与 GPU 恢复

用户可见错误码：

```text
MODEL_MANIFEST_INVALID
MODEL_ASSET_MISSING
MODEL_PATH_OUTSIDE_ROOT
MODEL_TOO_COMPLEX
MODEL_UNSUPPORTED
MODEL_LOAD_TIMEOUT
WEBGL_UNAVAILABLE
WEBGL_CONTEXT_LOST
MODEL_SWITCH_FAILED
```

导入错误显示具体文件。运行错误提供“重试”“打开模型目录”“切换其他宠物”操作。

监听 `webglcontextlost`：

1. 阻止默认销毁流程并停止 Ticker。
2. 保留 Agent、托盘、设置和聊天。
3. 显示轻量错误占位。
4. `webglcontextrestored` 后重新加载当前模型一次。
5. 第二次失败后停止自动重试，引导用户更换模型。

单个坏模型不得导致整个 Electron 应用退出。

## 13. Electron 与依赖前置升级

当前 `package.json` 使用 Electron `^31.0.0`，该主版本已经停止支持。公开发行前先单独升级到当时仍受官方支持的稳定版；按 2026-07-20 的基线，目标为 Electron 43.x 最新补丁，并同步升级兼容的 electron-vite、electron-builder 和配置。

升级任务与 Live2D 功能提交分离，并先回归：

- 透明置顶窗口和点击穿透。
- 托盘、全局快捷键。
- IPC 和 context isolation/sandbox。
- 设置、聊天、气泡、待办。
- 屏幕捕获和桌面/浏览器控制。
- 语音 Sidecar。
- Windows 安装包。

依赖使用准确版本，不使用 `^` 浮动：

```text
pixi.js
untitled-pixi-live2d-engine（首选验证 1.3.5）
live2dcubismcore.min.js（与官方 Cubism 5 SDK R5 对齐）
```

Cubism Core 本地随安装包提供，不依赖 CDN，并记录来源版本和 SHA-256。

## 14. 验收标准

在 Windows 集成显卡参考机上，分别使用轻量和普通复杂度的本地授权模型：

| 指标 | 目标 |
|---|---|
| 活动动画 | 目标 60 FPS；连续 5 分钟掉帧率低于 5% |
| 普通待机 | 稳定限制在约 30 FPS |
| 睡眠 | 稳定限制在约 15 FPS |
| 隐藏窗口 | Ticker 停止，无持续模型渲染 |
| 活动帧时间 | P95 不超过约 20 ms |
| 首次显示 | 普通模型在 SSD 上不超过 3 秒 |
| 状态/动作响应 | 低于 100 ms |
| 热切换 | 旧模型持续显示，无透明空窗 |
| 资源泄漏 | 20 次 A/B 切换后无逻辑资源单调增长 |

泄漏检查：

- JS Heap。
- Pixi Texture 数量。
- WebGL Texture/Buffer 数量。
- Cubism 模型实例。
- Ticker listener。
- 协议 session token。

不单独以 Windows 工作集为判定，因为 Chromium 会保留内存池。

## 15. 测试策略

### 15.1 纯逻辑 Vitest

- v1 精灵和 v2 Live2D 清单解析、归一化。
- 路径、ID、资源限制。
- Motion Group 自动匹配。
- 状态回退、动作优先级和一次性动作结束。
- 锚点、动态窗口、脚底位置保持。
- DPR/FPS 策略。
- MIME 与允许扩展名。

### 15.2 主进程集成测试

- staging → 验证 → 原子提交。
- 缺失 MOC、纹理、Motion、Expression、Physics、Pose。
- `..`、绝对路径、URL 编码穿越、UNC。
- symlink、junction、reparse point。
- 过期/未知协议 token。
- 超限文件、目录和纹理。
- 切换失败不修改活跃宠物和会话。
- 启动时清理残留 staging。

### 15.3 Renderer 测试

使用模拟 Live2D 引擎，不在 CI 分发模型：

- `PetRenderer` 生命周期。
- 动作优先级、回退和结束。
- Ticker 变速、隐藏暂停。
- 口型 attack/release 和停止归零。
- 加载成功/失败的热切换。
- 旧模型与所有 listener/texture 的销毁。
- WebGL Context Lost/Restored。

### 15.4 Windows 真机矩阵

- Windows 10 22H2、Windows 11。
- 100%、150%、200% DPI。
- 单屏和不同 DPI 双屏。
- Intel/AMD 集成显卡、NVIDIA 独立显卡。
- 跨屏拖动、显示器休眠、锁屏恢复。
- 点击、双击、拖拽、透明区域穿透。
- 动态窗口、气泡和对话框跟随。
- 安装版与开发版。

完整视觉和性能测试使用本地、gitignored 的授权模型；仓库和安装包均不携带测试模型。

## 16. 实施分段

详细任务拆分留给后续 writing-plans，但实现顺序固定为：

1. Electron/构建链升级与回归。
2. 宠物包 v2、路径验证、导入器和资源协议。
3. `PetRenderer` 抽象与精灵兼容驱动。
4. PixiJS/Live2D 驱动的最小模型加载、动作和销毁。
5. 动态窗口、锚点、命中和无闪烁热切换。
6. 鼠标追踪、口型和设置/导入预览。
7. 安全、故障恢复、性能基准和 Windows 真机验收。
8. 取得并落实 Live2D 发布许可后，才制作公开发行包。

每一段必须保持可构建、可测试；涉及主进程、preload、Renderer 或窗口的变化除自动检查外必须运行真实 Electron 应用目视验证。

## 17. Phase 2 前置真实模型加载 Spike 结论(2026-07-21)

详细设计、实施计划见 `docs/superpowers/plans/2026-07-20-live2d-phase4-prespike-design.md` 与 `docs/superpowers/plans/2026-07-20-live2d-phase4-prespike.md`。用户在真机(Windows,worktree `live2d-phase4-prespike`)对两个真实购买模型跑通了全部 6 组 `model × mode` 组合,以下是结论,直接决定 Phase 2/4 的范围。

### 17.1 贴图尺寸/GPU 性能(spike 的核心目的)

- `MAX_TEXTURE_SIZE` 在软渲染(SwiftShader)和硬件加速下**都是 16384**,这台测试机上没有差异——不能假设软渲染的贴图上限更保守,至少这条不是软/硬渲染分支要单独处理的问题。
- 16384² 单贴图(`白-免费版`,~1GB 未压缩)在两种模式下都**能加载成功**,但**渲染性能明显更差**:
  - 软渲染下约 27 FPS,10×4096² 分块贴图的 `茕兔` 模型软渲染下约 90–102 FPS(慢 ~3.3 倍)。
  - 硬件加速下约 76 FPS,`茕兔` 硬件加速下约 146–149 FPS(慢 ~2 倍)。
  - 加载耗时也更长(~1.5–2s vs ~0.4–0.5s),尽管贴图数量更少(1 张 vs 10 张)。
- 硬件加速全面比软渲染快 1.5–3 倍。免费版模型软渲染下 27 FPS 远达不到 spec §10/§14 的 60FPS 目标,说明 **Phase 0 的硬件加速开关不能停留在"实验性可选"——达到 60FPS 目标事实上依赖硬件加速**,这是本次 spike 对整个改造优先级的一个修正。
- **结论,Phase 2 资源协议动作项**:导入器需要贴图尺寸预算控制(如超过某阈值——建议 4096 或 8192——警告或强制降采样),这不是"不能用"的问题,是"用了明显更卡"的问题,数据已经量化。

### 17.2 引擎真实 API 形状(验证/推翻设计文档假设)

- `Live2DModel.from()` / `model.hitTest()` / `model.internalModel.coreModel.setParameterValueById()`/`getParameterValueById()` 全部按设计文档假设的接口形状工作,包括手动写参数(写 30 读回 30)确认不会被自动更新覆盖——**验证了 Phase 6"鼠标追踪叠加在待机动画上"这个设计假设可行**。
- `hitTest()` 在两个测试模型上都返回空数组——**这是预期行为,不是 bug**:两个模型的 `model3.json` 都没有声明任何 `HitAreas`,不代表引擎的命中检测有问题。
- **必须使用 `untitled-pixi-live2d-engine/cubism` 子路径导入,不能用默认导出**:默认导出(`.`)把 Cubism 2 legacy 代码和 Cubism 3+ 代码打包在一起,模块顶层无条件要求真的加载官方 legacy 运行时(`live2d.min.js`),纯 Cubism 3+ 场景(本项目场景)完全用不上这部分。`./cubism` 子路径没有这个依赖。
- **Live2D 官方 Cubism Core 运行时(`live2dcubismcore.min.js`)不通过 npm 分发**,必须从 Live2D 官网(Cubism SDK for Web)单独下载,这是 Phase 4 实际打包时必须处理的外部依赖获取步骤,不是代码能解决的——**印证了 remaining-work 清单 Phase 8"取得 Live2D 发布许可"这条隐患是真实存在的,不是假设性风险**。
- **发现一处版本不兼容 bug**:`untitled-pixi-live2d-engine@1.3.5` 编译产物假设 Cubism Core 的 `Model` 暴露 `drawables.renderOrders` 属性,但官方最新 Cubism Core 5(`06.00.0001`,CubismSdkForWeb-5-r.5)把这个字段设为 `private`,只能通过 `getRenderOrders()` 方法取——`drawables` 下其余几十个字段(count/ids/textureIndices/vertexPositions 等)都正常,只有这一个字段受影响,但足以让每帧渲染崩溃(黑屏)。已验证一个运行时 patch(用 `getRenderOrders()` 手动回填 `drawables.renderOrders`)能绕过。**Phase 4 正式引入前必须**:(a) 检查 `untitled-pixi-live2d-engine` 是否已有修复此问题的更新版本;(b) 若没有,要么锁定一个与该引擎版本兼容的旧版 Cubism Core,要么把这个 patch 做成正式的兼容层代码,而不是假设"随便下载最新官方 SDK 就能用"。
- 零动作文件模型(`白-免费版`)的物理驱动自动呼吸/眨眼:实测 `ParamBreath`/`ParamEyeLOpen` 在所有采样点、所有模型上都返回 `null`——**不是结论性证据**,不确定是"这些具体模型没有这些标准命名参数"还是"物理没有真的自动驱动"。Phase 4 如果要做这个功能,应该用 `getParameterCount()`/遍历真实参数 ID 列表判断,不要假设 `ParamBreath`/`ParamEyeLOpen` 这类约定俗成的命名一定存在。

### 17.3 VTube-Studio 游离资源找回(spec §3 隐患 3.2 之外新增的验证)

- 手工合成补全 `Expressions` 字段后,`model.expression(name)` **确认可以正常播放**游离的 `.exp3.json` 表情文件——**这条路径可行**,Phase 2 资源协议应该实现"扫描游离 `*.exp3.json`/`*.motion3.json` 文件 + 合成 `model3.json` 补丁"这一步(比对着已验证工作的 `scripts/live2d-spike/fixtures/build-fixture.cjs` 的思路即可,不需要重新设计)。
- `model.motion(group, index)` 显式调用返回 `false`,但**间接观察到动作确实被加载并播放了**(见下 17.4)——很可能是引擎自身的待机动作自动选择机制抢先播放/占用了该动作组,和我们显式调用的优先级语义有关,需要 Phase 4 实现时进一步查证 `MotionPriority` 语义,不是"动作找回完全不可行"的结论。

### 17.4 意外发现:购买模型可能自带防盗版水印保护

原始未修改的 `茕兔pack/茕兔/茕兔.model3.json`(没有 `Expressions`/`Motions`)加载后会**永久停留**在一张"请使用水印按键切换模型(VTube Studio Shift+P)"的卖家版权警告图上;只有加载合成补全过、包含真实找回动作(`Scene1.motion3.json`)的 `model3.json` 时,才会在约 1 秒后自动切到真实角色模型——这本身副作用式地验证了 17.3 的动作找回是有效的。**这是一个之前完全没预料到的真实世界导入需求**:真实产品导入这类卖家自带保护机制的模型时,如果只按标准 `model3.json` 字段加载、不做任何补充处理,用户会一直看到卖家的水印图而不是角色本身。Phase 2 资源协议设计需要把这个场景纳入考虑范围(至少要能识别并提示用户"这个模型可能需要额外处理才能正常显示")。

### 17.5 构建链路踩坑记录(Phase 4 正式实现前必读,避免重踩)

- `require('untitled-pixi-live2d-engine')` **不安全**:该包 `package.json` 的 `require` 导出条件指向的文件实际是通过较新的 Node/Electron 同步 `require(esm)` 互操作加载的(因为包自身是 `"type":"module"`),这条路径下会拿到损坏的 `pixi.js` 绑定,导致所有 `class X extends pixi_js.Y` 在模块求值阶段崩溃(`Class extends value undefined`)。
- 改用真正的浏览器原生 `import` 又会撞上另一个问题:原生 ESM 解析器要求**整条依赖链**(不只是直接 import 的包,包括 pixi.js 自己的传递依赖如 `eventemitter3`)都能被裸模块说明符解析,`pnpm` 的非提升 `node_modules` 布局下手写 import map 逐个补是不现实的。
- 最终方案:用 **esbuild 把渲染代码连同两个包的完整依赖树打包成一个自包含文件**(`--bundle --format=esm --platform=browser`,Node 内置模块如 `node:fs` 标记 `--external` 保留为运行时 `require()` 调用,由 Electron 的 `nodeIntegration` 提供的全局 `require` 解析)。**Phase 4 正式把这个引擎引入生产依赖时,必须走 bundler 路径(esbuild/vite 均可),不能假设 `electron-vite` 默认的模块解析对这个包"开箱即用"**——这是一项真实的集成复杂度,需要写进 Phase 4 的实施计划任务拆分里,不是可以忽略的细节。
