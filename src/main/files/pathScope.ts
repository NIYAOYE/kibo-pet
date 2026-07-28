import { resolve, sep, isAbsolute } from 'node:path'

export type SafePathResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string }

/**
 * 把 agent 传入的相对路径解析成沙箱根目录内的绝对路径,越界(绝对路径/`..` 逃逸/
 * 大小写前缀碰撞)一律拒绝。只做路径计算,不碰真实文件系统、不检查文件是否存在——
 * 是否存在由调用方(fileTools.ts)按各工具语义自行判断。
 *
 * 假设:不做符号链接逃逸检测(不调用 fs.realpathSync)——第一阶段沙箱目录由
 * ensurePetHome 创建、agent 只能通过 write_file/edit_file 写入文本内容,没有
 * 任何工具能创建符号链接。若第二阶段允许用户指定真实目录(可能已存在外部符号
 * 链接/junction),需要重新评估这个假设、补符号链接检测。
 */
export function resolveSafePath(root: string, relativePath: string): SafePathResult {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return { ok: false, reason: '路径不能为空' }
  }
  if (isAbsolute(relativePath)) {
    return { ok: false, reason: '路径不合法:只能使用相对于工作目录的相对路径,不能是绝对路径' }
  }
  const normalizedRoot = resolve(root)
  const candidate = resolve(normalizedRoot, relativePath)
  // 统一按小写比较包含关系:Windows 文件系统大小写不敏感,且这只影响"是否越界"
  // 的判断,返回的 absolutePath 仍是原始大小写,不影响实际文件读写。
  const rootForCompare = normalizedRoot.toLowerCase()
  const candidateForCompare = candidate.toLowerCase()
  const withinRoot = candidateForCompare === rootForCompare || candidateForCompare.startsWith(rootForCompare + sep)
  if (!withinRoot) {
    return { ok: false, reason: '路径不合法:只能访问工作目录内的文件,不能越界访问工作目录以外的路径' }
  }
  return { ok: true, absolutePath: candidate }
}
