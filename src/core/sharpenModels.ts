import type { SharpenModelId } from './modelApi'

/**
 * 内置的 AI 清晰化模型：倍数与分块要求固定登记在这里，不用每次试算。
 * 自定义模型（编号 custom-…）的倍数和固定尺寸在第一次使用时由 Worker 试算得出。
 */
export interface BuiltinSharpenModel {
  id: SharpenModelId
  label: string
  /** 一句话说明适合什么图 */
  summary: string
  /** 输出是输入的几倍 */
  scale: number
  /** 送进模型的宽高要补到它的整数倍 */
  multiple: number
}

export const BUILTIN_SHARPEN_MODELS: readonly BuiltinSharpenModel[] = [
  {
    id: 'realesrgan',
    label: 'Real-ESRGAN（通用）',
    summary: '照片与截图通用，×4；BSD-3 许可',
    scale: 4,
    multiple: 1,
  },
]

/** 自定义模型送进去前统一补到 16 的倍数：窗口注意力类模型常要求 8 或 16，卷积模型补边也无妨 */
export const CUSTOM_MODEL_MULTIPLE = 16

export function findBuiltinSharpenModel(id: string): BuiltinSharpenModel | null {
  return BUILTIN_SHARPEN_MODELS.find((model) => model.id === id) ?? null
}
