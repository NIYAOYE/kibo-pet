# Live2D 原始资源自动导入设计

**日期：** 2026-07-26  
**状态：** 已确认，待实现计划

## 目标

导入器应接受两类 Live2D 资源目录：

1. 完全没有 `pet.json` 的原始 Live2D 资源目录；
2. 有 `pet.json` 但 Live2D 必填字段不完整的资源目录。

导入时自动生成或补齐应用需要的基础 manifest，使用户无需手写 `transform`、`interaction` 和 `stateMap`。动作、表情和可见参数仍由已加载的模型在运行时发现，不能被写死或臆测。

## 非目标

- 不根据动作组名称猜测“问候”“说话”等语义状态；`stateMap` 默认保持空对象。
- 不覆盖已有的合法用户配置。
- 不修改用户选择的源目录；所有生成内容只存在于 staging 与确认后的应用宠物目录。
- 不改变现有运行时表情、动作、参数发现与 LLM `live2d_perform` 协议。

## 输入分类与结果

| 源目录情况 | 行为 |
| --- | --- |
| 没有 `pet.json`，且恰有一个 `.model3.json` | 生成完整基础 manifest 后继续导入。 |
| `pet.json` 是合法 Live2D manifest | 原样使用，继续既有校验和资源找回。 |
| `pet.json` 指明 `render.type: "live2d"`，但缺少可自动推导的必填字段 | 仅补齐缺失字段后继续导入。 |
| 有多个或没有 `.model3.json` | 拒绝导入并给出可操作错误；不猜测模型入口。 |
| `pet.json` 含非法类型、路径穿越或不支持的 render 类型 | 拒绝导入；不静默改写损坏/不可信数据。 |

“缺少”仅指属性不存在。字段存在但类型错误不是补齐对象，必须提示用户修正，避免把拼写错误或恶意路径伪装成默认配置。

## 自动生成规则

以发现的唯一 `.model3.json` 相对路径为 `render.model`。生成的 manifest 包含：

```json
{
  "schemaVersion": 2,
  "id": "<安全化目录名或稳定后缀>",
  "displayName": "<模型或目录显示名>",
  "description": "导入的 Live2D 宠物",
  "render": {
    "type": "live2d",
    "model": "<发现的相对 model3 路径>",
    "viewport": { "width": 360, "height": 480, "resolutionCap": 1.5 },
    "transform": {
      "scale": 1,
      "offsetX": 0,
      "offsetY": 0,
      "anchorX": 0.5,
      "anchorY": 1,
      "bubbleAnchorX": 0.5,
      "bubbleAnchorY": 0,
      "autoFitted": false
    },
    "interaction": {
      "mirrorOnWalk": false,
      "mouseTracking": true,
      "lipSyncParameter": "ParamMouthOpenY"
    },
    "stateMap": {}
  }
}
```

`id` 必须通过现有安全规则。若目录名清洗后为空或与已有宠物冲突，导入器生成带稳定短后缀的 id；最终仍经过既有重复 id 校验。生成默认值后，首次成功显示模型将沿用当前流程，把实际测量的 `scale`、`offsetX`、`offsetY` 和 `autoFitted:true` 回写到已提交的 `pet.json`。

对于部分 manifest，补齐的优先级是“已有合法值 > 自动生成值”。例如已有的自定义 viewport、锚点、缩放、缩略图和 `stateMap` 必须保留；只缺 `transform.offsetY` 时，只添加这一项。

## 导入与预览流程

现有 `stageImportPet` 在读取 manifest 前增加一个纯函数的“解析或生成 manifest”阶段。该阶段返回：规范化 manifest、是否生成、被补齐字段清单，或结构性错误。

之后继续现有安全链：模型路径安全检查、`model3.json` FileReferences 校验、纹理预算检查、游离动作/表情资源找回、staging 复制和预览。生成或补齐的 `pet.json` 只写入 staging；用户取消时随 staging 一起删除，确认后才移动到用户 pets 目录。

设置页预览区显示明确结果，例如“已从 `Panda.model3.json` 生成基础配置”或“已补齐 `render.transform`、`render.interaction`”，并显示模型发现到的动作组和表情数量。预览不应承诺状态语义映射；`stateMap` 显示为空是正常行为。

## 运行时能力发现

导入阶段只负责让模型可以安全加载。模型实际加载后，保留当前运行时能力发现：从 Live2D Core 读取真实参数最小值、最大值、默认值，以及引擎声明的表情；过滤内部参数；把当前宠物专属能力提供给 `live2d_perform`。

动作组仅作为预览信息和现有游离资源找回的结果；除非用户日后显式配置 `stateMap`，不得把其名称映射为产品状态。这避免不同作者将同一组命名用于不同动作时发生误触发。

## 错误处理与安全

- 多个模型：错误中列出相对路径，后续可扩展为用户选择模型；本期不任意选择。
- 无模型：提示需要包含 `.model3.json` 的完整 Live2D 目录。
- 不完整/坏 JSON：缺少 `pet.json` 才触发生成；存在但非 JSON 时维持现有错误，避免忽略用户文件。
- 任何外部路径继续使用既有 `isPathSafe` 检查。
- 自动 id 的生成不得使用未受控路径片段，并继续与现有目录/包 id 去重。

## 测试与验收

纯函数测试覆盖：

1. 无 manifest + 唯一模型 → 生成完整且可通过 `parseLive2DManifest` 的配置；
2. 不完整 Live2D manifest → 仅补齐缺失项，保留用户字段；
3. 已有字段类型错误 → 拒绝，不以默认值覆盖；
4. 零/多个模型 → 明确错误；
5. 自动 id 的非法目录名和碰撞处理；
6. stage 导入生成/补齐配置后，staging 包可预览、取消不留痕、确认后含生成的 `pet.json`；
7. 现有精灵包及完整 Live2D 包导入测试保持通过。

人工验收：分别导入无 manifest 和缺失字段的真实 Live2D 包，确认预览显示补齐说明、模型正常显示、首次加载后 `autoFitted` 与实测 transform 写入，并确认 LLM 工具获得该模型真实表情与可见参数。
