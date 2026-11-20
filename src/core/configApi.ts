/**
 * EXE 启动器的本地配置接口（只监听 127.0.0.1:47831）。
 *
 * 启动器只负责把设置 JSON 原样存进配置文件、移动配置目录、弹出选择目录窗口；
 * 字段校验统一由前端的 normalizeSettings 完成，两边不各写一份规则。
 * 每个请求都带 X-Yisi-Config 头：跨站页面带自定义头会先发预检，启动器不响应预检，
 * 这样别的网站无法替用户改配置或移动文件。
 */

const CONFIG_HEADER = { 'X-Yisi-Config': '1' } as const
const LOAD_TIMEOUT_MS = 3000

export interface ConfigLocation {
  /** 配置文件当前所在目录 */
  dir: string
  /** 配置文件完整路径 */
  file: string
  /** 默认目录：EXE 所在目录 */
  defaultDir: string
  isDefault: boolean
  /** 配置文件是否已经存在 */
  exists: boolean
}

export interface ConfigSnapshot {
  /** 配置文件里的原始设置；文件不存在或已损坏时为 null */
  settings: unknown
  location: ConfigLocation
}

export class ConfigApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigApiError'
  }
}

/** 启动器接口共有的响应字段；配置接口与 AI 模型接口（modelApi.ts）都用这一套请求函数。 */
export interface LauncherResponse {
  ok?: boolean
  error?: string
}

interface ApiResponse extends LauncherResponse {
  settings?: unknown
  location?: ConfigLocation
  dir?: string
  canceled?: boolean
  moved?: boolean
}

export interface MoveConfigResult {
  location: ConfigLocation
  /** false 表示所选目录就是当前目录，启动器没有做任何改动 */
  moved: boolean
}

export async function launcherRequest<T extends LauncherResponse>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs, ...rest } = init
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : 0
  let response: Response
  try {
    response = await fetch(path, {
      ...rest,
      headers: { ...CONFIG_HEADER, ...(rest.headers ?? {}) },
      signal: controller?.signal,
    })
  } catch (error) {
    throw new ConfigApiError(
      error instanceof DOMException && error.name === 'AbortError'
        ? '本地服务没有响应'
        : '无法连接本地服务',
    )
  } finally {
    window.clearTimeout(timer)
  }

  let body = {} as T
  try {
    body = (await response.json()) as T
  } catch {
    // 非 JSON 响应按状态码报错。
  }
  if (!response.ok || body.ok === false) {
    throw new ConfigApiError(body.error || `本地服务返回 ${response.status}`)
  }
  return body
}

function requireLocation(body: ApiResponse): ConfigLocation {
  if (!body.location || typeof body.location.dir !== 'string') {
    throw new ConfigApiError('本地配置服务返回的数据不完整')
  }
  return body.location
}

export async function fetchConfig(): Promise<ConfigSnapshot> {
  const body = await launcherRequest<ApiResponse>('/api/config', { timeoutMs: LOAD_TIMEOUT_MS })
  return { settings: body.settings ?? null, location: requireLocation(body) }
}

export async function saveConfig(settings: unknown, keepalive = false): Promise<void> {
  await launcherRequest<ApiResponse>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 启动器原样写入文件，缩进后用户打开配置文件也能看懂。
    body: JSON.stringify(settings, null, 2),
    keepalive,
  })
}

/** 弹出系统「选择文件夹」窗口；用户取消时返回 null。 */
export async function pickConfigDir(): Promise<string | null> {
  const body = await launcherRequest<ApiResponse>('/api/config/pick-dir', { method: 'POST' })
  if (body.canceled || !body.dir) {
    return null
  }
  return body.dir
}

/** 把配置文件移到 dir；dir 为 null 时移回 EXE 所在目录。 */
export async function moveConfigDir(dir: string | null): Promise<MoveConfigResult> {
  const body = await launcherRequest<ApiResponse>('/api/config/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  return { location: requireLocation(body), moved: body.moved === true }
}

export async function openConfigDir(): Promise<void> {
  await launcherRequest<ApiResponse>('/api/config/open-dir', { method: 'POST' })
}
