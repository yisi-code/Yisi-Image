/**
 * EXE 启动器的 AI 修瑕模型接口：查看状态、下载 / 暂停 / 删除、选择与移动模型目录。
 * 下载在启动器里进行（断点续传、SHA-256 校验），页面只发指令、轮询进度；
 * 下载好的文件由启动器在 /models/文件名 下提供给页面。
 */

import { ConfigApiError, launcherRequest } from './configApi'
import type { LauncherResponse } from './configApi'

export type AiModelId = 'migan' | 'lama'

export const AI_MODEL_IDS: readonly AiModelId[] = ['migan', 'lama']

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
  id: AiModelId
  state: ModelState
  /** 已下载字节数（运行库 + 模型，含下了一半的部分） */
  downloaded: number
  /** 运行库 + 模型的总字节数 */
  total: number
  /** 模型文件本身已下载的字节数（不含共用的运行库）；为 0 时没有可删除的模型文件 */
  modelDownloaded: number
  modelSize: number
  /** wasm 运行库的大小；两个模型共用一份 */
  runtimeSize: number
  error: string
  runtimeUrl: string
  modelUrl: string
}

export interface ModelsSnapshot {
  dir: string
  defaultDir: string
  isDefault: boolean
  items: ModelStatus[]
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
}

function toStatus(value: unknown): ModelStatus | null {
  const item = (value ?? {}) as Record<string, unknown>
  if (
    !AI_MODEL_IDS.includes(item.id as AiModelId) ||
    !MODEL_STATES.includes(item.state as ModelState) ||
    typeof item.downloaded !== 'number' ||
    typeof item.total !== 'number' ||
    typeof item.runtimeUrl !== 'string' ||
    typeof item.modelUrl !== 'string'
  ) {
    return null
  }
  return {
    id: item.id as AiModelId,
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

function toSnapshot(body: ModelsResponse): ModelsSnapshot {
  const items = Array.isArray(body.items) ? body.items.map(toStatus) : null
  if (typeof body.dir !== 'string' || !items || items.some((item) => item === null)) {
    throw new ConfigApiError('本地服务返回的模型信息不完整')
  }
  return {
    dir: body.dir,
    defaultDir: typeof body.defaultDir === 'string' ? body.defaultDir : body.dir,
    isDefault: body.isDefault === true,
    items: items as ModelStatus[],
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
export async function downloadModel(id: AiModelId): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/download', { id }))
}

/** 暂停：已下载的部分保留，之后可继续。 */
export async function pauseModel(id: AiModelId): Promise<ModelsSnapshot> {
  return toSnapshot(await post('/api/models/pause', { id }))
}

/** 删除模型文件（含下了一半的）；运行库还有另一个模型在用时保留。 */
export async function deleteModel(id: AiModelId): Promise<ModelsSnapshot> {
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

export async function openModelsDir(): Promise<void> {
  await post('/api/models/open-dir')
}
