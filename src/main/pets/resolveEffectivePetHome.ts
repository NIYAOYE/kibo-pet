import { basename } from 'node:path'
import { resolvePetHome, type ResolvePetHomeOptions, type ResolvePetHomeResult } from './resolvePetHome'
import { listPets } from './petCatalog'

export interface ResolveEffectivePetHomeOptions extends ResolvePetHomeOptions {
  userPetsDir: string
}

/**
 * resolvePetHome() 只看"配置的 id 有没有对应的宠物包目录",不知道 renderReady 这个正交
 * 维度(渲染引擎是否就绪)。这层包装在其结果之上再补一次检查:若解析出的宠物
 * renderReady===false(即一个 live2d 包,Phase 3 时还没有真实渲染器),按"配置的 id 无效"
 * 同样的口径回退到 defaultPetId 重新解析一次——与 switchPet() 里已有的 renderReady 拦截
 * 口径保持一致。若连回退目标本身都不可用(不应发生),原样放行,交给渲染层的防御性兜底处理。
 */
export function resolveEffectivePetHome(opts: ResolveEffectivePetHomeOptions): ResolvePetHomeResult {
  const first = resolvePetHome(opts)
  if (first.mode === 'onboarding') return first
  const effectiveId = basename(first.petHome.petHome)
  const summary = listPets({ bundledPetsDir: opts.bundledPetsDir, userPetsDir: opts.userPetsDir }).find((p) => p.id === effectiveId)
  if (summary && !summary.renderReady && effectiveId !== opts.defaultPetId) {
    console.warn(`[pet] activePetId "${effectiveId}" 渲染引擎未就绪(live2d,Phase 3 尚无渲染器),回退默认宠物 "${opts.defaultPetId}"`)
    return resolvePetHome({ ...opts, configuredPetId: opts.defaultPetId })
  }
  return first
}
