/**
 * 分块写 PNG：不需要一张能装下整幅图的画布，按行带取像素、逐行滤波后交给 CompressionStream 压缩，
 * 压缩结果按 IDAT 块写出。用于超出画布上限的拼接长图（PNG 规范本身允许单边到 2^31 − 1）。
 *
 * 只写 RGBA 8 位、非隔行；每行用 Sub 滤波（与左边像素做差），计算量小、对截图和照片都有效。
 */

/** 输出去处：系统保存窗口的可写流，或收集成 Blob 再下载。 */
export interface PngSink {
  write(chunk: Uint8Array): Promise<void>
}

export interface PngStripSource {
  width: number
  height: number
  /** 推荐的行带高度；每次最多要这么多行 */
  bandHeight: number
  /** 取第 y 行起的 rows 行，返回 rows × width × 4 的 RGBA */
  readBand(y: number, rows: number): Promise<Uint8ClampedArray>
}

export interface PngStripOptions {
  /** 每写完一条行带回报一次进度（0–1） */
  onProgress?: (fraction: number) => void
  /** 返回 true 时尽快停止，抛出 PngCanceledError */
  isCanceled?: () => boolean
}

export class PngCanceledError extends Error {
  constructor() {
    super('已停止导出')
    this.name = 'PngCanceledError'
  }
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
/** 压缩输出攒到这么多再写一个 IDAT 块，避免成千上万个小块 */
const IDAT_TARGET_BYTES = 1 << 20

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c >>> 0
    }
  }
  return crcTable
}

/** PNG 块的 CRC-32：覆盖块类型与数据。 */
export function crc32(parts: readonly Uint8Array[]): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      crc = table[(crc ^ part[i]) & 0xff] ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32([typeBytes, data]))
  return out
}

function header(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13)
  const view = new DataView(data.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  data[8] = 8 // 位深
  data[9] = 6 // RGBA
  data[10] = 0 // 压缩方式
  data[11] = 0 // 滤波方式
  data[12] = 0 // 非隔行
  return chunk('IHDR', data)
}

/** 一行加 Sub 滤波：首字节为滤波类型 1，其余为与左边像素（4 字节前）的差。 */
export function filterRowSub(row: Uint8ClampedArray | Uint8Array, out: Uint8Array): void {
  out[0] = 1
  for (let i = 0; i < row.length; i += 1) {
    out[i + 1] = (row[i] - (i >= 4 ? row[i - 4] : 0)) & 0xff
  }
}

/** 把行带一条条取出、压缩并写成 PNG。 */
export async function encodePngStrips(
  source: PngStripSource,
  sink: PngSink,
  options: PngStripOptions = {},
): Promise<void> {
  const { width, height } = source
  if (width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效')
  }
  await sink.write(SIGNATURE)
  await sink.write(header(width, height))

  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  // 压缩输出与写入并行读出，否则压缩流的缓冲满了会让 writer.write 一直等下去。
  const drain = (async () => {
    let pending: Uint8Array[] = []
    let pendingBytes = 0
    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) {
        return
      }
      const data = new Uint8Array(pendingBytes)
      let offset = 0
      for (const part of pending) {
        data.set(part, offset)
        offset += part.length
      }
      pending = []
      pendingBytes = 0
      await sink.write(chunk('IDAT', data))
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      pending.push(value)
      pendingBytes += value.length
      if (pendingBytes >= IDAT_TARGET_BYTES) {
        await flush()
      }
    }
    await flush()
  })()

  const rowBytes = width * 4
  const bandHeight = Math.max(1, Math.floor(source.bandHeight))
  try {
    for (let y = 0; y < height; y += bandHeight) {
      if (options.isCanceled?.()) {
        throw new PngCanceledError()
      }
      const rows = Math.min(bandHeight, height - y)
      const rgba = await source.readBand(y, rows)
      if (rgba.length !== rows * rowBytes) {
        throw new Error('分块像素数据大小不对')
      }
      const filtered = new Uint8Array(rows * (rowBytes + 1))
      for (let r = 0; r < rows; r += 1) {
        filterRowSub(
          rgba.subarray(r * rowBytes, (r + 1) * rowBytes),
          filtered.subarray(r * (rowBytes + 1), (r + 1) * (rowBytes + 1)),
        )
      }
      await writer.write(filtered)
      options.onProgress?.(Math.min(1, (y + rows) / height))
    }
    await writer.close()
  } catch (error) {
    await writer.abort(error).catch(() => undefined)
    await drain.catch(() => undefined)
    throw error
  }
  await drain
  await sink.write(chunk('IEND', new Uint8Array(0)))
}

/** 收集成 Blob 的去处：浏览器不能选保存位置时用它，最后整体下载。 */
export function createBlobSink(): PngSink & { toBlob(): Blob } {
  const parts: Uint8Array[] = []
  return {
    async write(data) {
      parts.push(data)
    },
    toBlob() {
      return new Blob(parts as BlobPart[], { type: 'image/png' })
    },
  }
}
