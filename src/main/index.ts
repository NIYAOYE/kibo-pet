import { app, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShell } from './shell'

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
  try { targets.push(join(tmpdir(), 'pet-agent-startup.log')) } catch { /* ignore */ }
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
 * 对策:禁用硬件加速 → 改用 SwiftShader 软件渲染(其 DLL 随包分发,不依赖该机缺失的
 * 硬件图形 DLL),既消除崩溃又能正常出画。小透明置顶精灵窗对软件渲染性能无感。
 * 注:曾叠加 --in-process-gpu,虽也不崩但会导致窗口一片空白(合成/绘制异常),已移除。
 * 必须在 app ready 前设置。
 */
app.disableHardwareAcceleration()

app.whenReady()
  .then(() => startShell())
  .catch((e) => {
    logDiag('startShell threw', e)
    try {
      dialog.showErrorBox('Pet-Agent 启动失败', String(e instanceof Error ? (e.stack ?? e.message) : e))
    } catch {
      /* dialog 不可用也不能再崩 */
    }
  })
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
