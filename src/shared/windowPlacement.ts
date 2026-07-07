import type { Bounds } from './petBrain'

export interface FixedSize {
  width: number
  height: number
}

export function fixedWindowBounds(x: number, y: number, size: FixedSize): Bounds {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  }
}

export function isZeroMove(delta: { dx: number; dy: number }): boolean {
  return delta.dx === 0 && delta.dy === 0
}
