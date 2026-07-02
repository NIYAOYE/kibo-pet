import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export interface SecretStore {
  hasKey(): boolean
  getKey(): string | null
  setKey(key: string): boolean
  clear(): void
}

export function createSecretStore(file: string, safe: SafeStorageLike): SecretStore {
  return {
    hasKey: () => existsSync(file),
    getKey: () => {
      if (!existsSync(file)) return null
      try { return safe.decryptString(readFileSync(file)) } catch { return null }
    },
    setKey: (key: string): boolean => {
      if (!safe.isEncryptionAvailable()) return false
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, safe.encryptString(key))
      renameSync(tmp, file)
      return true
    },
    clear: () => { try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ } }
  }
}
