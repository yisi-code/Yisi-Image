import { describe, expect, it } from 'vitest'
import { getFormatLabel } from './image'

describe('getFormatLabel', () => {
  it('优先按 MIME 识别', () => {
    expect(getFormatLabel('image/jpeg', 'a.png')).toBe('JPG')
    expect(getFormatLabel('image/x-ms-bmp', '')).toBe('BMP')
    expect(getFormatLabel('image/webp', '')).toBe('WebP')
  })

  it('没有 MIME 时按扩展名，认不出返回空串', () => {
    expect(getFormatLabel('', '截图.AVIF')).toBe('AVIF')
    expect(getFormatLabel('', 'notes.txt')).toBe('')
  })
})
