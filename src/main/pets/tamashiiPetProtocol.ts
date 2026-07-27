import { protocol, net } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TAMASHII_PET_SCHEME = 'tamashii-pet'

/** 喂给 Electron `protocol.registerSchemesAsPrivileged`;必须在 app.ready 之前调用
 *  (Phase 4 接线时的职责,本文件不调用)。不开 bypassCSP/Service Worker/扩展权限。
 *  `corsEnabled` 必须是 true——渲染层(file:// 源)通过 XHR/fetch 从 tamashii-pet:// 这个
 *  不同源加载模型 JSON/贴图,Chromium 的 CORS 校验只看 scheme 是否声明 corsEnabled,
 *  与这个 handler 自己的响应内容无关;声明成 false(Phase 2 建基础设施时的默认值,当时还
 *  没有真正的跨源消费方,没触发这条)会导致所有跨源 XHR/fetch 请求在到达 handler 之前就被
 *  浏览器直接拦掉,真机验证 Phase 4 时才暴露。 */
export const TAMASHII_PET_SCHEME_PRIVILEGES = {
  scheme: TAMASHII_PET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false }
}

const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

export type ProtocolResolveResult = { filePath: string; mimeType: string } | { error: 403 | 404 }

export function createTamashiiPetProtocolRegistry(): {
  registerToken(rootDir: string): string
  revokeToken(token: string): void
  resolveRequest(url: string): ProtocolResolveResult
} {
  const tokens = new Map<string, string>() // token -> resolved root dir

  return {
    registerToken(rootDir) {
      const token = randomBytes(16).toString('hex')
      tokens.set(token, resolve(rootDir))
      return token
    },
    revokeToken(token) {
      tokens.delete(token)
    },
    resolveRequest(url) {
      // Manual URL parsing to avoid pathname normalization by the URL class
      // (URL class normalizes /../ away, breaking traversal detection)
      const match = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(.*?)(?:\?|#|$)/i)
      if (!match) return { error: 404 }
      const scheme = match[1]
      const authority = match[2]
      const pathAndQuery = match[3]

      if (scheme !== TAMASHII_PET_SCHEME) return { error: 404 }
      const root = tokens.get(authority)
      if (!root) return { error: 404 }

      // 格式错误的百分号转义(如 "%zz")会让 decodeURIComponent 抛 URIError;这里必须捕获
      // 掉,不然会让整个 resolveRequest 往外抛,导致 protocol.handle 的 Promise 被 reject,
      // 而不是这个函数里其它非法请求统一返回的干净 { error: 404 }。
      let decodedPath: string
      try {
        decodedPath = decodeURIComponent(pathAndQuery)
      } catch {
        return { error: 404 }
      }
      const relPath = decodedPath.replace(/^\/+/, '')
      const ext = extname(relPath).toLowerCase()
      const mimeType = ALLOWED_EXTENSIONS[ext]
      if (!mimeType) return { error: 403 }

      const resolved = resolve(root, relPath)
      if (resolved !== root && !resolved.startsWith(root + sep)) return { error: 403 }
      if (!existsSync(resolved)) return { error: 404 }
      try {
        if (lstatSync(resolved).isSymbolicLink()) return { error: 403 }
      } catch {
        return { error: 404 }
      }
      return { filePath: resolved, mimeType }
    }
  }
}

/**
 * Electron `protocol.handle` 胶水层。**Phase 2 不调用这个函数**——它没有消费方,写在这里
 * 是给 Phase 4 现成用的基础设施。真正接线(含 app.ready 前的 registerSchemesAsPrivileged)
 * 留给 Phase 4。
 */
export function installTamashiiPetProtocolHandler(
  registry: ReturnType<typeof createTamashiiPetProtocolRegistry>
): void {
  protocol.handle(TAMASHII_PET_SCHEME, async (request) => {
    const result = registry.resolveRequest(request.url)
    if ('error' in result) return new Response(null, { status: result.error })
    return net.fetch(pathToFileURL(result.filePath).toString())
  })
}
