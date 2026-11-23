import { describe, expect, it } from 'vitest'
import {
  allowedResolutions,
  defaultResolution,
  estimateAiSeconds,
  getOutputFactor,
  formatDuration,
  planAiInput,
  planTiles,
  tileToTensor,
  writeTileResult,
} from './aiUpscale'

describe('planAiInput', () => {
  it('保真不缩小，增强缩到一半，大图也不会再暗中缩小', () => {
    expect(planAiInput(800, 600, 'fidelity')).toEqual({ width: 800, height: 600, scale: 1 })
    expect(planAiInput(800, 600, 'enhance')).toEqual({ width: 400, height: 300, scale: 0.5 })
    expect(planAiInput(4000, 9000, 'fidelity')).toMatchObject({ width: 4000, height: 9000 })
  })
})

describe('estimateAiSeconds / formatDuration', () => {
  it('按吞吐量估算并换成说法', () => {
    expect(estimateAiSeconds({ width: 1000, height: 600 }, 10_000)).toBe(60)
    expect(estimateAiSeconds({ width: 10, height: 10 }, 10_000)).toBe(1)
    expect(formatDuration(45)).toBe('约 45 秒')
    expect(formatDuration(150)).toBe('约 3 分钟')
  })
})

describe('planTiles', () => {
  it('各块中间部分恰好铺满整张图、不重叠', () => {
    const width = 500
    const height = 333
    const cover = new Uint8Array(width * height)
    for (const tile of planTiles(width, height, { tileSize: 192, overlap: 16 })) {
      expect(tile.x).toBeGreaterThanOrEqual(0)
      expect(tile.x + tile.width).toBeLessThanOrEqual(width)
      expect(tile.coreX).toBeGreaterThanOrEqual(tile.x)
      expect(tile.coreX + tile.coreWidth).toBeLessThanOrEqual(tile.x + tile.width)
      for (let y = tile.coreY; y < tile.coreY + tile.coreHeight; y += 1) {
        for (let x = tile.coreX; x < tile.coreX + tile.coreWidth; x += 1) {
          cover[y * width + x] += 1
        }
      }
    }
    expect(cover.every((count) => count === 1)).toBe(true)
  })
})

describe('tile tensors', () => {
  it('RGBA 转 NCHW 0–1，结果按块中间部分写回放大图', () => {
    const width = 4
    const height = 2
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let index = 0; index < width * height; index += 1) {
      rgba[index * 4] = 255
      rgba[index * 4 + 1] = index * 10
      rgba[index * 4 + 2] = 0
      rgba[index * 4 + 3] = 255
    }
    const [tile] = planTiles(width, height, { tileSize: 8, overlap: 0 })
    const tensor = tileToTensor(rgba, width, tile)
    const plane = width * height
    expect(tensor[0]).toBe(1)
    expect(tensor[plane + 3]).toBeCloseTo(30 / 255)
    expect(tensor[plane * 2 + 5]).toBe(0)

    // 假模型：把每个像素原样放大 2 倍，超出 0–1 的值要被截断。
    const factor = 2
    const outWidth = width * factor
    const outHeight = height * factor
    const output = new Float32Array(outWidth * outHeight * 3)
    for (let y = 0; y < outHeight; y += 1) {
      for (let x = 0; x < outWidth; x += 1) {
        const source = Math.floor(y / factor) * width + Math.floor(x / factor)
        output[y * outWidth + x] = tensor[source] + 0.5
        output[outWidth * outHeight + y * outWidth + x] = tensor[plane + source]
        output[outWidth * outHeight * 2 + y * outWidth + x] = -1
      }
    }
    const target = new Uint8ClampedArray(outWidth * outHeight * 4)
    writeTileResult(target, outWidth, output, tile, factor)
    const pixel = (3 * outWidth + 7) * 4
    expect(target[pixel]).toBe(255)
    expect(target[pixel + 1]).toBe(70)
    expect(target[pixel + 2]).toBe(0)
    expect(target[pixel + 3]).toBe(255)
  })

  it('输出倍数小于模型倍数时按块取平均，结果只有目标尺寸', () => {
    // 一个 1×1 的块，模型放大 4 倍；只要 1 倍：16 个输出像素取平均。
    const [tile] = planTiles(1, 1, { tileSize: 8, overlap: 0 })
    const output = new Float32Array(16 * 3)
    for (let index = 0; index < 16; index += 1) {
      output[index] = index < 8 ? 1 : 0
      output[16 + index] = 0.5
      output[32 + index] = 2
    }
    const target = new Uint8ClampedArray(4)
    writeTileResult(target, 1, output, tile, 4, 1)
    expect(Array.from(target)).toEqual([128, 128, 255, 255])
  })
})

describe('padding and resolutions', () => {
  it('补到倍数或固定尺寸，补边沿用边缘像素', () => {
    const [tile] = planTiles(10, 6, { tileSize: 64, overlap: 0, multiple: 8 })
    expect(tile).toMatchObject({ width: 10, height: 6, inputWidth: 16, inputHeight: 8 })
    const fixedTiles = planTiles(100, 40, { overlap: 4, fixed: { width: 64, height: 64 } })
    expect(fixedTiles.every((item) => item.inputWidth === 64 && item.inputHeight === 64)).toBe(true)
    expect(fixedTiles[0].coreWidth).toBe(56)
    // 重叠最多取边长的 1/8：64 的块重叠 8，中间部分 48。
    expect(planTiles(200, 200, { overlap: 16, fixed: { width: 64, height: 64 } })[0].coreWidth).toBe(48)

    const rgba = new Uint8ClampedArray(10 * 6 * 4)
    for (let index = 0; index < 60; index += 1) {
      rgba[index * 4] = index
    }
    const tensor = tileToTensor(rgba, 10, tile)
    // 第 0 行第 15 列补在右边，沿用第 0 行最后一个像素（值 9）。
    expect(tensor[15]).toBeCloseTo(9 / 255)
    // 第 7 行补在下面，沿用最后一行（第 5 行）第 0 列（值 50）。
    expect(tensor[7 * 16]).toBeCloseTo(50 / 255)
  })

  it('结果倍数必须是模型倍数的约数，且不超过内存上限', () => {
    expect(getOutputFactor(1, 1, 4)).toBe(1)
    expect(getOutputFactor(2, 0.5, 4)).toBe(4)
    expect(getOutputFactor(4, 0.5, 4)).toBeNull()
    expect(getOutputFactor(1, 1, 3)).toBe(1)
    expect(getOutputFactor(2, 1, 3)).toBeNull()
    expect(allowedResolutions(1000, 1000, 'fidelity', 4)).toEqual([1, 2, 4])
    expect(allowedResolutions(1000, 1000, 'fidelity', 2)).toEqual([1, 2])
    expect(allowedResolutions(1000, 1000, 'enhance', 2)).toEqual([1])
    expect(allowedResolutions(4000, 4000, 'fidelity', 4)).toEqual([1])
    expect(defaultResolution([1, 2, 4])).toBe(2)
    expect(defaultResolution([1])).toBe(1)
  })
})
