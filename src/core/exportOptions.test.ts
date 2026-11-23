import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_OPTIONS,
  findQualityForTarget,
  getOutputSize,
  getSizeChangePercent,
  makeUniqueFileName,
  normalizeExportOptions,
  replaceExtension,
  usesTargetSize,
} from './exportOptions'

describe('normalizeExportOptions', () => {
  it('空值得到默认设置', () => {
    expect(normalizeExportOptions(null)).toEqual(DEFAULT_EXPORT_OPTIONS)
  })

  it('数值限制在范围内并取整', () => {
    const options = normalizeExportOptions({
      quality: 3,
      targetKb: 999_999,
      percent: 120,
      longEdge: 4.6,
    })
    expect(options.quality).toBe(10)
    expect(options.targetKb).toBe(51_200)
    expect(options.percent).toBe(100)
    expect(options.longEdge).toBe(16)
  })

  it('保留合法的枚举值', () => {
    const options = normalizeExportOptions({ format: 'jpeg', compressBy: 'target', resize: 'percent' })
    expect(options).toMatchObject({ format: 'jpeg', compressBy: 'target', resize: 'percent' })
  })
})

describe('getOutputSize', () => {
  it('原尺寸不变', () => {
    expect(getOutputSize(1200, 800, { resize: 'none', percent: 50, longEdge: 100 })).toEqual({
      width: 1200,
      height: 800,
      scale: 1,
    })
  })

  it('按百分比四舍五入，至少 1 像素', () => {
    expect(getOutputSize(1001, 3, { resize: 'percent', percent: 5, longEdge: 0 })).toEqual({
      width: 50,
      height: 1,
      scale: 0.05,
    })
  })

  it('最长边只缩不放', () => {
    expect(getOutputSize(4000, 3000, { resize: 'longEdge', percent: 0, longEdge: 1920 })).toEqual({
      width: 1920,
      height: 1440,
      scale: 0.48,
    })
    expect(getOutputSize(800, 600, { resize: 'longEdge', percent: 0, longEdge: 1920 }).scale).toBe(1)
  })
})

describe('usesTargetSize', () => {
  it('只有有损格式才按目标大小', () => {
    expect(usesTargetSize({ format: 'jpeg', compressBy: 'target' })).toBe(true)
    expect(usesTargetSize({ format: 'png', compressBy: 'target' })).toBe(false)
    expect(usesTargetSize({ format: 'webp', compressBy: 'quality' })).toBe(false)
  })
})

describe('findQualityForTarget', () => {
  // 假编码器：大小随质量线性增长，记录每次调用的质量。
  function fakeEncoder(bytesPerQuality: number) {
    const calls: number[] = []
    const encode = async (quality: number) => {
      calls.push(quality)
      return { size: Math.round(quality * bytesPerQuality) }
    }
    return { calls, encode }
  }

  it('最高质量就满足时只编码一次', async () => {
    const { calls, encode } = fakeEncoder(1000)
    const result = await findQualityForTarget(encode, 2000)
    expect(result).toMatchObject({ quality: 1, fits: true })
    expect(calls).toEqual([1])
  })

  it('二分找到不超过目标的较高质量', async () => {
    const { calls, encode } = fakeEncoder(1000)
    const result = await findQualityForTarget(encode, 500)
    expect(result.fits).toBe(true)
    expect(result.blob.size).toBeLessThanOrEqual(500)
    expect(result.quality).toBeGreaterThanOrEqual(0.45)
    expect(calls.length).toBeLessThanOrEqual(8)
  })

  it('最低质量仍超出时返回最低质量并标记未达标', async () => {
    const { encode } = fakeEncoder(1000)
    const result = await findQualityForTarget(encode, 50)
    expect(result).toMatchObject({ quality: 0.1, fits: false })
  })
})

describe('file names', () => {
  it('换扩展名', () => {
    expect(replaceExtension('照片.final.JPG', 'webp')).toBe('照片.final.webp')
    expect(replaceExtension('无扩展名', 'png')).toBe('无扩展名.png')
    expect(replaceExtension('.hidden', 'png')).toBe('.hidden.png')
  })

  it('同名时按 (2)、(3) 递增，不分大小写', () => {
    const taken = new Set(['a.jpg', 'a (2).jpg'])
    expect(makeUniqueFileName('A.jpg', (name) => taken.has(name.toLowerCase()))).toBe('A (3).jpg')
    expect(makeUniqueFileName('b.jpg', (name) => taken.has(name.toLowerCase()))).toBe('b.jpg')
  })
})

describe('getSizeChangePercent', () => {
  it('计算增减百分比，原大小未知时为 null', () => {
    expect(getSizeChangePercent(1000, 250)).toBe(-75)
    expect(getSizeChangePercent(1000, 1100)).toBe(10)
    expect(getSizeChangePercent(0, 100)).toBeNull()
  })
})
