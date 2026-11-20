import { GridMaxflow } from './gridMaxflow'
import { buildValidSources, patchDistance, type Level } from './patchUtils'

/**
 * 「结构优先」补法：He & Sun 2012《Statistics of Patch Offsets for Image Completion》。
 *
 * 1. 统计位移：在缩小的图上为每个完好小块找最相似的另一个完好小块（PatchMatch，位移不能太近），
 *    把这些位移画成直方图。栏杆间距、砖缝、窗格这类重复结构会形成很尖的峰，取最高的几十个峰；
 * 2. 拼接：洞里每个像素都从「自己 + 某个峰位移」处原样复制，用图割（α 扩展）为每个像素选位移，
 *    让相邻像素复制出来的内容在接缝处尽量一致——被挡住的栏杆会按自己的间距整段「平移」进洞里，
 *    不会像逐块拼贴那样断成几截；
 * 3. 泊松融合：保留复制内容的纹理（梯度），颜色与洞外平滑衔接，消除光照差造成的接缝。
 *
 * 纯函数，只处理类型数组，在 Web Worker 和单元测试里都能跑。
 */

/** 统计位移时把图缩到约这么多像素以内（位移再回到原分辨率细调）。 */
const STAT_PIXELS = 72_000
const STAT_ITERATIONS = 4
/** 取直方图里最高的这么多个峰作为候选位移。 */
const PEAK_COUNT = 40
const MAX_LABELS = 72
/** 洞外参与选位移的一圈像素宽度：接缝可以落在洞外与复制内容一致的地方。 */
const BAND = 2
/** 来源不可用（出图或落在洞里）时的接缝代价，大于任意两色之差（√(3×255²) ≈ 442）。 */
const INVALID_COST = 600
const FORBIDDEN = 1e9
const MAX_SWEEPS = 3
/** 参与选位移的像素超过这个数，就先在缩小一半的图上选，再回原图只细修接缝附近。 */
const COARSE_VARIABLES = 16_000
/** 原图上细修时，标签边界向外这么多像素以内的都可以重新选。 */
const REFINE_RADIUS = 3
const REFINE_SWEEPS = 2
/** 位移细调时取样的像素数。 */
const REFINE_SAMPLES = 3000
const POISSON_MAX_ITERATIONS = 600
/** 接缝 / 洞边两侧的颜色跳变与复制来源的梯度相差超过这个值（RGB 欧氏距离），就当作真实边缘保留，不做融合。 */
const EDGE_KEEP = 40

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 按 factor × factor 合并：完好像素取平均；块里有洞就整块算洞。 */
function shrink(level: Level, factor: number): Level {
  const w = Math.max(1, Math.floor(level.w / factor))
  const h = Math.max(1, Math.floor(level.h / factor))
  const img = new Float32Array(w * h * 3)
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      let hole = 0
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const si = (y * factor + dy) * level.w + x * factor + dx
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

/** 完好小块之间的最相似位移直方图里，最高的若干个峰（缩小图上的坐标）。 */
function offsetPeaks(stat: Level, random: () => number): Array<[number, number]> {
  const { w, h } = stat
  const { valid, list } = buildValidSources(stat)
  if (list.length < 2) {
    return []
  }
  const minOffset = Math.max(4, Math.round(Math.max(w, h) / 15))
  const minOffset2 = minOffset * minOffset
  const ox = new Int32Array(w * h)
  const oy = new Int32Array(w * h)
  const distance = new Float64Array(w * h).fill(Infinity)
  const usable = (tx: number, ty: number, sx: number, sy: number): boolean =>
    sx >= 0 &&
    sy >= 0 &&
    sx < w &&
    sy < h &&
    valid[sy * w + sx] === 1 &&
    (sx - tx) * (sx - tx) + (sy - ty) * (sy - ty) >= minOffset2

  for (const t of list) {
    const tx = t % w
    const ty = (t - tx) / w
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const s = list[Math.floor(random() * list.length)]
      const sx = s % w
      const sy = (s - sx) / w
      if (usable(tx, ty, sx, sy)) {
        ox[t] = sx - tx
        oy[t] = sy - ty
        distance[t] = patchDistance(stat, tx, ty, sx, sy, Infinity)
        break
      }
    }
  }

  const maxRadius = Math.max(w, h)
  for (let iteration = 0; iteration < STAT_ITERATIONS; iteration += 1) {
    const forward = iteration % 2 === 0
    const step = forward ? 1 : -1
    for (let k = 0; k < list.length; k += 1) {
      const t = list[forward ? k : list.length - 1 - k]
      const tx = t % w
      const ty = (t - tx) / w
      let bestX = ox[t]
      let bestY = oy[t]
      let best = distance[t]
      const tryOffset = (dx: number, dy: number): void => {
        if ((dx === bestX && dy === bestY) || !usable(tx, ty, tx + dx, ty + dy)) {
          return
        }
        const d = patchDistance(stat, tx, ty, tx + dx, ty + dy, best)
        if (d < best) {
          best = d
          bestX = dx
          bestY = dy
        }
      }
      // 传播：相邻小块的位移往往也适合自己（重复结构上整片位移一致）。
      const nx = tx - step
      if (nx >= 0 && nx < w && valid[ty * w + nx] && distance[ty * w + nx] < Infinity) {
        tryOffset(ox[ty * w + nx], oy[ty * w + nx])
      }
      const ny = ty - step
      if (ny >= 0 && ny < h && valid[ny * w + tx] && distance[ny * w + tx] < Infinity) {
        tryOffset(ox[ny * w + tx], oy[ny * w + tx])
      }
      if (best < Infinity) {
        for (let radius = maxRadius; radius >= 1; radius = Math.floor(radius / 2)) {
          tryOffset(
            Math.round(bestX + (random() * 2 - 1) * radius),
            Math.round(bestY + (random() * 2 - 1) * radius),
          )
        }
      }
      ox[t] = bestX
      oy[t] = bestY
      distance[t] = best
    }
  }

  const hw = 2 * w - 1
  const hh = 2 * h - 1
  const histogram = new Float32Array(hw * hh)
  for (const t of list) {
    if (distance[t] < Infinity) {
      histogram[(oy[t] + h - 1) * hw + ox[t] + w - 1] += 1
    }
  }
  // σ = √2 的高斯平滑（可分离 5 点核），让相邻格子的票合到一个峰上。
  const kernel = [Math.exp(-1), Math.exp(-0.25), 1, Math.exp(-0.25), Math.exp(-1)]
  const temp = new Float32Array(hw * hh)
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < hw; x += 1) {
      let sum = 0
      for (let k = -2; k <= 2; k += 1) {
        const xx = x + k
        if (xx >= 0 && xx < hw) {
          sum += kernel[k + 2] * histogram[y * hw + xx]
        }
      }
      temp[y * hw + x] = sum
    }
  }
  const smooth = new Float32Array(hw * hh)
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < hw; x += 1) {
      let sum = 0
      for (let k = -2; k <= 2; k += 1) {
        const yy = y + k
        if (yy >= 0 && yy < hh) {
          sum += kernel[k + 2] * temp[yy * hw + x]
        }
      }
      smooth[y * hw + x] = sum
    }
  }

  const peaks: Array<{ value: number; dx: number; dy: number }> = []
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < hw; x += 1) {
      const i = y * hw + x
      const value = smooth[i]
      if (value < 1) {
        continue
      }
      let isPeak = true
      for (let dy = -2; dy <= 2 && isPeak; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= hh) {
          continue
        }
        for (let dx = -2; dx <= 2; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= hw || (dx === 0 && dy === 0)) {
            continue
          }
          const other = smooth[yy * hw + xx]
          // 相等时只认下标更小的那个，避免平台上出现一串并列的峰。
          if (other > value || (other === value && yy * hw + xx < i)) {
            isPeak = false
            break
          }
        }
      }
      if (isPeak) {
        peaks.push({ value, dx: x - (w - 1), dy: y - (h - 1) })
      }
    }
  }
  peaks.sort((a, b) => b.value - a.value)
  return peaks.slice(0, PEAK_COUNT).map((peak) => [peak.dx, peak.dy])
}

/** 在洞周围取样的完好像素，用来在原分辨率上细调位移。 */
function refineSamples(level: Level, box: Box, random: () => number): Int32Array {
  const { w, h, mask } = level
  const spanX = box.x1 - box.x0 + 1
  const spanY = box.y1 - box.y0 + 1
  const x0 = Math.max(0, box.x0 - spanX)
  const x1 = Math.min(w - 1, box.x1 + spanX)
  const y0 = Math.max(0, box.y0 - spanY)
  const y1 = Math.min(h - 1, box.y1 + spanY)
  const samples: number[] = []
  for (let attempt = 0; attempt < REFINE_SAMPLES * 4 && samples.length < REFINE_SAMPLES; attempt += 1) {
    const x = x0 + Math.floor(random() * (x1 - x0 + 1))
    const y = y0 + Math.floor(random() * (y1 - y0 + 1))
    if (!mask[y * w + x]) {
      samples.push(y * w + x)
    }
  }
  return Int32Array.from(samples)
}

/** 缩小图上的位移放大后有 ±(factor-1) 像素的误差，在原图上逐个试，取差异最小的。 */
function refineOffset(
  level: Level,
  dx: number,
  dy: number,
  radius: number,
  samples: Int32Array,
): [number, number] {
  const { w, h, img, mask } = level
  let best: [number, number] = [dx, dy]
  let bestCost = Infinity
  for (let ry = -radius; ry <= radius; ry += 1) {
    for (let rx = -radius; rx <= radius; rx += 1) {
      const cx = dx + rx
      const cy = dy + ry
      let sum = 0
      let count = 0
      for (const p of samples) {
        const x = p % w
        const y = (p - x) / w
        const sx = x + cx
        const sy = y + cy
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
          continue
        }
        const s = sy * w + sx
        if (mask[s]) {
          continue
        }
        const dr = img[p * 3] - img[s * 3]
        const dg = img[p * 3 + 1] - img[s * 3 + 1]
        const db = img[p * 3 + 2] - img[s * 3 + 2]
        sum += dr * dr + dg * dg + db * db
        count += 1
      }
      if (count >= samples.length * 0.3 && sum / count < bestCost) {
        bestCost = sum / count
        best = [cx, cy]
      }
    }
  }
  return best
}

/**
 * 候选位移：直方图的峰（细调到原分辨率），加上最强几个峰的倍数与组合（大洞中心要跳得更远才能取到完好像素），
 * 再加上「水平 / 垂直跳出洞的外接框」四个兜底位移，保证洞里每个像素至少有一个可用来源。
 */
function collectOffsets(level: Level, box: Box, random: () => number): Array<[number, number]> {
  const factor = Math.max(1, Math.ceil(Math.sqrt((level.w * level.h) / STAT_PIXELS)))
  const stat = factor === 1 ? level : shrink(level, factor)
  const peaks = offsetPeaks(stat, random)
  const samples = factor > 1 ? refineSamples(level, box, random) : null
  const refined = peaks.map(([dx, dy]): [number, number] =>
    samples ? refineOffset(level, dx * factor, dy * factor, factor - 1, samples) : [dx, dy],
  )

  const result = new Map<string, [number, number]>()
  const add = (dx: number, dy: number): void => {
    if ((dx !== 0 || dy !== 0) && result.size < MAX_LABELS) {
      const key = `${dx},${dy}`
      if (!result.has(key)) {
        result.set(key, [dx, dy])
      }
    }
  }
  const escapeX = box.x1 - box.x0 + 2
  const escapeY = box.y1 - box.y0 + 2
  add(escapeX, 0)
  add(-escapeX, 0)
  add(0, escapeY)
  add(0, -escapeY)
  for (const [dx, dy] of refined) {
    add(dx, dy)
  }
  const top = refined.slice(0, 4)
  for (const [dx, dy] of top) {
    add(-dx, -dy)
    add(dx * 2, dy * 2)
    add(dx * 3, dy * 3)
  }
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      add(top[i][0] + top[j][0], top[i][1] + top[j][1])
      add(top[i][0] - top[j][0], top[i][1] - top[j][1])
    }
  }
  return [...result.values()]
}

interface LabelCosts {
  /** 像素 (x, y) 用标签 label 时复制来源的下标；出图或落在洞里为 -1 */
  source: (x: number, y: number, label: number) => number
  /** 像素 (x, y) 分别用标签 a、b 时两个来源的颜色差 */
  colorDistance: (x: number, y: number, a: number, b: number) => number
  /** 单点代价：洞内像素来源可用即 0；洞外一圈是复制来的颜色与原色之差 */
  unary: (x: number, y: number, label: number) => number
}

function labelCosts(level: Level, ox: Int32Array, oy: Int32Array): LabelCosts {
  const { w, h, img, mask } = level
  const source = (x: number, y: number, label: number): number => {
    const sx = x + ox[label]
    const sy = y + oy[label]
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
      return -1
    }
    const s = sy * w + sx
    return mask[s] ? -1 : s
  }
  const colorDistance = (x: number, y: number, a: number, b: number): number => {
    if (a === b) {
      return 0
    }
    const sa = source(x, y, a)
    const sb = source(x, y, b)
    if (sa < 0 || sb < 0) {
      return INVALID_COST
    }
    const dr = img[sa * 3] - img[sb * 3]
    const dg = img[sa * 3 + 1] - img[sb * 3 + 1]
    const db = img[sa * 3 + 2] - img[sb * 3 + 2]
    return Math.sqrt(dr * dr + dg * dg + db * db)
  }
  const unary = (x: number, y: number, label: number): number => {
    if (source(x, y, label) < 0) {
      return FORBIDDEN
    }
    return mask[y * w + x] ? 0 : colorDistance(x, y, label, 0)
  }
  return { source, colorDistance, unary }
}

/** 参与选位移的像素：洞，加上洞外 BAND 像素宽的一圈（接缝可以落在那里）。 */
function findVariables(level: Level): { isVariable: Uint8Array; variables: Int32Array } {
  const { w, h, mask } = level
  const isVariable = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) {
        continue
      }
      for (let yy = Math.max(0, y - BAND); yy <= Math.min(h - 1, y + BAND); yy += 1) {
        for (let xx = Math.max(0, x - BAND); xx <= Math.min(w - 1, x + BAND); xx += 1) {
          isVariable[yy * w + xx] = 1
        }
      }
    }
  }
  const list: number[] = []
  for (let p = 0; p < w * h; p += 1) {
    if (isVariable[p]) {
      list.push(p)
    }
  }
  return { isVariable, variables: Int32Array.from(list) }
}

/** 洞内像素取「最短的可用位移」作初值，洞外一圈不动；有洞内像素无处可取时返回 false。 */
function initialLabels(level: Level, costs: LabelCosts, labelCount: number, ox: Int32Array, oy: Int32Array, labels: Uint8Array, pixels: Iterable<number>): boolean {
  const { w, mask } = level
  for (const p of pixels) {
    if (!mask[p]) {
      labels[p] = 0
      continue
    }
    const x = p % w
    const y = (p - x) / w
    let chosen = -1
    let chosenLength = Infinity
    for (let label = 1; label < labelCount; label += 1) {
      if (costs.source(x, y, label) < 0) {
        continue
      }
      const length = ox[label] * ox[label] + oy[label] * oy[label]
      if (length < chosenLength) {
        chosen = label
        chosenLength = length
      }
    }
    if (chosen < 0) {
      return false
    }
    labels[p] = chosen
  }
  return true
}

/**
 * α 扩展（Boykov 2001）：依次对每个候选标签 α 切一次图，让 candidates 里的像素在「保持」与「换成 α」之间选，
 * 使「单点代价 + 相邻像素接缝代价」最小；不在 candidates 里的像素按现有标签固定。
 */
function expandLabels(
  level: Level,
  costs: LabelCosts,
  labels: Uint8Array,
  isVariable: Uint8Array,
  candidates: Int32Array,
  alphas: number[],
  sweeps: number,
  reportProgress: (fraction: number) => void,
): void {
  const { w, h } = level
  const { source, colorDistance, unary } = costs
  const movable = new Uint8Array(w * h)
  const nodeX: number[] = []
  const nodeY: number[] = []
  const totalMoves = sweeps * alphas.length
  let moves = 0
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    let changed = 0
    for (const alpha of alphas) {
      moves += 1
      nodeX.length = 0
      nodeY.length = 0
      let x0 = w
      let y0 = h
      let x1 = -1
      let y1 = -1
      for (const p of candidates) {
        const x = p % w
        const y = (p - x) / w
        if (labels[p] === alpha || source(x, y, alpha) < 0) {
          continue
        }
        movable[p] = 1
        nodeX.push(x)
        nodeY.push(y)
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      if (nodeX.length === 0) {
        continue
      }
      const gw = x1 - x0 + 1
      const graph = new GridMaxflow(gw, y1 - y0 + 1)
      for (let k = 0; k < nodeX.length; k += 1) {
        const x = nodeX[k]
        const y = nodeY[k]
        const p = y * w + x
        const node = (y - y0) * gw + (x - x0)
        const current = labels[p]
        graph.addTerminal(node, unary(x, y, alpha), unary(x, y, current))
        for (let d = 0; d < 4; d += 1) {
          const qx = d === 0 ? x + 1 : d === 1 ? x - 1 : x
          const qy = d === 2 ? y + 1 : d === 3 ? y - 1 : y
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) {
            continue
          }
          const q = qy * w + qx
          const other = isVariable[q] ? labels[q] : 0
          if (movable[q]) {
            if (d === 1 || d === 3) {
              continue
            }
            // E(保持, 保持) = A，E(保持, 换) = B，E(换, 保持) = C，E(换, 换) = 0。
            const a = colorDistance(x, y, current, other) + colorDistance(qx, qy, current, other)
            const b = colorDistance(x, y, current, alpha) + colorDistance(qx, qy, current, alpha)
            const c = colorDistance(x, y, alpha, other) + colorDistance(qx, qy, alpha, other)
            const nodeQ = (qy - y0) * gw + (qx - x0)
            graph.addTerminal(node, c - a, 0)
            graph.addTerminal(nodeQ, 0, c)
            graph.addEdge(node, d, Math.max(0, b + c - a), 0)
          } else {
            const keep = colorDistance(x, y, current, other) + colorDistance(qx, qy, current, other)
            const swap = colorDistance(x, y, alpha, other) + colorDistance(qx, qy, alpha, other)
            graph.addTerminal(node, swap, keep)
          }
        }
      }
      graph.maxflow()
      for (let k = 0; k < nodeX.length; k += 1) {
        const x = nodeX[k]
        const y = nodeY[k]
        const p = y * w + x
        movable[p] = 0
        if (!graph.isSourceSide((y - y0) * gw + (x - x0))) {
          labels[p] = alpha
          changed += 1
        }
      }
      reportProgress(moves / totalMoves)
    }
    if (changed === 0) {
      break
    }
  }
  reportProgress(1)
}

interface LabelSolution {
  labels: Uint8Array
  isVariable: Uint8Array
  variables: Int32Array
}

/**
 * 为洞（及洞外一圈）里的每个像素选一个位移，标签 0 = 不动（只有洞外像素能用）。
 * 像素多时先在缩小一半的图上解（递归），放大后只在标签边界附近重新选，省下大部分切图时间。
 * 有洞内像素找不到任何可用来源时返回 null。
 */
function solveLabels(
  level: Level,
  ox: Int32Array,
  oy: Int32Array,
  reportProgress: (fraction: number) => void,
): LabelSolution | null {
  const { w, h } = level
  const labelCount = ox.length
  const costs = labelCosts(level, ox, oy)
  const { isVariable, variables } = findVariables(level)
  const labels = new Uint8Array(w * h)
  const allLabels = Array.from({ length: labelCount }, (_, label) => label)

  if (variables.length > COARSE_VARIABLES && Math.min(w, h) >= 64) {
    const coarse = shrink(level, 2)
    const coarseSolution = solveLabels(
      coarse,
      ox.map((value) => Math.round(value / 2)),
      oy.map((value) => Math.round(value / 2)),
      (fraction) => reportProgress(fraction * 0.7),
    )
    if (coarseSolution) {
      const invalid: number[] = []
      for (const p of variables) {
        const x = p % w
        const y = (p - x) / w
        const c = Math.min(coarse.h - 1, y >> 1) * coarse.w + Math.min(coarse.w - 1, x >> 1)
        labels[p] = coarseSolution.labels[c]
        if (costs.source(x, y, labels[p]) < 0) {
          invalid.push(p)
        }
      }
      if (!initialLabels(level, costs, labelCount, ox, oy, labels, invalid)) {
        return null
      }
      // 只在标签边界附近（以及刚补过初值的像素）重新选；其余像素沿用粗层的结果。
      const near = new Uint8Array(w * h)
      for (const p of invalid) {
        near[p] = 1
      }
      for (const p of variables) {
        const x = p % w
        const y = (p - x) / w
        let boundary = false
        for (let d = 0; d < 4 && !boundary; d += 1) {
          const qx = d === 0 ? x + 1 : d === 1 ? x - 1 : x
          const qy = d === 2 ? y + 1 : d === 3 ? y - 1 : y
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) {
            continue
          }
          const q = qy * w + qx
          boundary = (isVariable[q] ? labels[q] : 0) !== labels[p]
        }
        if (!boundary) {
          continue
        }
        for (let yy = Math.max(0, y - REFINE_RADIUS); yy <= Math.min(h - 1, y + REFINE_RADIUS); yy += 1) {
          for (let xx = Math.max(0, x - REFINE_RADIUS); xx <= Math.min(w - 1, x + REFINE_RADIUS); xx += 1) {
            near[yy * w + xx] = 1
          }
        }
      }
      const candidates: number[] = []
      const nearby = new Set<number>()
      for (const p of variables) {
        if (near[p]) {
          candidates.push(p)
          nearby.add(labels[p])
        }
      }
      expandLabels(
        level,
        costs,
        labels,
        isVariable,
        Int32Array.from(candidates),
        allLabels.filter((label) => nearby.has(label)),
        REFINE_SWEEPS,
        (fraction) => reportProgress(0.7 + fraction * 0.3),
      )
      return { labels, isVariable, variables }
    }
  }

  if (!initialLabels(level, costs, labelCount, ox, oy, labels, variables)) {
    return null
  }
  expandLabels(level, costs, labels, isVariable, variables, allLabels, MAX_SWEEPS, reportProgress)
  return { labels, isVariable, variables }
}

/**
 * 泊松融合：未知量是所有「换了来源」的像素，梯度取自复制来源（接缝处取两侧来源的平均），
 * 边界取洞外原图。用共轭梯度解，初值就是直接复制的结果。
 */
function poissonBlend(
  level: Level,
  ox: Int32Array,
  oy: Int32Array,
  labels: Uint8Array,
  isVariable: Uint8Array,
  variables: Int32Array,
): void {
  const { w, h, img, mask } = level
  const index = new Int32Array(w * h).fill(-1)
  const unknowns: number[] = []
  for (const p of variables) {
    if (labels[p] !== 0) {
      index[p] = unknowns.length
      unknowns.push(p)
    }
  }
  const n = unknowns.length
  if (n === 0) {
    return
  }
  const source = (x: number, y: number, label: number): number => {
    const sx = x + ox[label]
    const sy = y + oy[label]
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
      return -1
    }
    const s = sy * w + sx
    return mask[s] ? -1 : s
  }

  const degree = new Float64Array(n)
  const neighbors = new Int32Array(n * 4).fill(-1)
  const rhs = new Float64Array(n * 3)
  const value = new Float64Array(n * 3)
  for (let k = 0; k < n; k += 1) {
    const p = unknowns[k]
    const x = p % w
    const y = (p - x) / w
    const a = labels[p]
    const sa = source(x, y, a)
    for (let c = 0; c < 3; c += 1) {
      value[k * 3 + c] = img[sa * 3 + c]
    }
  }
  for (let k = 0; k < n; k += 1) {
    const p = unknowns[k]
    const x = p % w
    const y = (p - x) / w
    const a = labels[p]
    for (let d = 0; d < 4; d += 1) {
      const qx = d === 0 ? x + 1 : d === 1 ? x - 1 : x
      const qy = d === 2 ? y + 1 : d === 3 ? y - 1 : y
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) {
        continue
      }
      const q = qy * w + qx
      const b = isVariable[q] ? labels[q] : 0
      degree[k] += 1
      // 引导梯度 g = f(p) - f(q)：两侧来源里，p、q 两点都能取到颜色的取平均。
      let gr = 0
      let gg = 0
      let gb = 0
      let count = 0
      for (const label of a === b ? [a] : [a, b]) {
        const sp = source(x, y, label)
        const sq = source(qx, qy, label)
        if (sp < 0 || sq < 0) {
          continue
        }
        gr += img[sp * 3] - img[sq * 3]
        gg += img[sp * 3 + 1] - img[sq * 3 + 1]
        gb += img[sp * 3 + 2] - img[sq * 3 + 2]
        count += 1
      }
      if (count > 0) {
        gr /= count
        gg /= count
        gb /= count
      }
      // 直接复制结果在这两点间的跳变；与来源梯度相差太大（花瓣边贴着天空这类）就保留跳变，免得颜色被抹开。
      const m = index[q]
      const cr = value[k * 3] - (m >= 0 ? value[m * 3] : img[q * 3])
      const cg = value[k * 3 + 1] - (m >= 0 ? value[m * 3 + 1] : img[q * 3 + 1])
      const cb = value[k * 3 + 2] - (m >= 0 ? value[m * 3 + 2] : img[q * 3 + 2])
      if (Math.hypot(cr - gr, cg - gg, cb - gb) > EDGE_KEEP) {
        gr = cr
        gg = cg
        gb = cb
      }
      rhs[k * 3] += gr
      rhs[k * 3 + 1] += gg
      rhs[k * 3 + 2] += gb
      if (m >= 0) {
        neighbors[k * 4 + d] = index[q]
      } else {
        rhs[k * 3] += img[q * 3]
        rhs[k * 3 + 1] += img[q * 3 + 1]
        rhs[k * 3 + 2] += img[q * 3 + 2]
      }
    }
  }

  const residual = new Float64Array(n)
  const direction = new Float64Array(n)
  const product = new Float64Array(n)
  const multiply = (input: Float64Array, output: Float64Array): void => {
    for (let k = 0; k < n; k += 1) {
      let sum = degree[k] * input[k]
      for (let d = 0; d < 4; d += 1) {
        const m = neighbors[k * 4 + d]
        if (m >= 0) {
          sum -= input[m]
        }
      }
      output[k] = sum
    }
  }
  const x = new Float64Array(n)
  const tolerance = 0.05 * Math.sqrt(n)
  for (let c = 0; c < 3; c += 1) {
    for (let k = 0; k < n; k += 1) {
      x[k] = value[k * 3 + c]
    }
    multiply(x, product)
    let rs = 0
    for (let k = 0; k < n; k += 1) {
      residual[k] = rhs[k * 3 + c] - product[k]
      direction[k] = residual[k]
      rs += residual[k] * residual[k]
    }
    for (let iteration = 0; iteration < POISSON_MAX_ITERATIONS && Math.sqrt(rs) > tolerance; iteration += 1) {
      multiply(direction, product)
      let pAp = 0
      for (let k = 0; k < n; k += 1) {
        pAp += direction[k] * product[k]
      }
      if (pAp <= 0) {
        break
      }
      const step = rs / pAp
      let next = 0
      for (let k = 0; k < n; k += 1) {
        x[k] += step * direction[k]
        residual[k] -= step * product[k]
        next += residual[k] * residual[k]
      }
      const beta = next / rs
      rs = next
      for (let k = 0; k < n; k += 1) {
        direction[k] = residual[k] + beta * direction[k]
      }
    }
    for (let k = 0; k < n; k += 1) {
      value[k * 3 + c] = x[k]
    }
  }

  // 只写回洞内像素；洞外那一圈只用来放接缝，原图保持不变。
  for (let k = 0; k < n; k += 1) {
    const p = unknowns[k]
    if (!mask[p]) {
      continue
    }
    for (let c = 0; c < 3; c += 1) {
      img[p * 3 + c] = Math.min(255, Math.max(0, value[k * 3 + c]))
    }
  }
}

/** 用位移拼接 + 泊松融合补洞，结果写回 level.img；洞里有像素无处可取时返回 false（调用方改用平滑补法）。 */
export function offsetFill(level: Level, random: () => number, onProgress?: (fraction: number) => void): boolean {
  const { w, h, mask } = level
  const box: Box = { x0: w, y0: h, x1: -1, y1: -1 }
  for (let p = 0; p < w * h; p += 1) {
    if (mask[p]) {
      const x = p % w
      const y = (p - x) / w
      box.x0 = Math.min(box.x0, x)
      box.y0 = Math.min(box.y0, y)
      box.x1 = Math.max(box.x1, x)
      box.y1 = Math.max(box.y1, y)
    }
  }
  if (box.x1 < 0) {
    onProgress?.(1)
    return true
  }

  const offsets = collectOffsets(level, box, random)
  onProgress?.(0.2)
  const ox = Int32Array.from([0, ...offsets.map((offset) => offset[0])])
  const oy = Int32Array.from([0, ...offsets.map((offset) => offset[1])])

  const solution = solveLabels(level, ox, oy, (fraction) => onProgress?.(0.2 + fraction * 0.7))
  if (!solution) {
    return false
  }
  poissonBlend(level, ox, oy, solution.labels, solution.isVariable, solution.variables)
  onProgress?.(1)
  return true
}
