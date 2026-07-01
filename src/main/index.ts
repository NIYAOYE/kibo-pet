import { app } from 'electron'
import { startShell } from './shell'

app.whenReady().then(() => startShell())
app.on('window-all-closed', () => { /* 保持常驻,由托盘退出 */ })
