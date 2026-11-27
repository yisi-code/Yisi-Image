import { describe, expect, it } from 'vitest'
import {
  IMAGENET_NORMALIZATION,
  combineMatte,
  foregroundContrast,
  isOpaqueMatte,
  logitsToAlpha,
  matteProbeImage,
  outputToAlpha,
  pickMaskLevels,
  rgbaToChw,
  samEncoderInput,
  samInputSize,
  samPointTensors,
} from './matte'

describe('matte inputs', () => {
  it('normalizes RGBA into CHW planes', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255])
    const chw = rgbaToChw(rgba, 2, 1, IMAGENET_NORMALIZATION)
    expect(chw).toHaveLength(6)
    expect(chw[0]).toBeCloseTo((1 - 0.485) / 0.229)
    expect(chw[1]).toBeCloseTo((0 - 0.485) / 0.229)
    expect(chw[3]).toBeCloseTo((1 - 0.456) / 0.224)
  })

  it('scales the long side to 1024 for SAM', () => {
    expect(samInputSize(800, 600)).toEqual({ width: 1024, height: 768, scale: 1.28 })
    expect(samInputSize(300, 3000).height).toBe(1024)
  })

  it('builds HWC 0–255 and padded CHW encoder inputs', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255])
    expect(Array.from(samEncoderInput(rgba, 1, 1, 'hwc'))).toEqual([10, 20, 30])
    const chw = samEncoderInput(rgba, 1, 1, 'chw')
    expect(chw).toHaveLength(1024 * 1024 * 3)
    expect(chw[0]).toBeCloseTo((10 - 123.675) / 58.395)
    expect(chw[1]).toBe(0)
  })

  it('appends the padding point SAM expects', () => {
    const { coords, labels } = samPointTensors([
      { x: 5, y: 6, positive: true },
      { x: 7, y: 8, positive: false },
    ])
    expect(Array.from(coords)).toEqual([5, 6, 7, 8, 0, 0])
    expect(Array.from(labels)).toEqual([1, 0, -1])
  })
})

describe('matte outputs', () => {
  it('stretches probabilities and applies sigmoid to logits', () => {
    expect(Array.from(outputToAlpha([0.1, 0.5, 0.9]))).toEqual([0, 128, 255])
    const logits = outputToAlpha([-8, 0, 8])
    expect(logits[0]).toBe(0)
    expect(logits[2]).toBe(255)
  })

  it('does not amplify a flat output into a foreground', () => {
    expect(Array.from(outputToAlpha([0.01, 0.02, 0.03]))).toEqual([3, 5, 8])
  })

  it('measures how well the probe object was separated', () => {
    const { inside } = matteProbeImage(32)
    const perfect = Array.from(inside, (value) => value * 255)
    expect(foregroundContrast(perfect, inside)).toBe(1)
    expect(foregroundContrast(new Array(inside.length).fill(128), inside)).toBe(0)
  })

  it('orders mask levels by area and drops duplicates', () => {
    // 多掩码导出：第 0 张是单掩码输出，不参与
    expect(pickMaskLevels([500, 6300, 101000, 101100])).toEqual([1, 2])
    expect(pickMaskLevels([300, 100, 200])).toEqual([1, 2, 0])
    expect(pickMaskLevels([0, 0, 0, 0])).toEqual([3])
  })

  it('turns SAM logits into alpha with a narrow soft edge', () => {
    expect(Array.from(logitsToAlpha([0, -10, 10, 0], 1, 2))).toEqual([0, 255])
    // 略小于 0 的大片区域不再留下半透明残影
    expect(Array.from(logitsToAlpha([-1, -0.5, 0, 0.25, 1], 0, 5))).toEqual([0, 0, 128, 191, 255])
  })

  it('keeps or removes a selection on top of an existing matte', () => {
    const current = [255, 255, 0, 128]
    const selection = [255, 0, 255, 255]
    expect(Array.from(combineMatte(current, selection, 'keep'))).toEqual([255, 0, 0, 128])
    expect(Array.from(combineMatte(current, selection, 'remove'))).toEqual([0, 255, 0, 0])
    expect(Array.from(combineMatte(null, selection, 'keep'))).toEqual([255, 0, 255, 255])
    expect(isOpaqueMatte([255, 252])).toBe(true)
    expect(isOpaqueMatte([255, 10])).toBe(false)
  })
})
