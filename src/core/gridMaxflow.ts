/**
 * 四邻接网格图上的最大流 / 最小割（Boykov–Kolmogorov 2004 算法）。
 * 「结构优先」修瑕的 α 扩展每换一个候选位移都要切一次图，规模是洞内像素数，
 * BK 在这类网格图上比通用的增广路算法快一个数量级。
 *
 * 用法：addTerminal / addEdge 建图 → maxflow() → isSourceSide(i) 读割的一侧。
 * 方向 d：0 右、1 左、2 下、3 上；d ^ 1 是反方向。
 */

const TERMINAL = 4
const ORPHAN = 5
const NO_PARENT = 6
const FREE = 0
const SOURCE_TREE = 1
const SINK_TREE = 2
const INFINITE_DISTANCE = 0x3fffffff

export class GridMaxflow {
  readonly width: number
  readonly height: number
  /** 节点 i 指向方向 d 的邻居的剩余容量，下标 i * 4 + d */
  private readonly cap: Float64Array
  /** 终端剩余容量：> 0 表示来自源点，< 0 表示流向汇点 */
  private readonly terminal: Float64Array
  /** 第 d 位为 1 表示节点与方向 d 的邻居之间有边 */
  private readonly links: Uint8Array
  private tree: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const size = width * height
    this.cap = new Float64Array(size * 4)
    this.terminal = new Float64Array(size)
    this.links = new Uint8Array(size)
    this.tree = new Uint8Array(size)
  }

  private neighbor(i: number, d: number): number {
    return d === 0 ? i + 1 : d === 1 ? i - 1 : d === 2 ? i + this.width : i - this.width
  }

  /** 节点 i 在割的汇点一侧时付出 source，在源点一侧时付出 sink（两者只有差值有意义）。 */
  addTerminal(i: number, source: number, sink: number): void {
    this.terminal[i] += source - sink
  }

  /** 在 i 与它方向 d 的邻居 j 之间加边：i→j 容量 forward，j→i 容量 backward。调用方保证 j 在网格内。 */
  addEdge(i: number, d: number, forward: number, backward: number): void {
    const j = this.neighbor(i, d)
    this.links[i] |= 1 << d
    this.links[j] |= 1 << (d ^ 1)
    this.cap[i * 4 + d] += forward
    this.cap[j * 4 + (d ^ 1)] += backward
  }

  /** 计算最大流，返回流量；之后用 isSourceSide 读最小割。 */
  maxflow(): number {
    const { cap, terminal, links } = this
    const size = this.width * this.height
    const tree = new Uint8Array(size)
    const parent = new Uint8Array(size).fill(NO_PARENT)
    const stamp = new Int32Array(size)
    const distance = new Int32Array(size)
    const queue = new Int32Array(size + 1)
    const queued = new Uint8Array(size)
    let head = 0
    let tail = 0
    const activate = (i: number): void => {
      if (!queued[i]) {
        queued[i] = 1
        queue[tail] = i
        tail = tail === size ? 0 : tail + 1
      }
    }
    const orphans: number[] = []
    let time = 0
    let flow = 0

    for (let i = 0; i < size; i += 1) {
      if (terminal[i] > 0) {
        tree[i] = SOURCE_TREE
      } else if (terminal[i] < 0) {
        tree[i] = SINK_TREE
      } else {
        continue
      }
      parent[i] = TERMINAL
      distance[i] = 1
      activate(i)
    }

    const augment = (from: number, d: number): void => {
      const to = this.neighbor(from, d)
      let bottleneck = cap[from * 4 + d]
      let x = from
      while (parent[x] !== TERMINAL) {
        const up = parent[x]
        const p = this.neighbor(x, up)
        bottleneck = Math.min(bottleneck, cap[p * 4 + (up ^ 1)])
        x = p
      }
      bottleneck = Math.min(bottleneck, terminal[x])
      x = to
      while (parent[x] !== TERMINAL) {
        const up = parent[x]
        bottleneck = Math.min(bottleneck, cap[x * 4 + up])
        x = this.neighbor(x, up)
      }
      bottleneck = Math.min(bottleneck, -terminal[x])

      cap[from * 4 + d] -= bottleneck
      cap[to * 4 + (d ^ 1)] += bottleneck
      x = from
      while (parent[x] !== TERMINAL) {
        const up = parent[x]
        const p = this.neighbor(x, up)
        const arc = p * 4 + (up ^ 1)
        cap[arc] -= bottleneck
        cap[x * 4 + up] += bottleneck
        if (cap[arc] <= 0) {
          cap[arc] = 0
          parent[x] = ORPHAN
          orphans.push(x)
        }
        x = p
      }
      terminal[x] -= bottleneck
      if (terminal[x] <= 0) {
        terminal[x] = 0
        parent[x] = ORPHAN
        orphans.push(x)
      }
      x = to
      while (parent[x] !== TERMINAL) {
        const up = parent[x]
        const p = this.neighbor(x, up)
        const arc = x * 4 + up
        cap[arc] -= bottleneck
        cap[p * 4 + (up ^ 1)] += bottleneck
        if (cap[arc] <= 0) {
          cap[arc] = 0
          parent[x] = ORPHAN
          orphans.push(x)
        }
        x = p
      }
      terminal[x] += bottleneck
      if (terminal[x] >= 0) {
        terminal[x] = 0
        parent[x] = ORPHAN
        orphans.push(x)
      }
      flow += bottleneck
    }

    /** 孤儿找新父节点：同一棵树里、有剩余容量、且能一路回到终端的邻居，取离终端最近的。 */
    const adopt = (x: number): void => {
      const own = tree[x]
      const fromSource = own === SOURCE_TREE
      let bestDirection = -1
      let bestDistance = INFINITE_DISTANCE
      const l = links[x]
      for (let d = 0; d < 4; d += 1) {
        if (!(l & (1 << d))) {
          continue
        }
        const j = this.neighbor(x, d)
        if (tree[j] !== own) {
          continue
        }
        const residual = fromSource ? cap[j * 4 + (d ^ 1)] : cap[x * 4 + d]
        if (residual <= 0) {
          continue
        }
        let k = j
        let length = 0
        for (;;) {
          if (stamp[k] === time) {
            length += distance[k]
            break
          }
          const up = parent[k]
          length += 1
          if (up === TERMINAL) {
            stamp[k] = time
            distance[k] = 1
            break
          }
          if (up === ORPHAN) {
            length = INFINITE_DISTANCE
            break
          }
          k = this.neighbor(k, up)
        }
        if (length < INFINITE_DISTANCE) {
          if (length < bestDistance) {
            bestDirection = d
            bestDistance = length
          }
          for (k = j; stamp[k] !== time; k = this.neighbor(k, parent[k])) {
            stamp[k] = time
            distance[k] = length
            length -= 1
          }
        }
      }
      if (bestDirection >= 0) {
        parent[x] = bestDirection
        stamp[x] = time
        distance[x] = bestDistance + 1
        return
      }
      for (let d = 0; d < 4; d += 1) {
        if (!(l & (1 << d))) {
          continue
        }
        const j = this.neighbor(x, d)
        if (tree[j] !== own) {
          continue
        }
        const residual = fromSource ? cap[j * 4 + (d ^ 1)] : cap[x * 4 + d]
        if (residual > 0) {
          activate(j)
        }
        const up = parent[j]
        if (up !== TERMINAL && up !== ORPHAN && this.neighbor(j, up) === x) {
          parent[j] = ORPHAN
          orphans.push(j)
        }
      }
      tree[x] = FREE
      parent[x] = NO_PARENT
    }

    let current = -1
    for (;;) {
      let i = current
      if (i >= 0) {
        queued[i] = 0
        if (tree[i] === FREE) {
          i = -1
        }
      }
      while (i < 0 && head !== tail) {
        const k = queue[head]
        head = head === size ? 0 : head + 1
        queued[k] = 0
        if (tree[k] !== FREE) {
          i = k
        }
      }
      if (i < 0) {
        break
      }

      let middleFrom = -1
      let middleDirection = -1
      const l = links[i]
      if (tree[i] === SOURCE_TREE) {
        for (let d = 0; d < 4; d += 1) {
          if (!(l & (1 << d)) || cap[i * 4 + d] <= 0) {
            continue
          }
          const j = this.neighbor(i, d)
          if (tree[j] === FREE) {
            tree[j] = SOURCE_TREE
            parent[j] = d ^ 1
            stamp[j] = stamp[i]
            distance[j] = distance[i] + 1
            activate(j)
          } else if (tree[j] === SINK_TREE) {
            middleFrom = i
            middleDirection = d
            break
          } else if (stamp[j] <= stamp[i] && distance[j] > distance[i]) {
            parent[j] = d ^ 1
            stamp[j] = stamp[i]
            distance[j] = distance[i] + 1
          }
        }
      } else {
        for (let d = 0; d < 4; d += 1) {
          if (!(l & (1 << d))) {
            continue
          }
          const j = this.neighbor(i, d)
          if (cap[j * 4 + (d ^ 1)] <= 0) {
            continue
          }
          if (tree[j] === FREE) {
            tree[j] = SINK_TREE
            parent[j] = d ^ 1
            stamp[j] = stamp[i]
            distance[j] = distance[i] + 1
            activate(j)
          } else if (tree[j] === SOURCE_TREE) {
            middleFrom = j
            middleDirection = d ^ 1
            break
          } else if (stamp[j] <= stamp[i] && distance[j] > distance[i]) {
            parent[j] = d ^ 1
            stamp[j] = stamp[i]
            distance[j] = distance[i] + 1
          }
        }
      }

      time += 1
      if (middleFrom < 0) {
        current = -1
        continue
      }
      // 当前节点保持活跃，下一轮接着从它生长（它此刻不在队列里，标记为已入队以免重复加入）。
      queued[i] = 1
      current = i
      augment(middleFrom, middleDirection)
      for (let k = 0; k < orphans.length; k += 1) {
        adopt(orphans[k])
      }
      orphans.length = 0
    }

    this.tree = tree
    return flow
  }

  /** maxflow 之后：节点在割的源点一侧（自由节点也算源点一侧）。 */
  isSourceSide(i: number): boolean {
    return this.tree[i] !== SINK_TREE
  }
}
