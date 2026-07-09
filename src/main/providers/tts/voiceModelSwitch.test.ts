import { describe, it, expect, vi } from 'vitest'
import {
  defaultVoiceBackupDir, hasPetVoice, readVoiceMeta,
  planVoiceSwitch, applyVoiceCopyPlan, planBackupDefaultVoice,
  type AliceConfig
} from './voiceModelSwitch'
import { join } from 'node:path'

const packageRoot = 'C:\\minimal_tts'
const currentConfig: AliceConfig = {
  version: 'v4',
  gpt_weight: 'models/Alice-e15.ckpt',
  sovits_lora: 'models/Alice_e2_s758_l32.pth',
  sovits_base: 'models/s2Gv4.pth',
  vocoder: 'models/vocoder.pth',
  bert_dir: 'models/chinese-roberta-wwm-ext-large',
  hubert_dir: 'models/chinese-hubert-base',
  default_reference: 'reference/alice.wav',
  prompt_text: 'rpg で例えるなら',
  prompt_language: 'ja'
}

describe('defaultVoiceBackupDir', () => {
  it('固定放在 packageRoot/models/_default_voice', () => {
    expect(defaultVoiceBackupDir(packageRoot)).toBe(join(packageRoot, 'models', '_default_voice'))
  })
})

describe('hasPetVoice', () => {
  it('四个文件都存在 → true', () => {
    const exists = () => true
    expect(hasPetVoice(exists, 'C:\\pets\\luluka\\voice\\tts')).toBe(true)
  })
  it('缺任意一个文件 → false', () => {
    const missing = new Set(['C:\\pets\\luluka\\voice\\tts\\voice.json'])
    const exists = (p: string) => !missing.has(p)
    expect(hasPetVoice(exists, 'C:\\pets\\luluka\\voice\\tts')).toBe(false)
  })
})

describe('readVoiceMeta', () => {
  it('合法 voice.json → 解析 promptText/promptLanguage', () => {
    const readFile = () => JSON.stringify({ promptText: '你好', promptLanguage: 'zh' })
    expect(readVoiceMeta(readFile, 'C:\\pets\\luluka\\voice\\tts')).toEqual({ promptText: '你好', promptLanguage: 'zh' })
  })
  it('promptLanguage 非法 → null', () => {
    const readFile = () => JSON.stringify({ promptText: '你好', promptLanguage: 'fr' })
    expect(readVoiceMeta(readFile, 'x')).toBeNull()
  })
  it('promptText 缺失/非字符串 → null', () => {
    expect(readVoiceMeta(() => JSON.stringify({ promptLanguage: 'zh' }), 'x')).toBeNull()
  })
  it('读取抛错(文件不存在)→ null', () => {
    const readFile = () => { throw new Error('ENOENT') }
    expect(readVoiceMeta(readFile, 'x')).toBeNull()
  })
  it('坏 JSON → null', () => {
    expect(readVoiceMeta(() => '{ not json', 'x')).toBeNull()
  })
})

describe('planVoiceSwitch', () => {
  const backupMeta = { promptText: 'rpg で例えるなら', promptLanguage: 'ja' as const }

  it('宠物有专属音色:从宠物 voice/tts 拷到 config 声明的三个目标路径,config 的 prompt 字段换成宠物的', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig,
      petVoiceDir: 'C:\\pets\\luluka\\voice\\tts',
      petMeta: { promptText: '早安喵', promptLanguage: 'zh' },
      backupMeta
    })
    expect(plan.copies).toEqual([
      { from: 'C:\\pets\\luluka\\voice\\tts\\gpt.ckpt', to: join(packageRoot, 'models/Alice-e15.ckpt') },
      { from: 'C:\\pets\\luluka\\voice\\tts\\sovits.pth', to: join(packageRoot, 'models/Alice_e2_s758_l32.pth') },
      { from: 'C:\\pets\\luluka\\voice\\tts\\reference.wav', to: join(packageRoot, 'reference/alice.wav') }
    ])
    expect(plan.patchedConfig.prompt_text).toBe('早安喵')
    expect(plan.patchedConfig.prompt_language).toBe('zh')
    // 非声音字段原样保留(共享 base 权重不动)
    expect(plan.patchedConfig.sovits_base).toBe('models/s2Gv4.pth')
    expect(plan.patchedConfig.vocoder).toBe('models/vocoder.pth')
  })

  it('宠物没有专属音色(petVoiceDir 为 null):从默认备份拷回,prompt 字段换成备份的', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig, petVoiceDir: null, petMeta: null, backupMeta
    })
    const backupDir = join(packageRoot, 'models', '_default_voice')
    expect(plan.copies).toEqual([
      { from: join(backupDir, 'gpt.ckpt'), to: join(packageRoot, 'models/Alice-e15.ckpt') },
      { from: join(backupDir, 'sovits.pth'), to: join(packageRoot, 'models/Alice_e2_s758_l32.pth') },
      { from: join(backupDir, 'reference.wav'), to: join(packageRoot, 'reference/alice.wav') }
    ])
    expect(plan.patchedConfig.prompt_text).toBe('rpg で例えるなら')
    expect(plan.patchedConfig.prompt_language).toBe('ja')
  })

  it('petVoiceDir 非 null 但 petMeta 是 null(voice.json 解析失败)→ 视同没有专属音色,回退备份', () => {
    const plan = planVoiceSwitch({
      packageRoot, currentConfig, petVoiceDir: 'C:\\pets\\bad\\voice\\tts', petMeta: null, backupMeta
    })
    expect(plan.patchedConfig.prompt_text).toBe(backupMeta.promptText)
  })
})

describe('applyVoiceCopyPlan', () => {
  it('依次执行 copies 并把 patchedConfig 写到 configPath', () => {
    const copyFileSync = vi.fn()
    const writeFileSync = vi.fn()
    const plan = {
      copies: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }],
      patchedConfig: { ...currentConfig, prompt_text: 'x' }
    }
    applyVoiceCopyPlan(plan, { copyFileSync, writeFileSync }, 'C:\\minimal_tts\\config\\alice.json')
    expect(copyFileSync).toHaveBeenNthCalledWith(1, 'a', 'b')
    expect(copyFileSync).toHaveBeenNthCalledWith(2, 'c', 'd')
    expect(writeFileSync).toHaveBeenCalledWith('C:\\minimal_tts\\config\\alice.json', JSON.stringify(plan.patchedConfig, null, 2))
  })
})

describe('planBackupDefaultVoice', () => {
  it('从 currentConfig 声明的三个路径拷到 _default_voice/,并产出 meta.json 内容', () => {
    const plan = planBackupDefaultVoice(packageRoot, currentConfig)
    const backupDir = join(packageRoot, 'models', '_default_voice')
    expect(plan.copies).toEqual([
      { from: join(packageRoot, 'models/Alice-e15.ckpt'), to: join(backupDir, 'gpt.ckpt') },
      { from: join(packageRoot, 'models/Alice_e2_s758_l32.pth'), to: join(backupDir, 'sovits.pth') },
      { from: join(packageRoot, 'reference/alice.wav'), to: join(backupDir, 'reference.wav') }
    ])
    expect(plan.metaPath).toBe(join(backupDir, 'meta.json'))
    expect(JSON.parse(plan.metaJson)).toEqual({ promptText: currentConfig.prompt_text, promptLanguage: currentConfig.prompt_language })
  })
})
