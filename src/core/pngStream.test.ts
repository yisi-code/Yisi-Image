import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PngCanceledError, createBlobSink, crc32, encodePngStrips, filterRowSub } from './pngStream'

/** 解析 PNG：校验签名与每块 CRC，取出宽高与解压、反滤波后的 RGBA。 */
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array; types: string[] } {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  const types: string[] = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const crc = view.getUint32(offset + 8 + length)
    expect(crc).toBe(crc32([bytes.subarray(offset + 4, offset + 8), data]))
    types.push(type)
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      expect(Array.from(data.subarray(8))).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = width * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)]
    expect(filter).toBe(1)
    for (let i = 0; i < rowBytes; i += 1) {
      const value = raw[y * (rowBytes + 1) + 1 + i]
      const left = i >= 4 ? rgba[y * rowBytes + i - 4] : 0
      rgba[y * rowBytes + i] = (value + left) & 0xff
    }
  }
  return { width, height, rgba, types }
}

function pattern(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = (p * 7) % 256
    rgba[p * 4 + 1] = (p * 13) % 256
    rgba[p * 4 + 2] = (p * 29) % 256
    rgba[p * 4 + 3] = p % 3 === 0 ? 128 : 255
  }
  return rgba
}

describe('pngStream', () => {
  it('Sub 滤波与左边像素做差，结果按字节回绕', () => {
    const out = new Uint8Array(9)
    filterRowSub(new Uint8Array([10, 20, 30, 40, 5, 25, 30, 41]), out)
    expect(Array.from(out)).toEqual([1, 10, 20, 30, 40, 251, 5, 0, 1])
  })

  it('按行带分块写出的 PNG 能还原出原像素，块结构与 CRC 正确', async () => {
    const width = 37
    const height = 23
    const source = pattern(width, height)
    const bands: Array<[number, number]> = []
    const sink = createBlobSink()
    const progress: number[] = []
    await encodePngStrips(
      {
        width,
        height,
        bandHeight: 5,
        async readBand(y, rows) {
          bands.push([y, rows])
          return source.slice(y * width * 4, (y + rows) * width * 4)
        },
      },
      sink,
      { onProgress: (fraction) => progress.push(fraction) },
    )
    expect(bands).toEqual([
      [0, 5],
      [5, 5],
      [10, 5],
      [15, 5],
      [20, 3],
    ])
    expect(progress.at(-1)).toBe(1)
    const bytes = new Uint8Array(await sink.toBlob().arrayBuffer())
    const decoded = decodePng(bytes)
    expect(decoded.types[0]).toBe('IHDR')
    expect(decoded.types.at(-1)).toBe('IEND')
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(source))
  })

  it('要求停止时抛出 PngCanceledError', async () => {
    let calls = 0
    await expect(
      encodePngStrips(
        {
          width: 4,
          height: 10,
          bandHeight: 2,
          async readBand(_y, rows) {
            calls += 1
            return new Uint8ClampedArray(rows * 16)
          },
        },
        createBlobSink(),
        { isCanceled: () => calls >= 2 },
      ),
    ).rejects.toBeInstanceOf(PngCanceledError)
    expect(calls).toBe(2)
  })
})
