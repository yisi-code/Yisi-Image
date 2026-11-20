import { describe, expect, it } from 'vitest'
import { GridMaxflow } from './gridMaxflow'

function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

interface Instance {
  width: number
  height: number
  terminals: number[]
  /** [节点, 方向(0 右 / 2 下), 正向容量, 反向容量] */
  edges: Array<[number, number, number, number]>
}

function randomInstance(width: number, height: number, random: () => number): Instance {
  const terminals = Array.from({ length: width * height }, () => Math.round((random() * 2 - 1) * 10))
  const edges: Instance['edges'] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      if (x + 1 < width) {
        edges.push([i, 0, Math.round(random() * 8), Math.round(random() * 8)])
      }
      if (y + 1 < height) {
        edges.push([i, 2, Math.round(random() * 8), Math.round(random() * 8)])
      }
    }
  }
  return { width, height, terminals, edges }
}

/** 割的代价：在汇点一侧的节点付出源点容量，在源点一侧的付出汇点容量，再加上从源点侧指向汇点侧的边。 */
function cutCost(instance: Instance, sinkSide: (i: number) => boolean): number {
  let cost = 0
  instance.terminals.forEach((t, i) => {
    cost += sinkSide(i) ? Math.max(t, 0) : Math.max(-t, 0)
  })
  for (const [i, d, forward, backward] of instance.edges) {
    const j = d === 0 ? i + 1 : i + instance.width
    if (!sinkSide(i) && sinkSide(j)) {
      cost += forward
    }
    if (sinkSide(i) && !sinkSide(j)) {
      cost += backward
    }
  }
  return cost
}

describe('GridMaxflow', () => {
  it('最大流等于穷举得到的最小割，返回的分割就是一个最小割', () => {
    const random = createRandom(42)
    for (let round = 0; round < 60; round += 1) {
      const width = 2 + Math.floor(random() * 3)
      const height = 2 + Math.floor(random() * 2)
      const instance = randomInstance(width, height, random)
      const graph = new GridMaxflow(width, height)
      instance.terminals.forEach((t, i) => graph.addTerminal(i, Math.max(t, 0), Math.max(-t, 0)))
      for (const [i, d, forward, backward] of instance.edges) {
        graph.addEdge(i, d, forward, backward)
      }
      const flow = graph.maxflow()

      const n = width * height
      let best = Infinity
      for (let mask = 0; mask < 1 << n; mask += 1) {
        best = Math.min(best, cutCost(instance, (i) => Boolean(mask & (1 << i))))
      }
      expect(flow).toBeCloseTo(best, 9)
      expect(cutCost(instance, (i) => !graph.isSourceSide(i))).toBeCloseTo(best, 9)
    }
  })
})
