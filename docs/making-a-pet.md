# 做一只属于自己的宠物

一只宠物 = 一个自包含文件夹 `pets/<pet-id>/`。全部素材都能自己生成/编写，不需要动一行 `src/` 代码。本指南按真实文件示例（`pets/luluka/`）走一遍完整流程：

```
pets/<pet-id>/
├── pet.json          # 必需:元数据 + 动画清单(由工具生成)
├── spritesheet.webp  # 必需:美术图集(由工具生成)
├── persona.md         # 可选:人设,不填则用默认兜底人设
├── lines.json         # 可选:口癖台词库,不填则该宠物不冒话
└── voice/              # 可选:TTS 语音克隆用的模型与参考音频
```

只有 `pet.json` + `spritesheet.webp` 是必需的；`persona.md`/`lines.json`/`voice/` 都是可选的渐进增强 —— 缺哪个就降级到对应的默认/静音行为，不会崩。

## 第一步：生成美术（`pet.json` + `spritesheet.webp`）

美术这一步由 [`tools/hatch-desktop-pet`](../tools/hatch-desktop-pet) 这个 Codex skill 负责。它**魔改自 Codex 内置的 `hatch-pet` skill**——沿用了同一套"参考图 → 分镜提示词 → `$imagegen` 出图 → 校验 → 拼图集"的流程骨架和脚本命名，但把上游默认的 8 行动作布局改成了本项目专用的 **13 行**布局（新增 happy/sad/cry/surprised/love 5 个情绪动作行）、把 `pet.json` 扩成含 `sheet`+`animations` 块的完整清单、把产物目录从上游默认的 `${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/` 改写到了本仓库的 `pets/<pet-id>/`。`agents/openai.yaml` 里的 `default_prompt` 至今还留着上游的输出路径写法，就是这层魔改关系的痕迹。

这个 skill 把一张参考图变成一张 **8 列 × 13 行、192×208 像素/格、1536×2704 总尺寸** 的透明背景精灵图集（idle/walk-right/walk-left/drag/sleep/greet/thinking/talk 8 个 MVP 动作 + happy/sad/cry/surprised/love 5 个情绪动作），并同步生成描述该图集的 `pet.json`。完整规则见该目录的 [`SKILL.md`](../tools/hatch-desktop-pet/SKILL.md)，这里只摘要实际会跑的流程：

1. **把这个 skill 交给 Codex（或其他支持本地 Skill 机制的 agent）**：`tools/hatch-desktop-pet/SKILL.md` 的 frontmatter 定义了 skill 名字 `hatch-desktop-pet` 和触发场景。具体“导入”方式取决于你用的客户端版本（例如把该目录复制/软链接到 Codex 的 skills 目录下），以 `SKILL.md` 自身的说明为准。
2. Skill 会调用它自带的脚本跑完整流程（都在 `tools/hatch-desktop-pet/scripts/`）：
   - `prepare_pet_run.py --pet-name "<名字>" --description "<一句话描述>" --reference /绝对路径/参考图.png --output-dir /绝对路径/run` —— 只需要**一张参考图**，脚本会推断宠物名、生成 13 个动作的分镜提示词和排版参考图。
   - `pet_job_status.py` —— 查看下一批可生成的任务。
   - 每个任务通过 Codex 内置的图像生成能力（`$imagegen`，或仓库外环境下的 `generate_pet_images.py` OpenAI 兜底）出图后，用 `record_imagegen_result.py --job-id <id> --source <生成结果>` 记录选中结果。`idle`/`walk-right` 先做（确认造型和步态），`walk-left` 必须是**单独重新画的左向图**（不能水平翻转 `walk-right`，因为宠物左右不对称），其余动作再逐个补齐。
   - 全部任务完成后跑 `finalize_pet_run.py --run-dir /绝对路径/run`，自动做:抠图/去色差 → 拼图集 → 校验 → 生成对比表 `qa/contact-sheet.png` 和预览视频 → 打包。
3. 产物默认写到 **`pets/<pet-id>/`**（从仓库根目录运行时），只有 `pet.json` 和 `spritesheet.webp` 两个文件——正是本指南开头表格里的必需部分。生成完成后务必看一眼 `qa/contact-sheet.png`：造型、五官、配色、道具在 13 行里必须保持一致，任何一行走样都要重新生成那一行（不是整张重做）。

`pet.json` 长这样（摘自真实的 `pets/luluka/pet.json`，字段含义见 [`references/pet-contract.md`](../tools/hatch-desktop-pet/references/pet-contract.md)）：

```json
{
  "id": "luluka",
  "displayName": "露露卡",
  "description": "拥有金粉渐变长发、黑紫金礼裙与紫晶法杖的魔法少女桌宠。",
  "spritesheetPath": "spritesheet.webp",
  "sheet": { "rows": 13, "cols": 8, "cellWidth": 192, "cellHeight": 208 },
  "animations": {
    "idle": { "row": 0, "frames": 6, "fps": 2, "loop": true, "durations": [1600,260,260,300,300,1000] }
    /* ……其余 12 行动作,由工具自动生成,一般不需要手改 */
  }
}
```

## 第二步：写人设（`persona.md`）

`persona.md` 是喂给 LLM 的 system prompt 素材，纯文本、Markdown 分块，改完**重启应用即生效**，不需要重新打包。约定分四块（不强制，但建议保留这个结构，方便对照维护）：

- **`# Persona`** —— 这是谁：背景设定、外貌、性格核心、标志性癖好。
- **`# Voice`** —— 怎么说话：语气、句式长短、口头禅、语言习惯。
- **`# Behavior`** —— 行为准则：做事优先级、不确定时怎么办、隐私/边界意识。
- **`# Tools`** —— 对工具调用的态度：什么时候主动查，怎么汇报结果。

以 `pets/luluka/persona.md` 为例（节选，完整版见该文件）：

```markdown
# Persona(人设 / 角色)

你是**森亚露露卡**,现在作为用户的桌面伙伴常驻在屏幕上。
- **性格核心**:沉默寡言,但内里可靠、会默默为在意的人着想。
- **标志性癖好**:极度嗜吃冰淇淋。

# Voice(语气 / 说话风格)

- 惜字如金,一两句话说清即可,不铺陈、不寒暄。
- 语气平静、笃定,偶尔冷幽默。
- 中文为主,与用户语言保持一致。

# Behavior(行为准则)

- 先把事办成:话虽少,但要真正解决用户的问题。
- 不确定就直说不确定,并去查证,绝不编造。

# Tools(对工具的态度)

- 需要最新信息时主动去查,而不是凭印象作答。
- 动手前用一句话点明要做什么,拿到结果后给结论优先。
```

不写 `persona.md` 也能跑——会退化到内置的默认兜底人设，只是没有角色个性。

## 第三步：写口癖台词库（`lines.json`）

`lines.json` 是宠物在特定时机随机蹦出的**静态短句**（不经过 LLM，零延迟，也不消耗 token）。格式是 `{ 分类: [{ text, audio? }, ...] }`，同一分类多条时随机抽一条、且不会紧接着复读上一条。

**当前真正会被触发的分类只有这 9 个**（对应 `src/shared/reactionPlanner.ts` 的 `ReactionCategory`，写其他分类名不会报错，但也永远不会被读到）：

| 分类 | 触发时机 |
|---|---|
| `idle` | 长时间静置随机念叨 |
| `long_idle` | 静置更久后念叨 |
| `wake` | 睡眠中被戳/拖起 |
| `click` | 被单击（非拖拽） |
| `drag` | 被拖起移动 |
| `sleep` | 睡眠中被戳但不叫醒 |
| `greet` | 当天第一次问候（早 5-10 点） |
| `farewell` | 当天第一次问候（晚 23-2 点） |
| `break` | 久坐提醒（默认连续活跃 45 分钟） |

示例（摘自 `pets/luluka/lines.json`）：

```json
{
  "greet": [
    { "text": "……嗯,你来了。", "audio": "voice/greet_01.wav" },
    { "text": "有事?说吧。" }
  ],
  "click": [
    { "text": "嗯?" },
    { "text": "……有话直说。" }
  ]
}
```

> ⚠️ **`audio` 字段目前是预留占位，尚未接线播放**——不管填不填、填的路径存不存在，`lines.json` 里的台词现在都只以文字气泡显示，不会发声。第四步的 TTS 语音只朗读 LLM 现场生成的聊天回复，与这里的静态台词是两条独立的路径。

## 第四步（可选）：配音——用 GPT-SoVITS 训练自己的声音

这一步让宠物**用你训练的音色朗读它的聊天回复**（不是朗读第三步的静态台词，见上面的提示）。分两段：训练在**本仓库之外**用 GPT-SoVITS 官方工具完成，接线在本仓库内完成。

### 4.1 用 GPT-SoVITS 微调 v2Pro / v2ProPlus 模型

本项目本身**不做训练**，只做推理——语音运行时装的是 [`gsv-tts-lite`](https://github.com/chinokikiss/GSV-TTS-Lite)（PyPI 包，基于 GPT-SoVITS V2/V2Pro/V2ProPlus 的推理引擎，只吐音频，不含训练代码）。要产出一份声音模型，需要单独部署官方 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 仓库，跑它自带的 WebUI 完成微调，大致流程（以官方 README 为准，不同版本 WebUI 面板名称可能变化）：

1. 准备目标音色的参考音频（干净的单人语音，噪音/BGM 越少越好），填入音频路径。
2. 用 WebUI 自带的切片工具把长音频切成小段，可选降噪。
3. 跑 ASR 自动转写，然后**人工校对**转写文本（这一步质量直接决定训练数据质量，别跳过）。
4. 到微调 Tab：先选好**预训练底模版本**——要 v2Pro 还是 v2ProPlus，需要提前从官方仓库下载对应的 `s2Dv2Pro.pth`/`s2Gv2Pro.pth`（或 `...v2ProPlus.pth`）放进 `GPT_SoVITS/pretrained_models`，并在 WebUI 里切到该版本；官方 README 原话是 v2Pro 系列显存占用"略高于 v2"，没给具体数字，训练时留够余量、按需降 batch size。
5. 依次跑 **SoVITS 训练**和 **GPT 训练**两个阶段（各自独立的 Tab/按钮）。官方 README 称"1 分钟语音也能训出可用模型"，但参考音频越干净、时长适度更长，音色稳定性通常越好。

训练完成后，产出两份权重文件，命名规律形如（本项目 `pets/alice_0/voice/` 下就是真实产物，可以直接参考）：

```
<实验名>-e<epoch数>.ckpt          # GPT 权重,如 Alice_v2pro-e15.ckpt
<实验名>_e<epoch数>_s<step数>.pth # SoVITS 权重,如 Alice_v2pro_e8_s1032.pth
```

模型是 v2、v2Pro 还是 v2ProPlus，`gsv-tts-lite` 会在加载时**从 checkpoint 内部结构自动识别**，不需要在本项目任何配置里手动声明版本。

### 4.2 接进宠物包

把训练产出的两个权重文件，加上**一段干净的参考音频**和**它的文字转写**，放进宠物包的 `voice/` 目录：

```
pets/<pet-id>/voice/
├── Alice_v2pro-e15.ckpt          # gptModel
├── Alice_v2pro_e8_s1032.pth      # sovitsModel
├── ailisi_4.wav                  # refAudio(几秒的干净参考音频)
└── ailisi_4.txt                  # refText(该参考音频的纯文本转写,UTF-8 文本文件)
```

然后在 `pet.json` 里加一个 `voice` 块（四个路径都相对宠物包目录解析，与 `spritesheetPath` 同规则）：

```json
{
  "id": "alice",
  "voice": {
    "gptModel": "voice/Alice_v2pro-e15.ckpt",
    "sovitsModel": "voice/Alice_v2pro_e8_s1032.pth",
    "refAudio": "voice/ailisi_4.wav",
    "refText": "voice/ailisi_4.txt"
  }
}
```

没有 `voice` 字段的宠物，TTS 永远不可用（与全局开关无关），行为上等同于关闭——这是刻意的降级设计，不需要额外配置去"关掉"某只宠物的配音。

### 4.3 开启语音运行时

`voice` 字段只是"这只宠物有声音"，真正让它说出来还需要装一次语音运行时（一个自包含的可移植 Python 环境，跑 `gsv-tts-lite` 推理，和你机器上有没有装 Python/conda 无关）：

1. 打开设置窗的「语音」分区，选一个安装位置（默认建议 `userData/voice-runtime/`，也可以指到空间更大的盘）。
2. 点「现场安装」（需要联网，自动下载可移植 Python + `pip install gsv-tts-lite` + 首次推理会用到的基础预训练模型），或者如果你已经在别的机器上装过，点「导入运行时压缩包」直接离线导入。
3. 打开语音总开关，按需调整目标朗读语言（自动 / 中 / 日 / 英）、播放触发方式（等完整回复再读 / 流式逐句读）等参数。
4. 切到该宠物、重启应用——聊天回复就会跟着朗读了。

真机验收清单：现场安装全流程、v2Pro/v2ProPlus 模型均能正常推理、断网或没有匹配 GPU 驱动时报错是否清晰，这些都需要在有真实 GPU 的机器上走一遍，自动化测试覆盖不到。

## 收尾：让新宠物在应用里生效

宠物包做好之后，不需要重新打包整个应用——设置窗里「导入宠物包」选中 `pets/<pet-id>/` 这个文件夹即可（复用 MVP-09 的导入流程），选中后点「重启应用」按新宠物启动。开发模式下（`pnpm dev`/`pnpm preview`）也一样，仓库根目录下的 `pets/` 会被直接扫描到，不需要导入这一步。

## 顺带一提：宠物包默认不进 Git

`pets/luluka`、`pets/alice` 等具体宠物文件夹都在 `.gitignore` 里（美术/音色可能涉及版权，不适合随源码一起公开分发）。做自己的宠物时，如果同样不想把这些素材提交进仓库，在 `.gitignore` 里加一行 `pets/<你的pet-id>` 即可；如果就是想公开分享，跳过这一步直接 `git add` 即可。
