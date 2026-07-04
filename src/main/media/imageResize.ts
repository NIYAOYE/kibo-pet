/** 计算降采样目标尺寸:最长边 > maxEdge 时等比缩到最长边 = maxEdge,否则原样。 */
export function targetSize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= maxEdge || longest === 0) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}
