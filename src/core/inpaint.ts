/**
 * 「局部修瑕」的经典算法（content-aware fill），两种补法各算一遍：
 *
 * - 结构优先（offsetFill.ts）：统计画面里反复出现的位移（栏杆间距、砖缝、窗格），
 *   用图割把洞拼成「整段平移过来」的内容，再用泊松融合抹平颜色接缝。直线、重复结构能完整延续；
 * - 平滑优先：建图像金字塔，最粗层由外向内扩散颜色打底，之后每一层用 Wexler 2007 的期望最大化细化——
 *   为每个与洞重叠的 7×7 小块用 PatchMatch（Barnes 2009）找最相似的完好小块，按相似度投票取色，
 *   最后一步取最相似小块的中心像素避免发糊。适合天空、渐变、曲面这类没有直线结构的照片。
 *
 * 两种结果用同一个指标比较：洞内小块与原图最相似小块的平均差异（越小越连贯），默认取更小的那个，
 * 另一个一并返回，界面上可一键换用。
 *
 * 纯函数，只处理类型数组，不依赖 DOM，在 Web Worker 和单元测试里都能跑。
 */

import { offsetFill } from './offsetFill'
import {
  buildValidSources,
  createRandom,
  patchDistance,
  PATCH_RADIUS,
  PATCH_SIZE,
  type Level,
} from './patchUtils'

export interface InpaintInput {
  width: number
  height: number
  /** RGBA，长度 width × height × 4 */
  rgba: Uint8ClampedArray
  /** 1 表示待填补，长度 width × height */
  mask: Uint8Array
  /** 随机种子；同一输入同一种子结果相同，便于测试 */
  seed?: number
  /** 补法；默认 auto：两种都算，取更连贯的结果 */
  strategy?: InpaintStrategy
  onProgress?: (fraction: number) => void
}

export type InpaintStrategy = 'auto' | 'structure' | 'smooth'

export interface InpaintResult {
  rgba: Uint8ClampedArray
  /** 实际采用的补法 */
  strategy: 'structure' | 'smooth'
  /** 洞内小块与原图最相似小块的平均平方差（每通道），越小越连贯 */
  energy: number
}

const MAX_LEVELS = 7
/** 平滑补法起始层上洞的最大边长（像素）：洞比这大就继续缩小一层。 */
const START_HOLE_EXTENT = 64
/** 计算连贯度时 PatchMatch 的迭代次数（两种补法用同样的次数，才能公平比较）。 */
const ENERGY_ITERATIONS = 4

function toLevel(input: InpaintInput): Level {
  const { width: w, height: h, rgba, mask } = input
  const img = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i += 1) {
    img[i * 3] = rgba[i * 4]
    img[i * 3 + 1] = rgba[i * 4 + 1]
    img[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return { w, h, img, mask: Uint8Array.from(mask, (value) => (value ? 1 : 0)) }
}

/** 2×2 合并：完好像素取平均；只要有一个子像素待填补，合并后的像素也算待填补（洞不会在粗层消失）。 */
function downsample(level: Level): Level {
  const w = Math.max(1, Math.floor(level.w / 2))
  const h = Math.max(1, Math.floor(level.h / 2))
  const img = new Float32Array(w * h * 3)
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      let hole = 0
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const sx = Math.min(level.w - 1, x * 2 + dx)
          const sy = Math.min(level.h - 1, y * 2 + dy)
          const si = sy * level.w + sx
          if (level.mask[si]) {
            hole = 1
          } else {
            r += level.img[si * 3]
            g += level.img[si * 3 + 1]
            b += level.img[si * 3 + 2]
            count += 1
          }
        }
      }
      const i = y * w + x
      mask[i] = hole
      if (count > 0) {
        img[i * 3] = r / count
        img[i * 3 + 1] = g / count
        img[i * 3 + 2] = b / count
      }
    }
  }
  return { w, h, img, mask }
}

function holeExtent(level: Level): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < level.w * level.h; i += 1) {
    if (!level.mask[i]) {
      continue
    }
    const x = i % level.w
    const y = (i - x) / level.w
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return maxX < minX ? 0 : Math.max(maxX - minX + 1, maxY - minY + 1)
}

/** 由外向内一圈圈用已知邻居的平均色填洞：平滑补法的打底。 */
function diffuseFill(level: Level): void {
  const { w, h, img, mask } = level
  const filled = Uint8Array.from(mask, (value) => (value ? 0 : 1))
  let remaining = mask.reduce((sum, value) => sum + value, 0)
  if (remaining === w * h) {
    img.fill(128)
    return
  }
  while (remaining > 0) {
    const next: number[] = []
    for (let i = 0; i < w * h; i += 1) {
      if (filled[i]) {
        continue
      }
      const x = i % w
      const y = (i - x) / w
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            continue
          }
          const ni = ny * w + nx
          if (filled[ni]) {
            r += img[ni * 3]
            g += img[ni * 3 + 1]
            b += img[ni * 3 + 2]
            count += 1
          }
        }
      }
      if (count > 0) {
        img[i * 3] = r / count
        img[i * 3 + 1] = g / count
        img[i * 3 + 2] = b / count
        next.push(i)
      }
    }
    if (next.length === 0) {
      break
    }
    for (const i of next) {
      filled[i] = 1
    }
    remaining -= next.length
  }
}

/** 需要找近邻的目标：小块与待填补区域有重叠的所有中心（洞向外扩一个小块半径）。 */
function buildTargets(level: Level): { isTarget: Uint8Array; list: Int32Array } {
  const { w, h, mask } = level
  const isTarget = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) {
        continue
      }
      for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= h) {
          continue
        }
        for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
          const nx = x + dx
          if (nx >= 0 && nx < w) {
            isTarget[ny * w + nx] = 1
          }
        }
      }
    }
  }
  const list: number[] = []
  for (let i = 0; i < w * h; i += 1) {
    if (isTarget[i]) {
      list.push(i)
    }
  }
  return { isTarget, list: Int32Array.from(list) }
}

interface Field {
  sx: Int32Array
  sy: Int32Array
  distance: Float64Array
}

function randomValid(list: Int32Array, random: () => number, w: number): [number, number] {
  const index = list[Math.floor(random() * list.length)]
  const x = index % w
  return [x, (index - x) / w]
}

function initField(level: Level, targets: Int32Array, sources: Int32Array, random: () => number): Field {
  const size = level.w * level.h
  const field: Field = {
    sx: new Int32Array(size),
    sy: new Int32Array(size),
    distance: new Float64Array(size),
  }
  for (const t of targets) {
    const [sx, sy] = randomValid(sources, random, level.w)
    field.sx[t] = sx
    field.sy[t] = sy
  }
  return field
}

/** 把上一层（粗）的近邻场放大到这一层，坐标 ×2，不合法时随机换一个来源。 */
function upsampleField(
  coarse: Field,
  coarseLevel: Level,
  level: Level,
  targets: Int32Array,
  valid: Uint8Array,
  sources: Int32Array,
  random: () => number,
): Field {
  const size = level.w * level.h
  const field: Field = {
    sx: new Int32Array(size),
    sy: new Int32Array(size),
    distance: new Float64Array(size),
  }
  for (const t of targets) {
    const x = t % level.w
    const y = (t - x) / level.w
    const cx = Math.min(coarseLevel.w - 1, x >> 1)
    const cy = Math.min(coarseLevel.h - 1, y >> 1)
    const ci = cy * coarseLevel.w + cx
    let sx = coarse.sx[ci] * 2 + (x & 1)
    let sy = coarse.sy[ci] * 2 + (y & 1)
    sx = Math.min(level.w - 1 - PATCH_RADIUS, Math.max(PATCH_RADIUS, sx))
    sy = Math.min(level.h - 1 - PATCH_RADIUS, Math.max(PATCH_RADIUS, sy))
    if (!valid[sy * level.w + sx]) {
      ;[sx, sy] = randomValid(sources, random, level.w)
    }
    field.sx[t] = sx
    field.sy[t] = sy
  }
  return field
}

function patchMatch(
  level: Level,
  field: Field,
  targets: Int32Array,
  isTarget: Uint8Array,
  valid: Uint8Array,
  iterations: number,
  random: () => number,
): void {
  const { w, h } = level
  for (const t of targets) {
    const x = t % w
    field.distance[t] = patchDistance(level, x, (t - x) / w, field.sx[t], field.sy[t], Infinity)
  }
  const maxRadius = Math.max(w, h)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forward = iteration % 2 === 0
    const step = forward ? 1 : -1
    for (let k = 0; k < targets.length; k += 1) {
      const t = targets[forward ? k : targets.length - 1 - k]
      const tx = t % w
      const ty = (t - tx) / w
      let bestX = field.sx[t]
      let bestY = field.sy[t]
      let best = field.distance[t]

      // 传播：扫描方向上的前一个邻居找到的来源，平移一格后可能也适合自己。
      const nx = tx - step
      if (nx >= 0 && nx < w && isTarget[ty * w + nx]) {
        const n = ty * w + nx
        const cx = field.sx[n] + step
        const cy = field.sy[n]
        if (cx >= 0 && cx < w && valid[cy * w + cx] && (cx !== bestX || cy !== bestY)) {
          const d = patchDistance(level, tx, ty, cx, cy, best)
          if (d < best) {
            best = d
            bestX = cx
            bestY = cy
          }
        }
      }
      const ny = ty - step
      if (ny >= 0 && ny < h && isTarget[ny * w + tx]) {
        const n = ny * w + tx
        const cx = field.sx[n]
        const cy = field.sy[n] + step
        if (cy >= 0 && cy < h && valid[cy * w + cx] && (cx !== bestX || cy !== bestY)) {
          const d = patchDistance(level, tx, ty, cx, cy, best)
          if (d < best) {
            best = d
            bestX = cx
            bestY = cy
          }
        }
      }

      // 随机搜索：在当前最优附近以指数缩小的半径试探。
      for (let radius = maxRadius; radius >= 1; radius = Math.floor(radius / 2)) {
        const cx = Math.round(bestX + (random() * 2 - 1) * radius)
        const cy = Math.round(bestY + (random() * 2 - 1) * radius)
        if (cx < 0 || cy < 0 || cx >= w || cy >= h || !valid[cy * w + cx]) {
          continue
        }
        const d = patchDistance(level, tx, ty, cx, cy, best)
        if (d < best) {
          best = d
          bestX = cx
          bestY = cy
        }
      }

      field.sx[t] = bestX
      field.sy[t] = bestY
      field.distance[t] = best
    }
  }
}

/** 待填补像素按覆盖它的所有小块投票取色，越相似的小块权重越大。 */
function vote(level: Level, field: Field, targets: Int32Array): void {
  const { w, h, img, mask } = level
  const sorted = Array.from(targets, (t) => field.distance[t]).sort((a, b) => a - b)
  const sigma2 = Math.max(1, sorted[Math.floor(sorted.length / 2)] ?? 1)
  const accumulate = new Float64Array(w * h * 3)
  const weights = new Float64Array(w * h)
  for (const t of targets) {
    const tx = t % w
    const ty = (t - tx) / w
    const sx = field.sx[t]
    const sy = field.sy[t]
    const weight = Math.exp(-field.distance[t] / (2 * sigma2))
    for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
      const py = ty + dy
      if (py < 0 || py >= h) {
        continue
      }
      for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
        const px = tx + dx
        if (px < 0 || px >= w) {
          continue
        }
        const p = py * w + px
        if (!mask[p]) {
          continue
        }
        const q = ((sy + dy) * w + sx + dx) * 3
        accumulate[p * 3] += weight * img[q]
        accumulate[p * 3 + 1] += weight * img[q + 1]
        accumulate[p * 3 + 2] += weight * img[q + 2]
        weights[p] += weight
      }
    }
  }
  for (let p = 0; p < w * h; p += 1) {
    if (mask[p] && weights[p] > 0) {
      img[p * 3] = accumulate[p * 3] / weights[p]
      img[p * 3 + 1] = accumulate[p * 3 + 1] / weights[p]
      img[p * 3 + 2] = accumulate[p * 3 + 2] / weights[p]
    }
  }
}

/** 最后一步：待填补像素直接取自己最相似小块的中心像素，保留纹理锐度。 */
function copyCenters(level: Level, field: Field): void {
  const { w, h, img, mask } = level
  const result = img.slice()
  for (let p = 0; p < w * h; p += 1) {
    if (!mask[p]) {
      continue
    }
    const q = (field.sy[p] * w + field.sx[p]) * 3
    result[p * 3] = img[q]
    result[p * 3 + 1] = img[q + 1]
    result[p * 3 + 2] = img[q + 2]
  }
  img.set(result)
}

/** 把粗一层的结果放大成细一层待填补像素的初值；完好像素保持原值。 */
function upsampleHole(coarse: Level, level: Level): void {
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      const p = y * level.w + x
      if (!level.mask[p]) {
        continue
      }
      const c = (Math.min(coarse.h - 1, y >> 1) * coarse.w + Math.min(coarse.w - 1, x >> 1)) * 3
      level.img[p * 3] = coarse.img[c]
      level.img[p * 3 + 1] = coarse.img[c + 1]
      level.img[p * 3 + 2] = coarse.img[c + 2]
    }
  }
}

/** 平滑补法：金字塔最粗层扩散打底，逐层 EM 细化，最后取最相似小块的中心像素。返回最细层（原分辨率）。 */
function smoothFill(input: InpaintInput, random: () => number, reportProgress: (fraction: number) => void): Level {
  const pyramid: Level[] = [toLevel(input)]
  while (pyramid.length < MAX_LEVELS) {
    const last = pyramid[pyramid.length - 1]
    if (Math.min(last.w, last.h) / 2 < PATCH_SIZE * 3 || holeExtent(last) / 2 < START_HOLE_EXTENT) {
      break
    }
    pyramid.push(downsample(last))
  }
  diffuseFill(pyramid[pyramid.length - 1])

  const totalSteps = pyramid.reduce((sum, _level, index) => sum + emIterations(index, pyramid.length), 0)
  let doneSteps = 0
  let previousField: Field | null = null
  let previousLevel: Level | null = null

  for (let index = pyramid.length - 1; index >= 0; index -= 1) {
    const level = pyramid[index]
    if (previousLevel) {
      upsampleHole(previousLevel, level)
    }
    const { valid, list: sources } = buildValidSources(level)
    const { isTarget, list: targets } = buildTargets(level)
    if (sources.length === 0 || targets.length === 0) {
      // 洞太大、没有完好的小块可借：保留扩散结果。
      if (!previousLevel) {
        diffuseFill(level)
      }
      previousLevel = level
      previousField = null
      doneSteps += emIterations(index, pyramid.length)
      continue
    }
    const field: Field =
      previousField && previousLevel
        ? upsampleField(previousField, previousLevel, level, targets, valid, sources, random)
        : initField(level, targets, sources, random)

    const iterations = emIterations(index, pyramid.length)
    for (let step = 0; step < iterations; step += 1) {
      patchMatch(level, field, targets, isTarget, valid, step === 0 ? 4 : 2, random)
      vote(level, field, targets)
      doneSteps += 1
      reportProgress(doneSteps / totalSteps)
    }
    if (index === 0) {
      patchMatch(level, field, targets, isTarget, valid, 2, random)
      copyCenters(level, field)
    }
    previousLevel = level
    previousField = field
  }
  return pyramid[0]
}

/** 连贯度：洞内每个小块与原图最相似完好小块的平均平方差（每通道）。两种补法用同一套算法与迭代次数。 */
function coherenceEnergy(level: Level, random: () => number): number {
  const { valid, list: sources } = buildValidSources(level)
  const { isTarget, list: targets } = buildTargets(level)
  if (sources.length === 0 || targets.length === 0) {
    return 0
  }
  const field = initField(level, targets, sources, random)
  patchMatch(level, field, targets, isTarget, valid, ENERGY_ITERATIONS, random)
  let sum = 0
  let count = 0
  for (const t of targets) {
    if (level.mask[t]) {
      sum += field.distance[t]
      count += 1
    }
  }
  return count > 0 ? sum / count / (PATCH_SIZE * PATCH_SIZE * 3) : 0
}

function toRgba(input: InpaintInput, level: Level): Uint8ClampedArray {
  const output = new Uint8ClampedArray(input.rgba)
  for (let p = 0; p < input.width * input.height; p += 1) {
    if (level.mask[p]) {
      output[p * 4] = level.img[p * 3]
      output[p * 4 + 1] = level.img[p * 3 + 1]
      output[p * 4 + 2] = level.img[p * 3 + 2]
      output[p * 4 + 3] = 255
    }
  }
  return output
}

/** 按指定补法填补；结构优先在洞里有像素无处可取时返回 null。 */
function runStrategy(
  input: InpaintInput,
  strategy: 'structure' | 'smooth',
  reportProgress: (fraction: number) => void,
): InpaintResult | null {
  const random = createRandom(input.seed ?? 1)
  let level: Level
  if (strategy === 'structure') {
    level = toLevel(input)
    if (!offsetFill(level, random, (fraction) => reportProgress(fraction * 0.9))) {
      return null
    }
  } else {
    level = smoothFill(input, random, (fraction) => reportProgress(fraction * 0.9))
  }
  const energy = coherenceEnergy(level, random)
  reportProgress(1)
  return { rgba: toRgba(input, level), strategy, energy }
}

/**
 * 两种补法各算一遍：best 是更连贯的那个，alternate 是另一个（供界面换用）；
 * 结构优先无法使用（洞里有像素无处可取）时只有平滑优先，alternate 为 null。
 */
export function inpaintBoth(input: InpaintInput): { best: InpaintResult; alternate: InpaintResult | null } {
  const structure = runStrategy(input, 'structure', (fraction) => input.onProgress?.(fraction / 2))
  const smooth = runStrategy(input, 'smooth', (fraction) => input.onProgress?.(0.5 + fraction / 2)) as InpaintResult
  if (!structure) {
    return { best: smooth, alternate: null }
  }
  return structure.energy <= smooth.energy
    ? { best: structure, alternate: smooth }
    : { best: smooth, alternate: structure }
}

/** 填补并返回采用的补法与连贯度；auto 时两种都算取更连贯的。 */
export function inpaintDetailed(input: InpaintInput): InpaintResult {
  const holeCount = input.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
  if (holeCount === 0) {
    return { rgba: new Uint8ClampedArray(input.rgba), strategy: 'smooth', energy: 0 }
  }
  const requested = input.strategy ?? 'auto'
  if (requested === 'auto') {
    return inpaintBoth(input).best
  }
  const progress = (fraction: number): void => input.onProgress?.(fraction)
  return runStrategy(input, requested, progress) ?? (runStrategy(input, 'smooth', progress) as InpaintResult)
}

export function inpaint(input: InpaintInput): Uint8ClampedArray {
  return inpaintDetailed(input).rgba
}

/** 粗层便宜、多迭代；细层贵、少迭代。 */
function emIterations(index: number, levels: number): number {
  if (index === levels - 1) {
    return 8
  }
  return index === 0 ? 3 : 5
}
