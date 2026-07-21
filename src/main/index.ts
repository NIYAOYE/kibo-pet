import { app, dialog } from 'electron'
import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'
import { loadSettings, saveSettings } from './config/settings'
import { decideGpuBoot } from '@shared/gpuBootDecision'

const GPU_MARKER_FILE_NAME = 'gpu-accel-boot.marker'
/** 原崩溃描述是"秒退",几乎瞬间发生;这个延迟给"确认这次启动没崩"留出安全边际。 */
const GPU_MARKER_CONFIRM_DELAY_MS = 3000

/**
 * 打包后的 GUI 进程没有控制台,任何致命错误都无处可看(表现为"任务栏闪一下就消失")。
 * 把诊断信息同时落到 userData 和系统临时目录(app 未 ready 时 userData 可能取不到),
 * 绝不因日志本身再抛错。
 */
function logDiag(tag: string, detail: unknown): void {
  const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
  const line = `[${new Date().toISOString()}] ${tag}: ${msg}\n`
  const targets: string[] = []
  try { targets.push(join(app.getPath('userData'), 'startup-crash.log')) } catch { /* userData 未就绪 */ }
  try { targets.push(join(tmpdir(), 'kibo-startup.log')) } catch { /* ignore */ }
  for (const p of targets) {
    try { writeFileSync(p, line, { flag: 'a' }) } catch { /* 写不了也不能崩 */ }
  }
}

logDiag('boot', `main entered (packaged=${app.isPackaged}, argv=${JSON.stringify(process.argv)})`)

process.on('uncaughtException', (e) => logDiag('uncaughtException', e))
process.on('unhandledRejection', (e) => logDiag('unhandledRejection', e))

/**
 * 真机双击崩溃根因(用户机崩溃转储确认):硬件 GPU 子进程以 0xC0000135 退出 →
 * 主进程 FATAL "GPU process isn't usable. Goodbye."(事件日志 0x80000003)秒退。
 * 默认仍然禁用硬件加速,改用 SwiftShader 软件渲染(其 DLL 随包分发,不依赖该机缺失的
 * 硬件图形 DLL)。用户可在设置里勾选"实验性硬件加速"主动尝试——见
 * docs/superpowers/specs/2026-07-14-gpu-acceleration-reboot-degrade-design.md:
 * 用 userData 下的启动标记文件 + 设置开关做"重启降级",而不是试图在进程内捕获这类致命
 * 崩溃(真实案例 electron/electron#43955 证实"进程内捕获再动态降级"这条路线不可靠)。
 * 注:曾叠加 --in-process-gpu,虽也不崩但会导致窗口一片空白(合成/绘制异常),已移除。
 * 这段决策必须在 app ready 前跑完(app.disableHardwareAcceleration() 的硬性要求)。
 */
let gpuMarkerFile: string | null = null
let useHardwareAcceleration = false
try {
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'settings.json')
  gpuMarkerFile = join(userData, GPU_MARKER_FILE_NAME)
  const settings = loadSettings(settingsFile)
  const markerPresent = existsSync(gpuMarkerFile)
  const decision = decideGpuBoot({
    experimentalHardwareAcceleration: settings.gpuAcceleration.experimental,
    markerPresent
  })
  if (decision.markerAction === 'clear-and-disable-setting') {
    // 先落盘关闭开关,标记文件最后删——万一 saveSettings 抛错,标记还在,
    // 下次启动仍会判定"需要恢复"并重试这段逻辑,不会静默丢失这个信号。
    // (反过来的边界情况:saveSettings 成功但 rmSync 失败,标记会残留但此时
    // experimental 已是 false,不影响安全性,只是下次用户重新勾选时会立刻
    // 命中一次"残留标记"分支、直接跳过尝试就把开关关掉——是良性的自愈,不是 bug。)
    saveSettings(settingsFile, { ...settings, gpuAcceleration: { experimental: false } })
    rmSync(gpuMarkerFile, { force: true })
    logDiag('gpu-accel', '检测到上次启动的标记文件残留,判定硬件加速导致启动失败,已自动降级并关闭设置')
  } else if (decision.markerAction === 'write') {
    writeFileSync(gpuMarkerFile, String(Date.now()))
  }
  useHardwareAcceleration = decision.useHardwareAcceleration
} catch (err) {
  logDiag('gpu-accel decision failed, falling back to safe default', err)
}

if (!useHardwareAcceleration) app.disableHardwareAcceleration()

if (gpuMarkerFile && useHardwareAcceleration) {
  const markerFile = gpuMarkerFile
  let cleared = false
  app.on('browser-window-created', (_e, win) => {
    if (cleared) return
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (cleared) return
        cleared = true
        try { rmSync(markerFile, { force: true }) } catch (err) { logDiag('gpu-accel marker clear failed', err) }
      }, GPU_MARKER_CONFIRM_DELAY_MS)
    })
  })
}

app.whenReady()
  .then(() => startShell())
  .catch((e) => {
    logDiag('startShell threw', e)
    try {
      dialog.showErrorBox('Kibo 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
    } catch {
      /* dialog 不可用也不能再崩 */
    }
  })
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
