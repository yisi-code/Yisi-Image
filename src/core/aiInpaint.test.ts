import { describe, expect, it } from 'vitest'
import {
  LAMA_CONTEXT,
  LAMA_SIZE,
  detectOutputRange,
  encodeInpaintImage,
  encodeInpaintMask,
  holeChange,
  inpaintProbeImage,
  lamaCrop,
  lamaFeeds,
  lamaResult,
  miganFeeds,
  miganResult,
  outputToByte,
} from './aiInpaint'

function gradient(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = p % 251
    rgba[p * 4 + 1] = (p * 3) % 253
    rgba[p * 4 + 2] = (p * 7) % 255
    rgba[p * 4 + 3] = 255
  }
  return rgba
}

function rectMask(width: number, height: number, x0: number, y0: number, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      mask[y * width + x] = 1
    }
  }
  return mask
}

describe('MI-GAN 输入输出', () => {
  const width = 6
  const height = 4
  const rgba = gradient(width, height)
  const mask = rectMask(width, height, 2, 1, 2, 2)

  it('图像按 RGB 平面排列，遮罩 255 = 保留、0 = 要补', () => {
    const feeds = miganFeeds(width, height, rgba, mask)
    const size = width * height
    expect(feeds.image[7]).toBe(rgba[7 * 4])
    expect(feeds.image[size + 7]).toBe(rgba[7 * 4 + 1])
    expect(feeds.image[size * 2 + 7]).toBe(rgba[7 * 4 + 2])
    expect(feeds.mask[0]).toBe(255)
    expect(feeds.mask[1 * width + 2]).toBe(0)
  })

  it('结果只替换洞内像素', () => {
    const output = new Uint8Array(width * height * 3).fill(9)
    const result = miganResult(output, width, height, rgba, mask)
    for (let p = 0; p < width * height; p += 1) {
      if (mask[p]) {
        expect(result[p * 4]).toBe(9)
        expect(result[p * 4 + 3]).toBe(255)
      } else {
        expect(result[p * 4]).toBe(rgba[p * 4])
      }
    }
  })
})

describe('LaMa 裁剪与换算', () => {
  it('小洞：取以洞为中心、边长 512 的方形，超出时平移进图内', () => {
    const mask = rectMask(900, 700, 20, 650, 30, 30)
    const crop = lamaCrop(900, 700, mask)
    expect(crop).toEqual({ x: 0, y: 700 - 512, width: 512, height: 512 })
  })

  it('大洞：边长 = 洞的长边 + 两侧上下文；图不够大时取整张图', () => {
    const big = rectMask(1200, 1000, 300, 300, 400, 300)
    expect(lamaCrop(1200, 1000, big)).toEqual({
      x: 300 + 200 - (400 + LAMA_CONTEXT * 2) / 2,
      y: Math.round(300 + 150 - (400 + LAMA_CONTEXT * 2) / 2),
      width: 400 + LAMA_CONTEXT * 2,
      height: 400 + LAMA_CONTEXT * 2,
    })
    const small = rectMask(300, 200, 100, 50, 40, 40)
    expect(lamaCrop(300, 200, small)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
    expect(lamaCrop(300, 200, new Uint8Array(300 * 200))).toBeNull()
  })

  it('缩小时细笔画也不会从遮罩里丢掉', () => {
    const width = 1024
    const height = 1024
    const mask = new Uint8Array(width * height)
    // 一像素宽的竖线：缩到一半时按「覆盖的原像素有没有洞」取，仍然保留。
    for (let y = 300; y < 700; y += 1) {
      mask[y * width + 501] = 1
    }
    const crop = { x: 0, y: 0, width, height }
    const feeds = lamaFeeds(width, gradient(width, height), mask, crop)
    expect(feeds.image.length).toBe(3 * LAMA_SIZE * LAMA_SIZE)
    expect(feeds.mask[250 * LAMA_SIZE + 250]).toBe(1)
    expect(feeds.mask[250 * LAMA_SIZE + 252]).toBe(0)
    expect(Math.max(...feeds.image.slice(0, 2000))).toBeLessThanOrEqual(1)
  })

  it('结果放回裁剪区域，只替换洞内像素', () => {
    const width = 600
    const height = 520
    const rgba = gradient(width, height)
    const mask = rectMask(width, height, 280, 240, 20, 20)
    const crop = lamaCrop(width, height, mask)
    expect(crop).not.toBeNull()
    const output = new Float32Array(3 * LAMA_SIZE * LAMA_SIZE).fill(77)
    const result = lamaResult(output, width, height, rgba, mask, crop!)
    expect(result[(250 * width + 290) * 4]).toBe(77)
    expect(result[(10 * width + 10) * 4]).toBe(rgba[(10 * width + 10) * 4])
    expect(result[(240 * width + 279) * 4]).toBe(rgba[(240 * width + 279) * 4])
  })
})

describe('自定义修瑕模型的换算与试算', () => {
  it('其他边长按比例留上下文：256 边长留 64', () => {
    const width = 1000
    const height = 1000
    const mask = new Uint8Array(width * height)
    for (let y = 400; y < 600; y += 1) {
      for (let x = 450; x < 550; x += 1) {
        mask[y * width + x] = 1
      }
    }
    // 洞长边 200 + 两侧各 64 = 328 > 256
    expect(lamaCrop(width, height, mask, 256)).toEqual({ x: 336, y: 336, width: 328, height: 328 })
  })

  it('uint8 图像乘 255；遮罩按约定取 1 / 255 或反过来', () => {
    expect(Array.from(encodeInpaintImage(new Float32Array([0, 0.5, 1]), 'uint8'))).toEqual([0, 128, 255])
    const hole = new Float32Array([1, 0])
    expect(Array.from(encodeInpaintMask(hole, 'float32', true))).toEqual([1, 0])
    expect(Array.from(encodeInpaintMask(hole, 'uint8', false))).toEqual([0, 255])
  })

  it('按输出值判断取值范围并换成 0–255', () => {
    expect(detectOutputRange(new Uint8Array([3, 4]), 'uint8')).toBe('byte')
    expect(detectOutputRange([0, 200], 'float32')).toBe('byte')
    expect(detectOutputRange([-0.9, 0.8], 'float32')).toBe('signed')
    expect(detectOutputRange([0, 0.8], 'float32')).toBe('unit')
    expect(Array.from(outputToByte([-1, 1], 'signed'))).toEqual([0, 255])
    expect(Array.from(outputToByte([0.5], 'unit'))).toEqual([127.5])
  })

  it('洞还是洋红时变化接近 0，补成灰色时明显变大', () => {
    const size = 64
    const { image, box } = inpaintProbeImage(size)
    const untouched = outputToByte(image, 'unit')
    expect(holeChange(untouched, size, box)).toBeCloseTo(0, 5)
    const filled = new Float32Array(untouched)
    filled.fill(128)
    expect(holeChange(filled, size, box)).toBeGreaterThan(0.2)
  })
})
