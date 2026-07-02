import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore, type SafeStorageLike } from './secrets'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pet-secrets-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

// 假 safeStorage:用 base64 当"加密"(仅测试)
const okSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf-8').toString('base64') as unknown as Buffer,
  // 上一行用 string 冒充 Buffer 便于比较;下方 decrypt 接受同物
  decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf-8')
}
const noSafe: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('unavailable') },
  decryptString: () => { throw new Error('unavailable') }
}

describe('secretStore', () => {
  it('stores and reads back a key when encryption is available', () => {
    const store = createSecretStore(join(tmp(), 'secrets.bin'), okSafe)
    expect(store.hasKey()).toBe(false)
    expect(store.setKey('sk-123')).toBe(true)
    expect(store.hasKey()).toBe(true)
    expect(store.getKey()).toBe('sk-123')
  })

  it('refuses to store (returns false, writes nothing) when encryption is unavailable', () => {
    const file = join(tmp(), 'secrets.bin')
    const store = createSecretStore(file, noSafe)
    expect(store.setKey('sk-123')).toBe(false)
    expect(store.hasKey()).toBe(false)
    expect(store.getKey()).toBe(null)
  })

  it('clear removes the stored key', () => {
    const store = createSecretStore(join(tmp(), 'secrets.bin'), okSafe)
    store.setKey('sk-1')
    store.clear()
    expect(store.hasKey()).toBe(false)
  })
})
