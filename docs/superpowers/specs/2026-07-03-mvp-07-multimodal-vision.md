# MVP-07 设计文档 — 多模态识图能力

- **日期**: 2026-07-03
- **状态**: 待用户评审
- **前置**: MVP-06(打包 + 可移植宠物包 + IPC 校验)已完成、真机验收通过,`develop`/`main` 同处 `68a57ed`
- **对应总设计**: `docs/superpowers/specs/2026-06-26-desktop-pet-agent-design.md` §5(内核)、§11(安全基线);路线图「更远期」的多模态方向

---

## 1. 目标与范围

给桌面宠物加**识图能力**:用户能把图片交给宠物(选文件 / 拖拽 / 粘贴 / **框选屏幕**),宠物用支持视觉的模型看图并作答。

**核心原则**:所有图片来源(选文件 / 拖拽 / 粘贴 / 截屏框选 / 将来宠物自主截屏)都汇入**同一条归一化图像管线**,Provider 层各自序列化成对应 SDK 形状。输入方式是可插拔的上层,管线是内核。

三块工作:

- **(A) 归一化图像消息管线 + Provider 序列化** —— 内部一份图像表示,anthropic 序列化为 base64 image block,openai-compat 序列化为 image_url data URL。
- **(B) 三种输入方式 + 截屏框选** —— 选文件 / 拖拽 / 粘贴 / 全屏框选覆盖层。
- **(C) UI + 错误兜底 + 持久化 + IPC 加固** —— 缩略图带、视觉能力错误包装、图片不落盘、附件校验。

### 1.1 明确不做(Out of Scope)

- **图片持久化**:图片只在当前会话内存里发给模型,用完即弃;`transcript.json` 用户回合只存文本(有图时前缀 `[图片] `);记忆/向量索引不变。
- **视觉能力预探测**:不主动探测端点是否支持视觉;带图直发,openai-compat 端点报错时把错误包装成「请换支持视觉的模型」提示。Anthropic 恒支持视觉,不涉及。
- **多显示器框选**:截屏框选首期限定**当前显示器**(宠物窗口所在屏);多显示器留作 deferred。
- **宠物自主截屏工具**:留给后续浏览器自动化阶段;本期只保证管线为它预留复用点(见 §6),不实现 agent 可调用的 `capture_screen` 工具。
- **视频 / 音频等其他模态**:本期只做静态图像。

### 1.2 现状核对(避免重复造轮子)

- `src/shared/ipc.ts` 早期已埋桩:`ChatAttachment { kind: 'image' }`、`ChatSendPayload.attachments?`、`ChatMessage.attachments?`;`ipcValidation.validateChatSend` 已放行 `attachments` 数组。这些是**空壳**(只有 `kind`,不带图像数据),本期把内容补上。
- 三 Provider 已有统一的流式 + `tool_use` chunk 协议(MVP-04);本期图像只改**输入侧消息映射**,不动 chunk 协议。
- `messageMapping.ts` 已把 `AgentMessage` 映射成两 SDK 消息形状且有单测;本期在其上扩展图像 block,复用其测试骨架。

---

## 2. (A) 归一化图像消息管线

### 2.1 共享类型(`src/shared/llm.ts`)

```ts
export interface ImagePart { mimeType: string; dataBase64: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  images?: ImagePart[]   // 仅对 role:'user' 有意义;经预处理后的图像
}
```

`AgentMessage` 基于 `ChatTurn`,自然继承 `images`。`assistant_tool_use` / `tool_result` 不带图像。

`mimeType` 取预处理后的实际编码(见 §2.3),白名单内(`image/png` | `image/jpeg` | `image/webp` | `image/gif`)。

### 2.2 Provider 序列化(`src/main/providers/messageMapping.ts`,纯函数、TDD)

当前 user 消息映射为纯字符串 `content`;扩展为:**当 `images` 非空时,content 变 block 数组**。

- **anthropic**:
  ```ts
  content: [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 } })),
    { type: 'text', text: content }
  ]
  ```
  (图在前、文字在后,贴合 Anthropic 多图建议;`content` 为空时仍保留一个空 text block 或省略,按 SDK 允许形状取舍——实现时以最小合法形状为准。)
- **openai-compat**:
  ```ts
  content: [
    { type: 'text', text: content },
    ...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } }))
  ]
  ```
- **fake**:把 `[图片×N]` 拼进文本(如 `content` + ` [图片×2]`),供端到端测试断言"图确实传到了 provider"。

无图时三者行为与现状完全一致(回归保护)。

### 2.3 图像预处理(`src/main/media/imagePrep.ts`,新)

用 Electron 内置 `nativeImage`,**不引新依赖**:

1. `nativeImage.createFromBuffer(buf)` 解码原图(png/jpeg/webp/…)。
2. 降采样:最长边 > 1568px 时按比例缩到最长边 = 1568px(贴合 Claude 视觉推荐,控 token/payload;截屏常远超此值)。
3. 重编码:统一输出 **JPEG**(`toJPEG(quality)`,质量约 80)或对含透明通道图输出 PNG——由实现按简单规则决定,写进 `ImagePart.mimeType`。
4. base64 化,产出 `ImagePart`。

**可测性**:把"目标尺寸计算"抽成纯函数 `targetSize(w, h, maxEdge): {w,h}` 单测;`nativeImage` 的解码/缩放/编码是薄封装,靠真机验收(agent 会话 + 单测无法覆盖 native 图像解码路径,与 MVP-06 GPU 问题同理)。

**统一入口**:所有来源(文件字节 / 拖粘字节 / 截屏 nativeImage)都过 `imagePrep`,产出规格一致的 `ImagePart` 再进 agent 消息。这是"同一条管线"的落点。

---

## 3. (B) 三种输入方式 + 截屏框选

四个入口,都最终产出字节 → `imagePrep` → `ImagePart`:

### 3.1 选文件

- 对话框输入条旁加「+」按钮 → 走新 IPC 通道 `MEDIA_PICK_IMAGE` → 主进程 `dialog.showOpenDialog`(filters 限图片扩展名,`multiSelections` 视 UI 决定)。
- 主进程读文件字节 → `imagePrep` → 把预览 dataURL(缩略)回传渲染层挂到待发缩略图带;`ImagePart` 暂存于主进程本回合待发区(或随发送 payload 回带,实现时二选一,倾向随 payload 走 IPC 以复用校验)。

### 3.2 拖拽 / 粘贴

- 渲染层对话窗口监听 `drop` 与 `paste` 事件,取到 `File` / clipboard image blob → `FileReader.readAsArrayBuffer` → base64(sandbox 内合法,**不需要 fs**)。
- 经 `CHAT_SEND` 的 `attachments` 携带原始字节到主进程 → `imagePrep`。
- 缩略图预览在渲染层本地即可生成(`URL.createObjectURL` / dataURL),不必等主进程回传。

### 3.3 截屏框选(`src/main/media/screenCapture.ts` + 覆盖层窗口,新)

技术最重的一环:

1. 触发:对话框「截屏」按钮或热键 → IPC `MEDIA_CAPTURE_REGION`。
2. 抓屏:主进程 `desktopCapturer.getSources({ types:['screen'], thumbnailSize: <当前显示器分辨率> })` 取当前显示器全分辨率截图(`source.thumbnail` 为 `nativeImage`)。
3. 覆盖层:创建一个**全屏、无边框、透明、置顶**的 `BrowserWindow`(`regionOverlay`),把截图作为背景铺满,加一层半透明遮罩。
4. 框选:覆盖层内 JS 处理鼠标拖拽画矩形;`Esc` 取消、拖完确认;把矩形坐标(设备像素)回传主进程。
5. 裁剪:主进程用截图 `nativeImage.crop(rect)` → `imagePrep` → 进管线,关闭覆盖层。

**边界**:限当前显示器;`Esc`/空选取消返回不发送;DPI 缩放下坐标换算按 `screen.getPrimaryDisplay().scaleFactor` / 窗口所在 display 处理(实现时以设备像素为准)。

---

## 4. (C) UI + 错误兜底 + 持久化 + IPC 加固

### 4.1 对话框 UI(`renderer/dialog.ts` + `dialog.html`)

- 输入条**上方**一条**缩略图带**:每张待发图一个小方块 + 「×」删除;可有多张。
- `ChatMessage.attachments` 扩展:携带一个**仅渲染用**的 `previewDataUrl?`(临时,永不落盘、不进 transcript)。历史区里用户带图消息渲染一个 `[图片]` 标记(或小缩略),文本照旧经 `markdown.ts`。
- 发送后清空缩略图带。样式沿用 `dialog.html` 内联风格。

### 4.2 视觉能力错误兜底

- **不预判**。带图直发。
- openai-compat 端点因不支持视觉报错时,在 `chat.ts` / provider 错误路径把消息包装成友好提示:「当前模型可能不支持识图,请在设置里切换到支持视觉的模型(如 gpt-4o、qwen-vl、GLM-4V、本地 llava)」。沿用 MVP-04 openaiCompat 错误包装的做法(粗匹配即可,原文保留)。
- Anthropic 恒支持,无需处理。

### 4.3 持久化

- `transcript.json` 用户回合:只存文本;`attachments` 非空时文本前缀 `[图片] `(便于日后模型/摘要知道"这轮有图")。
- 图像字节**永不落盘**;`memoryManager` / `vectorIndex` / `factStore` 完全不变。
- pet 回复照常持久化(其文本描述天然承载了"看到了什么")。

### 4.4 IPC 加固(`src/shared/ipcValidation.ts`)

`attachments` 现在携带真实图像字节,校验升级:

- 每个 attachment:`kind==='image'`、`mimeType` 在白名单、`dataBase64` 为字符串且 **单图 base64 长度 ≤ 上限**(如 ~10MB base64)。
- **最大张数**(如 ≤ 6)。
- 超限/非法 → 整条 payload 拒绝(返回 `null`,沿用现有失败即丢弃语义)。
- 新增通道常量:`MEDIA_PICK_IMAGE`、`MEDIA_CAPTURE_REGION`(及覆盖层确认/取消所需内部通道),各自的 payload 校验函数。

### 4.5 四文件同步(IPC 契约)

新增能力按项目惯例改四处:`src/shared/ipc.ts`(常量 + 类型)、`src/main/shell/*`(handler)、`src/preload/index.ts`(暴露)、渲染层调用方。

---

## 5. 数据流(端到端)

```
[选文件/拖拽/粘贴]  ─字节→ imagePrep ─ImagePart→ ┐
[截屏框选] desktopCapturer→crop→ imagePrep ─────→ ┼→ ChatTurn{content,images}
                                                  │      │
                                    (缩略图带预览,仅渲染)  │
                                                         ▼
                                              agentLoop / messageMapping
                                                  ├ anthropic: image block(base64)
                                                  └ openai-compat: image_url(data URL)
                                                         │
                                            视觉模型作答 →(纯文本流式,现协议不变)
                                                         │
                                    transcript: 用户回合存 "[图片] <text>";图不落盘
```

---

## 6. 为"宠物自主截屏"预留(未来,非本期)

后续浏览器自动化阶段,宠物需要能自己截屏、无需人类确认。本期不实现,但保证:

- `screenCapture` 的**抓屏+预处理**部分与"框选 UI"解耦——将来 `capture_screen` 工具可直接调抓屏+`imagePrep`,跳过覆盖层。
- 图像进 agent 消息的路径(`ChatTurn.images`)对"工具产出的图"同样适用。

即:本期做的是"人给图"的链路,但内核管线(imagePrep + images 字段 + provider 序列化)是"机器自取图"也能复用的那一段。

---

## 7. 单元划分与职责

| 单元 | 文件 | 职责 | 测试 |
|---|---|---|---|
| 图像类型 | `shared/llm.ts` | `ImagePart` + `ChatTurn.images` | 类型 |
| Provider 序列化 | `providers/messageMapping.ts` | user 图像 → 两 SDK block | TDD 单测 |
| 图像预处理 | `main/media/imagePrep.ts` | 解码/降采样/重编码/base64 | 尺寸计算纯函数单测 + 真机 |
| 抓屏 | `main/media/screenCapture.ts` | desktopCapturer + crop | 真机 |
| 框选覆盖层 | `main/shell/regionOverlay.ts` + overlay html/js | 全屏矩形框选 | 真机肉眼 |
| 附件校验 | `shared/ipcValidation.ts` | mime/大小/张数 | TDD 单测 |
| 对话框 UI | `renderer/dialog.ts` + `dialog.html` | 缩略图带/删除/drop/paste/+/截屏钮 | 真机肉眼 |
| 会话编排 | `main/shell/chat.ts` | 附件入 agent 消息 + transcript 占位 + 错误包装 | 单测 + 真机 |

---

## 8. 测试与验收

- **TDD 覆盖**:messageMapping 图像序列化(两 provider,有图/无图)、imagePrep 尺寸计算纯函数、ipcValidation 附件校验(mime 白名单/超大/超张数/happy-path)、fake provider 端到端(图透传到 provider)。
- **真机肉眼验收**(自动化测不到,`pnpm dev`/`preview` 或打包版):
  1. 选文件识图:选一张图 → 缩略图出现 → 发送 → 宠物描述图像内容。
  2. 拖拽 / 粘贴识图:同上,拖入 / Ctrl+V。
  3. 截屏框选:触发 → 覆盖层出现 → 框一块区域 → 宠物描述该区域;`Esc` 取消不发送。
  4. 换到不支持视觉的 openai-compat 模型带图发送 → 出现「请换支持视觉的模型」提示。
  5. transcript 里用户回合是 `[图片] …`、无 base64;记忆文件无图。
- **回归**:现有 204 单测全绿;无图对话行为不变。

---

## 9. 风险与取舍

- **截屏框选覆盖层是全期技术最重、唯一自动化测不到的部分**,也是真机验收风险最高的一环(透明置顶窗口 + DPI 坐标 + 多进程)。用户已选"一次做全",接受该风险;实现时优先把管线(§2)与选文件/拖粘(§3.1/3.2)跑通,截屏框选作为最后一个、最需肉眼盯的单元。
- **payload 体积**:图像走 IPC 传字节,靠 imagePrep 降采样 + 张数/大小上限控制;`ipcValidation` 上限是最后防线。
- **小模型识图弱**:与 MVP-04 搜索同理,强视觉模型效果更好,属模型能力差异非 bug。
