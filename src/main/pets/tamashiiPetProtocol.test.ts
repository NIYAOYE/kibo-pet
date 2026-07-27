import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTamashiiPetProtocolRegistry, TAMASHII_PET_SCHEME_PRIVILEGES } from './tamashiiPetProtocol'

function scratchModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tamashiipet-'))
  mkdirSync(join(dir, 'textures'), { recursive: true })
  writeFileSync(join(dir, 'character.model3.json'), '{}')
  writeFileSync(join(dir, 'textures', 'tex_00.png'), 'fake-png-bytes')
  return dir
}

describe('TAMASHII_PET_SCHEME_PRIVILEGES', () => {
  it('is standard/secure/fetch-enabled/CORS-enabled, does not bypass CSP', () => {
    expect(TAMASHII_PET_SCHEME_PRIVILEGES.scheme).toBe('tamashii-pet')
    // corsEnabled 必须是 true——渲染层(file:// 源)通过 XHR/fetch 跨源加载模型资源,
    // Chromium 只看这个声明,声明成 false 会在真机上把所有跨源请求拦在 handler 之前
    // (Phase 4 真机验证时实际复现过)。
    expect(TAMASHII_PET_SCHEME_PRIVILEGES.privileges).toMatchObject({
      standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false
    })
  })
})

describe('createTamashiiPetProtocolRegistry', () => {
  it('resolves an allowed file under a registered root', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    const result = reg.resolveRequest(`tamashii-pet://${token}/textures/tex_00.png`)
    expect(result).toMatchObject({ mimeType: 'image/png' })
    if (!('error' in result)) expect(result.filePath.endsWith('tex_00.png')).toBe(true)
  })
  it('404s for an unknown token', () => {
    const reg = createTamashiiPetProtocolRegistry()
    expect(reg.resolveRequest('tamashii-pet://not-a-real-token/x.png')).toEqual({ error: 404 })
  })
  it('403s for a disallowed extension', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    writeFileSync(join(dir, 'evil.exe'), 'x')
    expect(reg.resolveRequest(`tamashii-pet://${token}/evil.exe`)).toEqual({ error: 403 })
  })
  it('403s for a path that escapes the registered root via traversal', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    const result = reg.resolveRequest(`tamashii-pet://${token}/../../../etc/passwd.json`)
    expect(result).toMatchObject({ error: 403 })
  })
  it('403s when the path segment is itself an absolute path on a different drive than the registered root', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir() // lives under os.tmpdir(), i.e. the C: drive on this machine
    const token = reg.registerToken(dir)
    // A cross-drive absolute path smuggled into the URL's path segment. `path.resolve(root, relPath)`
    // discards `root` entirely for an absolute `relPath`, and because root/target don't share a
    // drive, `path.relative(root, resolved)` returns the target unchanged (not `..`-prefixed) —
    // that's the exact bypass this test guards against. Must 403 regardless of file existence.
    const result = reg.resolveRequest(`tamashii-pet://${token}/D:/some/secret.json`)
    expect(result).toMatchObject({ error: 403 })
  })
  it('403s when the path segment is itself a UNC path that would escape the registered root', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    // Literal backslashes (not %5C-encoded) survive the leading-slash strip in resolveRequest
    // (that regex only strips forward slashes), so this reaches path.resolve as a genuine UNC
    // absolute path — same class of bypass as the drive-letter case above.
    const result = reg.resolveRequest(`tamashii-pet://${token}/\\\\host\\share\\file.json`)
    expect(result).toMatchObject({ error: 403 })
  })
  it('404s for a nonexistent file under a valid root', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    expect(reg.resolveRequest(`tamashii-pet://${token}/nope.json`)).toEqual({ error: 404 })
  })
  it('revoked token immediately stops resolving', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    reg.revokeToken(token)
    expect(reg.resolveRequest(`tamashii-pet://${token}/character.model3.json`)).toEqual({ error: 404 })
  })
  // M-1: 一个格式错误的百分号转义(如 %zz)会让 decodeURIComponent 抛 URIError;之前
  // resolveRequest 没有包一层 try/catch,会让整个函数往外抛,导致 protocol.handle 那个
  // Promise 被 reject(而不是这个函数里其它非法请求统一返回的干净 { error: 404 })。
  it('返回干净的 { error: 404 } 而不是抛出,当路径段含格式错误的百分号转义时', () => {
    const reg = createTamashiiPetProtocolRegistry()
    const dir = scratchModelDir()
    const token = reg.registerToken(dir)
    expect(() => reg.resolveRequest(`tamashii-pet://${token}/model%zzbad.json`)).not.toThrow()
    expect(reg.resolveRequest(`tamashii-pet://${token}/model%zzbad.json`)).toEqual({ error: 404 })
  })
})
