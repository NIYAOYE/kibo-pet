# src/main — Electron 主进程(内核 + 系统集成)

运行在 Node 环境。承载 agent 内核、记忆、工具、skill、配置,以及与操作系统的集成(窗口、热键、托盘)。**不直接渲染 UI**——所有画面在 `src/renderer`,两者通过 `src/main/ipc` 通信。

## 子模块
| 目录 | 职责 |
|---|---|
| [shell/](shell/) | 创建透明置顶窗口、托盘、注册全局热键 |
| [agent/](agent/) | agent 循环,编排下列各能力 |
| [providers/](providers/) | LLM / Voice 提供方抽象 + 预设(可插拔,BYO key) |
| [tools/](tools/) | 原子工具(如 web_search) |
| [skills/](skills/) | skill 加载器 + 注册表 |
| [memory/](memory/) | 分层记忆(短期 + 长期) |
| [persona/](persona/) | 人设加载 + system prompt 组装 |
| [lines/](lines/) | 口癖台词库加载 + 事件→台词分流 |
| [config/](config/) | 设置/密钥存储、首次启动向导后端 |
| [ipc/](ipc/) | 主↔渲染 的 IPC 通道与处理器 |

## 对外交互
- ↔ `src/renderer`:经 `ipc/` 收发消息(用户输入、宠物状态、气泡文本、语音指令)。
- ↔ `src/shared`:复用跨进程的类型与通道常量。
- ↔ 用户目录:`memory/`、`config/`、`pets/` 的读写落在用户数据目录(可移植/卸载不丢)。
