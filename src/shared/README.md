# src/shared — 主 / 渲染共享的类型与契约

主进程与渲染进程都依赖的**纯类型与常量**(无副作用、不含具体逻辑),保证两端接口一致、编译期对齐。

## 典型内容
- **IPC 消息类型**与通道常量(与 [main/ipc](../main/ipc/) 对应)。
- **pet.json 类型**(sheet / animations),供渲染端与打包工具对齐。
- **动画状态枚举**(idle/walk/drag/sleep/thinking/talk/…)。
- **事件枚举**(台词库 key)、Provider/设置的公共类型。

## 交互
- ← `src/main/*` 与 `src/renderer/*`:双方 import 同一份定义,避免契约漂移。
- ↔ 与 [tools/hatch-desktop-pet](../../tools/hatch-desktop-pet/) 的 `pet_layout.py` 概念对齐(pet.json 形状),但那是独立的 Python 资产工具,不共享代码。
