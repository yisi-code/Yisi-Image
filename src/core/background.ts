/**
 * 拼接画布的背景：图片大小不一时露出的空位与间距都用它填充。
 * 取值为 `transparent` 或小写 `#rrggbb`；空白页有自己的白底，不跟随。
 * 单独成文件，让导出格式与设置都能引用而不互相依赖。
 */
export type StitchBackground = string

export const TRANSPARENT_BACKGROUND = 'transparent'
export const DEFAULT_BACKGROUND: StitchBackground = '#ffffff'

/** 只接受 `transparent` 与 `#rrggbb`（统一成小写），其余回退白色。 */
export function normalizeBackground(value: unknown): StitchBackground {
  if (value === TRANSPARENT_BACKGROUND) {
    return TRANSPARENT_BACKGROUND
  }
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
    return value.toLowerCase()
  }
  return DEFAULT_BACKGROUND
}
