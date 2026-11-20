/**
 * 修瑕两种补法共用的小块（patch）工具：图层结构、可复现的随机数、
 * 「整块已知」的小块中心、两个小块的平方差。纯函数，不依赖 DOM。
 */

export const PATCH_RADIUS = 3
export const PATCH_SIZE = PATCH_RADIUS * 2 + 1

export interface Level {
  w: number
  h: number
  /** RGB 浮点，长度 w × h × 3 */
  img: Float32Array
  mask: Uint8Array
}

export function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 小块中心可作「来源」：整块在图内且不含待填补像素。用积分图快速判断。 */
export function buildValidSources(level: Level): { valid: Uint8Array; list: Int32Array } {
  const { w, h, mask } = level
  const integral = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0
    for (let x = 0; x < w; x += 1) {
      rowSum += mask[y * w + x]
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum
    }
  }
  const valid = new Uint8Array(w * h)
  const list: number[] = []
  for (let y = PATCH_RADIUS; y < h - PATCH_RADIUS; y += 1) {
    for (let x = PATCH_RADIUS; x < w - PATCH_RADIUS; x += 1) {
      const x0 = x - PATCH_RADIUS
      const y0 = y - PATCH_RADIUS
      const x1 = x + PATCH_RADIUS + 1
      const y1 = y + PATCH_RADIUS + 1
      const holes =
        integral[y1 * (w + 1) + x1] -
        integral[y0 * (w + 1) + x1] -
        integral[y1 * (w + 1) + x0] +
        integral[y0 * (w + 1) + x0]
      if (holes === 0) {
        valid[y * w + x] = 1
        list.push(y * w + x)
      }
    }
  }
  return { valid, list: Int32Array.from(list) }
}

/** 目标小块与来源小块的平方差；超过 best 时提前返回。目标越界的像素跳过（来源保证在图内）。 */
export function patchDistance(
  level: Level,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  best: number,
): number {
  const { w, h, img } = level
  let distance = 0
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
    const ty2 = ty + dy
    if (ty2 < 0 || ty2 >= h) {
      continue
    }
    const sy2 = sy + dy
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
      const tx2 = tx + dx
      if (tx2 < 0 || tx2 >= w) {
        continue
      }
      const ti = (ty2 * w + tx2) * 3
      const si = (sy2 * w + sx + dx) * 3
      const dr = img[ti] - img[si]
      const dg = img[ti + 1] - img[si + 1]
      const db = img[ti + 2] - img[si + 2]
      distance += dr * dr + dg * dg + db * db
    }
    if (distance >= best) {
      return distance
    }
  }
  return distance
}
