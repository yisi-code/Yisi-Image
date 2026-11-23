import { onBeforeUnmount, ref, watch } from 'vue'
import { IS_DESKTOP_APP } from '../core/appInfo'
import {
  fetchConfig,
  moveConfigDir,
  openConfigDir,
  pickConfigDir,
  saveConfig,
} from '../core/configApi'
import type { ConfigLocation } from '../core/configApi'
import {
  clearBrowserSettings,
  normalizeSettings,
  readBrowserSettings,
  writeBrowserSettings,
} from '../core/settings'
import type { PanelKey, PanelState, ToolSettings } from '../core/settings'

/** file：EXE 启动器的配置文件；browser：浏览器 localStorage（开发模式或启动器接口不可用时）。 */
export type SettingsStorage = 'file' | 'browser'

export interface InitialSettings {
  settings: ToolSettings
  storage: SettingsStorage
  location: ConfigLocation | null
  /** 读取或首次创建配置文件失败的原因；空串表示正常 */
  error: string
}

export interface ConfigDirStatus {
  tone: 'info' | 'success' | 'error'
  text: string
}

/** 滑块拖动、工具栏拖动会连续改设置，合并成一次写入。 */
const SAVE_DELAY_MS = 400

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

/**
 * 页面挂载前读取设置，避免先按默认值渲染再跳成已保存的值。
 * EXE 首次运行还没有配置文件时，把旧版保存在浏览器里的设置迁移进来并立即建好文件。
 * 迁移分支属于数据兼容：旧设置只存在各用户自己的浏览器里，无法确认何时都已迁完，不随发版删除。
 */
export async function loadInitialSettings(): Promise<InitialSettings> {
  if (!IS_DESKTOP_APP) {
    return {
      settings: readBrowserSettings() ?? normalizeSettings(null),
      storage: 'browser',
      location: null,
      error: '',
    }
  }

  try {
    const snapshot = await fetchConfig()
    if (snapshot.settings !== null) {
      return {
        settings: normalizeSettings(snapshot.settings),
        storage: 'file',
        location: snapshot.location,
        error: '',
      }
    }

    const migrated = readBrowserSettings()
    const settings = migrated ?? normalizeSettings(null)
    try {
      await saveConfig(settings)
      if (migrated) {
        clearBrowserSettings()
      }
      return {
        settings,
        storage: 'file',
        location: { ...snapshot.location, exists: true },
        error: '',
      }
    } catch (error) {
      return { settings, storage: 'file', location: snapshot.location, error: messageOf(error) }
    }
  } catch (error) {
    // 启动器接口不可用时退回浏览器存储，保证页面仍能使用。
    return {
      settings: readBrowserSettings() ?? normalizeSettings(null),
      storage: 'browser',
      location: null,
      error: `无法读取配置文件：${messageOf(error)}`,
    }
  }
}

export function useSettings(initial: InitialSettings) {
  const settings = ref<ToolSettings>(initial.settings)
  const storage = initial.storage
  const location = ref<ConfigLocation | null>(initial.location)
  const saveError = ref(initial.error)
  const isMovingDir = ref(false)
  const dirStatus = ref<ConfigDirStatus | null>(null)
  let saveTimer = 0
  let hasPendingSave = false

  watch(settings, () => {
    hasPendingSave = true
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void persist(), SAVE_DELAY_MS)
  })

  async function persist(keepalive = false): Promise<void> {
    window.clearTimeout(saveTimer)
    if (!hasPendingSave) {
      return
    }
    hasPendingSave = false
    const snapshot = settings.value
    if (storage === 'browser') {
      writeBrowserSettings(snapshot)
      return
    }
    try {
      await saveConfig(snapshot, keepalive)
      saveError.value = ''
      if (location.value && !location.value.exists) {
        location.value = { ...location.value, exists: true }
      }
    } catch (error) {
      saveError.value = messageOf(error)
      // 之前「已移到…」之类的结果已经过时，让设置页显示这次保存失败。
      if (!isMovingDir.value) {
        dirStatus.value = null
      }
    }
  }

  function update(patch: Partial<ToolSettings>): void {
    settings.value = { ...settings.value, ...patch }
  }

  function updatePanel(key: PanelKey, state: PanelState): void {
    update({ [key]: state })
  }

  /** 恢复全部默认值（缩略图、间距、背景、面板位置与显示状态）；配置目录不变。 */
  function reset(): void {
    settings.value = normalizeSettings(null)
  }

  /** 返回 false 表示所选目录就是当前目录，没有移动。 */
  async function relocate(dir: string | null): Promise<boolean> {
    const result = await moveConfigDir(dir)
    location.value = result.location
    if (result.moved) {
      // 移动的是磁盘上的文件；再写一次内存里的设置，保证新位置与界面一致。
      hasPendingSave = true
      await persist()
    }
    return result.moved
  }

  /** busyText 在操作进行中显示；操作返回的状态替换它，返回 null 则清空。 */
  async function runDirAction(
    busyText: string,
    action: () => Promise<ConfigDirStatus | null>,
  ): Promise<void> {
    if (storage !== 'file' || isMovingDir.value) {
      return
    }
    isMovingDir.value = true
    dirStatus.value = busyText ? { tone: 'info', text: busyText } : null
    try {
      dirStatus.value = await action()
    } catch (error) {
      dirStatus.value = { tone: 'error', text: messageOf(error) }
    } finally {
      isMovingDir.value = false
    }
  }

  function changeDir(): Promise<void> {
    return runDirAction('请在弹出的窗口中选择目录…', async () => {
      await persist()
      const dir = await pickConfigDir()
      if (!dir) {
        return null
      }
      if (!(await relocate(dir))) {
        return { tone: 'info', text: '所选目录就是当前配置目录，没有移动' }
      }
      return { tone: 'success', text: `配置文件已移到 ${location.value?.dir ?? dir}` }
    })
  }

  function resetDir(): Promise<void> {
    return runDirAction('正在移回程序所在目录…', async () => {
      await persist()
      const moved = await relocate(null)
      return moved ? { tone: 'success', text: '配置文件已移回程序所在目录' } : null
    })
  }

  function openDir(): Promise<void> {
    return runDirAction('', async () => {
      await persist()
      await openConfigDir()
      return null
    })
  }

  function onPageHide(): void {
    // 关闭页面时把还没写出的改动立即发出去；keepalive 让请求在页面卸载后仍能完成。
    void persist(true)
  }

  window.addEventListener('pagehide', onPageHide)
  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', onPageHide)
    void persist()
  })

  return {
    settings,
    storage,
    location,
    saveError,
    isMovingDir,
    dirStatus,
    update,
    updatePanel,
    reset,
    changeDir,
    resetDir,
    openDir,
  }
}
