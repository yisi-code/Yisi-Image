/**
 * EXE 启动器的 AI 模型（修瑕、清晰化）接口：查看状态、下载 / 暂停 / 删除、选择与移动模型目录。
 * 下载在启动器里进行（断点续传、SHA-256 校验），页面只发指令、轮询进度；
 * 下载好的文件由启动器在 /models/文件名 下提供给页面。
 */

import { ConfigApiError, launcherRequest } from './configApi'
import type { LauncherResponse } from './configApi'

/** 修瑕用的 AI 模型 */
export type HealModelId = 'migan' | 'lama'
/** 清晰化用的 AI 模型 */
export type SharpenModelId = 'realesrgan'
/** 启动器能下载的全部模型 */
export type ModelId = HealModelId | SharpenModelId

export const MODEL_IDS: readonly ModelId[] = ['migan', 'lama', 'realesrgan']

/** 自定义模型的用途：清晰化或局部修瑕 */
export type CustomModelKind = 'sharpen' | 'heal'
/** 自定义模型编号：custom- 加 SHA-256 前 12 位 */
export type CustomModelKey = `custom-${string}`

const CUSTOM_KEY_PATTERN = /^custom-[0-9a-f]{12}$/

export function isCustomModelKey(value: unknown): value is CustomModelKey {
  return typeof value === 'string' && CUSTOM_KEY_PATTERN.test(value)
}

/**
 * missing：没有下载过；queued：排队等前一个下完；downloading / verifying：下载中 / 校验中；
 * paused：下了一部分（暂停或程序关闭）；ready：可以使用；error：上次下载失败，error 字段是原因。
 */
export type ModelState =
  | 'missing'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'paused'
  | 'ready'
  | 'error'

export interface ModelStatus {
  id: ModelId
  state: ModelState
  /** 已下载字节数（运行库 + 模型，含下了一半的部分） */
  downloaded: number
  /** 运行库 + 模型的总字节数 */
  total: number
  /** 模型文件本身已下载的字节数（不含共用的运行库）；为 0 时没有可删除的模型文件 */
  modelDownloaded: number
  modelSize: number
  /** wasm 运行库的大小；各模型共用一份 */
  runtimeSize: number
  error: string
  runtimeUrl: string
  modelUrl: string
}

/** 用户导入的 AI 模型（只在 EXE 版里，由启动器保存在模型目录的 custom 文件夹） */
export interface CustomModel {
  id: CustomModelKey
  kind: CustomModelKind
  name: string
  size: number
  sha256: string
  /** 文件还在、大小一致 */
  available: boolean
  modelUrl: string
}

export interface ModelsSnapshot {
  dir: string
  defaultDir: string
  isDefault: boolean
  items: ModelStatus[]
  /** 各模型共用的运行库是否已下载；自定义模型要靠它才能运行 */
  runtimeReady: boolean
  runtimeUrl: string
  custom: CustomModel[]
}

const MODEL_STATES: readonly ModelState[] = [
  'missing',
  'queued',
  'downloading',
  'verifying',
  'paused',
  'ready',
  'error',
]

/** 正在进行、需要轮询进度的状态。 */
export function isModelBusy(state: ModelState): boolean {
  return state === 'queued' || state === 'downloading' || state === 'verifying'
}

interface ModelsResponse extends LauncherResponse {
  dir?: unknown
  defaultDir?: unknown
  isDefault?: unknown
  items?: unknown
  moved?: boolean
  canceled?: boolean
  runtimeReady?: unknown
  runtimeUrl?: unknown
  custom?: unknown
  imported?: unknown
}

function toStatus(value: unknown): ModelStatus | null {
  const item = (value ?? {}) as Record<string, unknown>
  if (
    !MODEL_IDS.includes(item.id as ModelId) ||
    !MODEL_STATES.includes(item.state as ModelState) ||
    typeof item.downloaded !== 'number' ||
    typeof item.total !== 'number' ||
    typeof item.runtimeUrl !== 'string' ||
    typeof item.modelUrl !== 'string'
  ) {
    return null
  }
  return {
    id: item.id as ModelId,
    state: item.state as ModelState,
    downloaded: item.downloaded,
    total: item.total,
    modelDownloaded: typeof item.modelDownloaded === 'number' ? item.modelDownloaded : 0,
    modelSize: typeof item.modelSize === 'number' ? item.modelSize : 0,
    runtimeSize: typeof item.runtimeSize === 'number' ? item.runtimeSize : 0,
    error: typeof item.error === 'string' ? item.error : '',
    runtimeUrl: item.runtimeUrl,
    modelUrl: item.modelUrl,
  }
}

function toCustom(value: unknown): CustomModel | null {
  const item = (value ?? {}) as Record<string, unknown>
  if (
    !isCustomModelKey(item.id) ||
    typeof item.name !== 'string' ||
    typeof item.modelUrl !== 'string' ||
    typeof item.size !== 'number'
  ) {
    return null
  }
  return {
    id: item.id,
    // 旧版启动器不返回用途，当时只能导入清晰化模型。
    kind: item.kind === 'heal' ? 'heal' : 'sharpen',
    name: item.name,
    size: item.size,
    sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
    available: item.available === true,
    modelUrl: item.modelUrl,
  }
}

function toSnapshot(body: ModelsResponse): ModelsSnapshot {
  const items = Array.isArray(body.items) ? body.items.map(toStatus) : null
  if (typeof body.dir !== 'string' || !items || items.some((item) => item === null)) {
    throw new ConfigApiError('本地服务返回的模型信息不完整')
  }
  // 自定义模型清单里个别条目损坏时跳过它，不让整个模型列表读不出来。
  const custom = Array.isArray(body.custom)
    ? body.custom.map(toCustom).filter((item): item is CustomModel => item !== null)
    : []
  return {
    dir: body.dir,
    defaultDir: typeof body.defaultDir === 'string' ? body.defaultDir : body.dir,
    isDefault: body.isDefault === true,
    items: items as ModelStatus[],
    runtimeReady: body.runtimeReady === true,
    runtimeUrl: typeof body.runtimeUrl === 'string' ? body.runtimeUrl : '',
    custom,
  }
}

function post(path: string, payload?: unknown): Promise<ModelsResponse> {
  return launcherRequest<ModelsResponse>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
}

export async function fetchModels(): Promise<ModelsSnapshot> {
  return toSnapshot(await launcherRequest<ModelsResponse>('/api/models', { timeoutMs: 3000 }))
}

/** 开始或继续下载（已在下载或排队时不重复）。 */
export async function downloadModel(id: ModelId): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/download', { id }))
}

/** 暂停：已下载的部分保留，之后可继续。 */
export async function pauseModel(id: ModelId): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/pause', { id }))
}

/** 删除模型文件（含下了一半的）；运行库还有另一个模型在用时保留。 */
export async function deleteModel(id: ModelId): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/delete', { id }))
}

/** 弹出系统「选择文件夹」窗口；用户取消时返回 null。 */
export async function pickModelsDir(): Promise<string | null> {
  const body = await post('/api/models/pick-dir')
  return body.canceled || typeof body.dir !== 'string' ? null : body.dir
}

/** 把模型文件移到 dir（null 表示移回程序目录下的 models）；moved 为 false 表示所选目录就是当前目录。 */
export async function moveModelsDir(
  dir: string | null,
): Promise<{ snapshot: ModelsSnapshot; moved: boolean }> {
  const body = await post('/api/models/location', { dir })
  return { snapshot: toSnapshot(body), moved: body.moved === true }
}

/** 弹出系统「打开文件」窗口导入一个 ONNX 模型作为 kind 用途；取消时 imported 为 null。 */
export async function importCustomModel(
  kind: CustomModelKind,
): Promise<{ snapshot: ModelsSnapshot; imported: string | null }> {
  const body = await post('/api/models/custom/import', { kind })
  return { snapshot: toSnapshot(body), imported: typeof body.imported === 'string' ? body.imported : null }
}

export async function renameCustomModel(id: string, name: string): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/custom/rename', { id, name }))
}

export async function deleteCustomModel(id: string): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/custom/delete', { id }))
}

export async function openModelsDir(): Promise<void> {
  await post('/api/models/open-dir')
}
