# Phase 1 Electron 升级 — 升级前基线

日期:2026-07-20
Worktree:`.claude/worktrees/live2d-phase1-electron-upgrade`(分支 `worktree-live2d-phase1-electron-upgrade`,base = 当时的 `main` @ `e607d16`)
说明:此时 Phase 0(GPU reboot-degrade,worktree `gpu-accel-reboot-degrade`)**尚未合并进 main**,本阶段按计划的 Task 5 Step 3 fallback 走"单一软渲染模式回归"。

## 升级前版本

```
electron:         ^31.0.0
electron-vite:     ^2.3.0
electron-builder:  ^24.13.3
```

## 自动化基线

```
pnpm typecheck   → 通过,无错误
pnpm test        → 89 files / 789 tests 全部通过
                   (首次运行 pets/luluka 缺失导致 petLoader.test.ts 1 个失败——
                    非回归,worktree 是全新 git checkout,pets/luluka 按 CLAUDE.md
                    是有意 gitignore、仅存在于主仓库磁盘;从主仓库 cp -r pets 拷入
                    worktree 后复测,789/789 全绿)
pnpm build       → 三包(main/preload/renderer)均构建成功
```

**基准数字(供 Task 4 对照)**:N = 789(全部通过,0 失败)。

## 手动冒烟基线

本 sandbox 无显示器,升级前手动冒烟由用户在真机完成(按项目既定惯例)。Task 5/6 的真机回归需覆盖:透明置顶窗渲染 idle 动画、拖拽跟手、点击穿透、托盘退出、任务栏不显图标。

## Electron 内置运行时版本(升级前,记录用)

未在本 Task 单独起 Electron 进程探测 `process.versions`;留给 Task 2 Step 5 与升级后版本一并对照记录。
