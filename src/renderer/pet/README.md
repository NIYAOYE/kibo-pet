# src/renderer/pet — 精灵动画 + 状态机

把宠物"演"出来。加载宠物包的 `spritesheet.webp` + `pet.json`,按动画清单播放精灵帧,并用一个状态机管理当前动作。

## 职责
- 按 `pet.json.sheet` 计算帧像素区域(`x=col*cellWidth, y=row*cellHeight`),按 `durations`/`fps`、`loop` 播放。
- 动画状态机:`idle / walk / drag / sleep …` 的切换与过渡(MVP 做基础切换)。
- **预留接口**:接收"由事件/情绪驱动状态切换"的指令(Phase 2 情绪驱动)。
- `walk-left` 直接播放,不翻转 `walk-right`。
- 处理拖拽:被拖时切 `drag` 动画,并请求主进程移动窗口。

## 交互
- → 当前宠物包 `pets/<id>/`:读取精灵图与动画清单。
- ← [ipc](../../main/ipc/):接收状态切换指令(如 agent thinking → 播 `thinking`)。
- → [shell](../../main/shell/)(经 ipc):拖拽时请求窗口移动。
