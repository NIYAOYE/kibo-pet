// electron-builder afterPack 钩子。
//
// minimal_tts/ 是一个 ~8GB 的外部 TTS 引擎,不随源码分发(见 .gitignore),开发者需自行把它
// 放在仓库根目录的 minimal_tts/ 下(与 settings.tts.packagePath 缺省时的开发态约定路径一致)
// 才能被打进安装包。electron-builder 的静态 YAML extraResources 在 from 路径不存在时会直接
// 中止整个 pnpm dist —— 但语音功能本身是可选的、默认关闭的,不应该因为它缺失就让打包本身
// 完全跑不起来。这个钩子把"是否存在"的判断挪到运行时:存在就复制,不存在就跳过并打印说明,
// 任何一种情况都不能让 pnpm dist 失败。
//
// electron-builder 会把这里的 exports.default 当作 afterPack(context) 处理器调用
// (context.appOutDir 是本次打包产物所在目录),复制目标路径 `${appOutDir}/resources/minimal_tts`
// 与静态 extraResources 条目 `{ from: minimal_tts, to: minimal_tts }` 产出的落盘位置完全一致
// (electron-builder 的 Windows nsis/portable target 把 extraResources 放在 <appOutDir>/resources/ 下)。

const fs = require('fs')
const path = require('path')

exports.default = async function (context) {
  const projectRoot = path.resolve(__dirname, '..')
  const srcDir = path.join(projectRoot, 'minimal_tts')
  const destDir = path.join(context.appOutDir, 'resources', 'minimal_tts')

  let stat
  try {
    stat = fs.statSync(srcDir)
  } catch {
    stat = null
  }

  if (!stat || !stat.isDirectory()) {
    console.log(
      '[afterPack] 未在仓库根目录找到 minimal_tts/,本次打包将不包含语音(TTS)功能——' +
        '这是预期行为、非致命错误,不影响其余功能正常打包。'
    )
    return
  }

  try {
    fs.cpSync(srcDir, destDir, { recursive: true })
    console.log(`[afterPack] 已将 minimal_tts/ 复制到打包产物:${destDir}`)
  } catch (err) {
    console.warn(
      `[afterPack] 复制 minimal_tts/ 到打包产物时出错,已跳过(打包将继续,语音功能在本次产物中不可用):${
        err && err.message ? err.message : err
      }`
    )
  }
}
