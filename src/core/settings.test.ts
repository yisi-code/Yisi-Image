import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './settings'

describe('normalizeSettings', () => {
  it('无有效数据时回退默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('保留有效设置', () => {
    expect(
      normalizeSettings({
        thumbnailOrientation: 'vertical',
        thumbnailSize: 'large',
        thumbnailFit: 'cover',
      }),
    ).toEqual({
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
      }),
    ).toEqual(DEFAULT_SETTINGS)
  })
})

describe('settings storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('保存后可读取', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })

    saveSettings({
      thumbnailOrientation: 'horizontal',
      thumbnailSize: 'small',
      thumbnailFit: 'fill',
    })

    expect(store.has(SETTINGS_STORAGE_KEY)).toBe(true)
    expect(loadSettings()).toEqual({
      thumbnailOrientation: 'horizontal',
      thumbnailSize: 'small',
      thumbnailFit: 'fill',
    })
  })

  it('损坏内容回退默认值', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{broken',
      setItem: () => undefined,
    })

    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
