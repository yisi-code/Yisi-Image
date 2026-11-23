import { describe, expect, it } from 'vitest'
import {
  EXPORT_FORMATS,
  EXPORT_QUALITY,
  buildExportFileName,
  getExportBackground,
  getExportFormat,
  getSaveTypes,
  isTransparencyDropped,
} from './exportFormats'

describe('export formats', () => {
  it('defines PNG, JPEG and WebP with matching extensions', () => {
    expect(EXPORT_FORMATS.map((format) => format.value)).toEqual(['png', 'jpeg', 'webp'])
    expect(getExportFormat('png')).toMatchObject({ mime: 'image/png', extension: 'png' })
    expect(getExportFormat('jpeg')).toMatchObject({ mime: 'image/jpeg', extension: 'jpg' })
    expect(getExportFormat('webp')).toMatchObject({ mime: 'image/webp', extension: 'webp' })
  })

  it('marks only JPEG and WebP as lossy quality formats', () => {
    expect(getExportFormat('png').supportsQuality).toBe(false)
    expect(getExportFormat('jpeg').supportsQuality).toBe(true)
    expect(getExportFormat('webp').supportsQuality).toBe(true)
    expect(EXPORT_QUALITY).toBe(0.92)
  })

  it('keeps transparency only for formats with an alpha channel', () => {
    const png = getExportFormat('png')
    const jpeg = getExportFormat('jpeg')
    const webp = getExportFormat('webp')
    expect(getExportBackground('transparent', png)).toBeNull()
    expect(getExportBackground('transparent', webp)).toBeNull()
    expect(getExportBackground('transparent', jpeg)).toBe('#ffffff')
    expect(getExportBackground('#123456', jpeg)).toBe('#123456')
    expect(isTransparencyDropped('transparent', jpeg)).toBe(true)
    expect(isTransparencyDropped('transparent', png)).toBe(false)
    expect(isTransparencyDropped('#000000', jpeg)).toBe(false)
  })

  it('builds a timestamped file name with the selected extension', () => {
    const date = new Date(2026, 10, 17, 10, 20, 30)
    expect(buildExportFileName(date, 'png')).toBe('拼接图片-20261117-102030.png')
    expect(buildExportFileName(date, 'jpeg')).toBe('拼接图片-20261117-102030.jpg')
    expect(buildExportFileName(date, 'webp')).toBe('拼接图片-20261117-102030.webp')
  })

  it('exposes the right save picker accept types', () => {
    expect(getSaveTypes(getExportFormat('jpeg'))).toEqual([
      { description: 'JPEG 图片', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
    ])
    expect(getSaveTypes(getExportFormat('webp'))[0]?.accept).toEqual({
      'image/webp': ['.webp'],
    })
  })
})
