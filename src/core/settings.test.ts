import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  clearBrowserSettings,
  normalizeSettings,
  readBrowserSettings,
  writeBrowserSettings,
} from './settings'
import type { ToolSettings } from './settings'

const CUSTOM_SETTINGS: ToolSettings = {
  thumbnailOrientation: 'horizontal',
  thumbnailSize: 'small',
  thumbnailFit: 'fill',
  gap: 48,
  annotationToolbar: {
    collapsed: true,
    position: { x: 'right', y: 'top', dx: 20, dy: 12 },
  },
  zoomToolbar: { collapsed: false, position: null },
  blankPanel: { collapsed: true, position: null },
  thumbnailPanel: { collapsed: true, position: null },
}

describe('normalizeSettings', () => {
  it('无有效数据时回退默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('保留有效设置', () => {
    expect(normalizeSettings(CUSTOM_SETTINGS)).toEqual(CUSTOM_SETTINGS)
  })

  it('旧版只有缩略图三项时，其余项取默认值', () => {
    expect(
      normalizeSettings({
        thumbnailOrientation: 'vertical',
        thumbnailSize: 'large',
        thumbnailFit: 'cover',
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      thumbnailOrientation: 'vertical',
      thumbnailSize: 'large',
      thumbnailFit: 'cover',
    })
  })

  it('逐项回退非法值', () => {
    expect(
      normalizeSettings({
        thumbnailOrientation: 'diagonal',
        thumbnailSize: 'huge',
        thumbnailFit: 'stretch',
        gap: '40',
        annotationToolbar: { collapsed: 'yes', position: { x: 'middle' } },
        zoomToolbar: 'hidden',
        blankPanel: { collapsed: 1 },
        thumbnailPanel: null,
      }),
    ).toEqual(DEFAULT_SETTINGS)
  })

  it('间距超出范围时限制到 0–200', () => {
    expect(normalizeSettings({ gap: 999 }).gap).toBe(200)
    expect(normalizeSettings({ gap: -3 }).gap).toBe(0)
    expect(normalizeSettings({ gap: 12.4 }).gap).toBe(12)
  })

  it('每次返回新的工具栏对象，不共享默认值引用', () => {
    const first = normalizeSettings(null)
    const second = normalizeSettings(null)
    expect(first.annotationToolbar).not.toBe(second.annotationToolbar)
    expect(first.annotationToolbar).not.toBe(DEFAULT_SETTINGS.annotationToolbar)
  })
})

describe('browser settings storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubStorage(initial?: string) {
    const store = new Map<string, string>()
    if (initial !== undefined) {
      store.set(SETTINGS_STORAGE_KEY, initial)
    }
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    return store
  }

  it('保存后可读取', () => {
    const store = stubStorage()
    writeBrowserSettings(CUSTOM_SETTINGS)
    expect(store.has(SETTINGS_STORAGE_KEY)).toBe(true)
    expect(readBrowserSettings()).toEqual(CUSTOM_SETTINGS)
  })

  it('没有数据时返回 null', () => {
    stubStorage()
    expect(readBrowserSettings()).toBeNull()
  })

  it('损坏内容返回 null', () => {
    stubStorage('{broken')
    expect(readBrowserSettings()).toBeNull()
  })

  it('迁移后可清除', () => {
    const store = stubStorage(JSON.stringify(CUSTOM_SETTINGS))
    clearBrowserSettings()
    expect(store.has(SETTINGS_STORAGE_KEY)).toBe(false)
  })
})
