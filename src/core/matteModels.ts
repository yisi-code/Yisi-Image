import { IMAGENET_NORMALIZATION, MEAN_ONLY_NORMALIZATION } from './matte'
import type { MatteSpec } from './matte'
import type { MatteModelId, SegmentModelId } from './modelApi'
import type { EngineOption } from './settings'

/**
 * 内置的去除背景、点选抠图模型登记。文件、大小、哈希在 EXE 启动器（ModelStore.cs）里，
 * 这里记页面要知道的：怎么喂模型、设置页上怎么介绍。耗时为本机 Node 单线程实测量级。
 */

export interface BuiltinMatteModel extends EngineOption<MatteModelId> {
  spec: MatteSpec
}

export const BUILTIN_MATTE_MODELS: readonly BuiltinMatteModel[] = [
  {
    value: 'u2netp',
    label: 'U²-Net-P',
    tag: '约 19 MB',
    summary: '轻量模型，按 320 × 320 识别主体',
    strengths: ['快，常见 1 秒内', '人像、商品等主体清楚的图够用', 'Apache-2.0 许可'],
    limits: ['边缘较粗，头发、毛绒、镂空处会糊在一起', '需下载模型 4.4 MB + 运行库 14.2 MB'],
    spec: { size: 320, normalization: IMAGENET_NORMALIZATION },
  },
  {
    value: 'isnet',
    label: 'IS-Net',
    tag: '约 185 MB',
    summary: '精细模型，按 1024 × 1024 识别主体',
    strengths: ['边缘细，发丝、枝叶、镂空保留得更多', '复杂背景下主体判断更稳', 'Apache-2.0 许可'],
    limits: ['较慢：多线程约 2–3 秒，单线程约 9 秒，加载后约占 1 GB 内存', '需下载模型 170.4 MB（运行库与其他 AI 模型共用）'],
    spec: { size: 1024, normalization: MEAN_ONLY_NORMALIZATION },
  },
]

export const DEFAULT_MATTE_MODEL: MatteModelId = 'isnet'

export interface BuiltinSegmentModel {
  id: SegmentModelId
  label: string
  summary: string
}

export const BUILTIN_SEGMENT_MODELS: readonly BuiltinSegmentModel[] = [
  {
    id: 'mobilesam',
    label: 'MobileSAM',
    summary: '点一下物体就能选中',
  },
]

export const DEFAULT_SEGMENT_MODEL: SegmentModelId = 'mobilesam'

export function findBuiltinMatteModel(key: string): BuiltinMatteModel | null {
  return BUILTIN_MATTE_MODELS.find((model) => model.value === key) ?? null
}

export function findBuiltinSegmentModel(key: string): BuiltinSegmentModel | null {
  return BUILTIN_SEGMENT_MODELS.find((model) => model.id === key) ?? null
}
