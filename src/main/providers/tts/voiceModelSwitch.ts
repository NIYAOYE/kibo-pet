/** 按宠物包切换 minimal_tts 音色:纯规划函数(planXxx)+ 薄 apply 函数,
 *  真实 fs 调用只在 shell/index.ts 里接线(见设计文档 §4)。 */
import { join } from 'node:path'
import type { TtsLanguage } from '@shared/llm'

export interface AliceConfig {
  gpt_weight: string
  sovits_lora: string
  default_reference: string
  prompt_text: string
  prompt_language: TtsLanguage
  [key: string]: unknown
}

export interface VoiceMeta { promptText: string; promptLanguage: TtsLanguage }

const TTS_LANGUAGES: TtsLanguage[] = ['zh', 'ja', 'en']

export function defaultVoiceBackupDir(packageRoot: string): string {
  return join(packageRoot, 'models', '_default_voice')
}

/** pets/<id>/voice/tts/{gpt.ckpt,sovits.pth,reference.wav,voice.json} 四份文件都存在才算有专属音色。 */
export function hasPetVoice(exists: (p: string) => boolean, petVoiceDir: string): boolean {
  return (
    exists(join(petVoiceDir, 'gpt.ckpt')) &&
    exists(join(petVoiceDir, 'sovits.pth')) &&
    exists(join(petVoiceDir, 'reference.wav')) &&
    exists(join(petVoiceDir, 'voice.json'))
  )
}

export function readVoiceMeta(readFile: (p: string) => string, petVoiceDir: string): VoiceMeta | null {
  try {
    const raw = JSON.parse(readFile(join(petVoiceDir, 'voice.json'))) as Record<string, unknown>
    if (typeof raw.promptText !== 'string' || !raw.promptText) return null
    if (!TTS_LANGUAGES.includes(raw.promptLanguage as TtsLanguage)) return null
    return { promptText: raw.promptText, promptLanguage: raw.promptLanguage as TtsLanguage }
  } catch {
    return null
  }
}

export interface VoiceCopyPlan {
  copies: Array<{ from: string; to: string }>
  patchedConfig: AliceConfig
}

/** 三份声音文件的拷贝源:宠物有专属音色(petVoiceDir+petMeta 均非空)时用宠物的,否则用默认备份。 */
export function planVoiceSwitch(opts: {
  packageRoot: string
  currentConfig: AliceConfig
  petVoiceDir: string | null
  petMeta: VoiceMeta | null
  backupMeta: VoiceMeta
}): VoiceCopyPlan {
  const useSource = opts.petVoiceDir && opts.petMeta
    ? { dir: opts.petVoiceDir, meta: opts.petMeta }
    : { dir: defaultVoiceBackupDir(opts.packageRoot), meta: opts.backupMeta }

  const copies = [
    { from: join(useSource.dir, 'gpt.ckpt'), to: join(opts.packageRoot, opts.currentConfig.gpt_weight) },
    { from: join(useSource.dir, 'sovits.pth'), to: join(opts.packageRoot, opts.currentConfig.sovits_lora) },
    { from: join(useSource.dir, 'reference.wav'), to: join(opts.packageRoot, opts.currentConfig.default_reference) }
  ]
  const patchedConfig: AliceConfig = {
    ...opts.currentConfig,
    prompt_text: useSource.meta.promptText,
    prompt_language: useSource.meta.promptLanguage
  }
  return { copies, patchedConfig }
}

export function applyVoiceCopyPlan(
  plan: VoiceCopyPlan,
  fs: { copyFileSync: (from: string, to: string) => void; writeFileSync: (path: string, content: string) => void },
  configPath: string
): void {
  for (const c of plan.copies) fs.copyFileSync(c.from, c.to)
  fs.writeFileSync(configPath, JSON.stringify(plan.patchedConfig, null, 2))
}

/** 首次接入 minimal_tts 时,把当前(未被任何宠物覆盖过的)默认音色备份一份到 models/_default_voice/,
 *  供之后"没有专属音色的宠物"回退用。只读 currentConfig,不做存在性判断(是否需要执行由调用方按
 *  meta.json 是否已存在来决定,幂等地跳过)。 */
export function planBackupDefaultVoice(
  packageRoot: string,
  currentConfig: AliceConfig
): { copies: Array<{ from: string; to: string }>; metaPath: string; metaJson: string } {
  const backupDir = defaultVoiceBackupDir(packageRoot)
  const copies = [
    { from: join(packageRoot, currentConfig.gpt_weight), to: join(backupDir, 'gpt.ckpt') },
    { from: join(packageRoot, currentConfig.sovits_lora), to: join(backupDir, 'sovits.pth') },
    { from: join(packageRoot, currentConfig.default_reference), to: join(backupDir, 'reference.wav') }
  ]
  const metaJson = JSON.stringify({ promptText: currentConfig.prompt_text, promptLanguage: currentConfig.prompt_language })
  return { copies, metaPath: join(backupDir, 'meta.json'), metaJson }
}
