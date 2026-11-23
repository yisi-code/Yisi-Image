import { onBeforeUnmount, ref } from 'vue'
import {
  deleteCustomModel,
  importCustomModel,
  renameCustomModel,
  deleteModel,
  downloadModel,
  fetchModels,
  isModelBusy,
  moveModelsDir,
  openModelsDir,
  pauseModel,
  pickModelsDir,
} from '../core/modelApi'
import type { ModelId, ModelStatus, ModelsSnapshot } from '../core/modelApi'
import type { ConfigDirStatus } from './useSettings'

/** 下载进行中时轮询进度的间隔。 */
const POLL_MS = 600

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

/**
 * AI 修瑕模型的状态与操作（只在 EXE 版可用；浏览器开发模式 enabled 为 false，什么都不请求）。
 * 有模型在下载、排队或校验时自动轮询进度，全部停下后停止轮询。
 */
export function useModels(enabled: boolean) {
  const snapshot = ref<ModelsSnapshot | null>(null)
  /** 读取状态失败的原因；空串表示正常 */
  const loadError = ref('')
  /** 最近一次操作（下载、删除、换目录…）的进度或结果 */
  const actionStatus = ref<ConfigDirStatus | null>(null)
  const isBusy = ref(false)
  let pollTimer = 0
  let disposed = false

  function schedulePoll(): void {
    window.clearTimeout(pollTimer)
    if (!disposed && snapshot.value?.items.some((item) => isModelBusy(item.state))) {
      pollTimer = window.setTimeout(() => void refresh(), POLL_MS)
    }
  }

  function apply(next: ModelsSnapshot): void {
    snapshot.value = next
    loadError.value = ''
    schedulePoll()
  }

  async function refresh(): Promise<void> {
    if (!enabled || disposed) {
      return
    }
    try {
      apply(await fetchModels())
    } catch (error) {
      loadError.value = messageOf(error)
      // 本地服务短暂没响应时继续按原节奏重试，下载进度不会因此停止显示。
      schedulePoll()
    }
  }

  function statusOf(id: ModelId): ModelStatus | null {
    return snapshot.value?.items.find((item) => item.id === id) ?? null
  }

  /** busyText 在操作进行中显示；操作返回的状态替换它，返回 null 则清空。 */
  async function run(busyText: string, action: () => Promise<ConfigDirStatus | null>): Promise<void> {
    if (!enabled || isBusy.value) {
      return
    }
    isBusy.value = true
    actionStatus.value = busyText ? { tone: 'info', text: busyText } : null
    try {
      actionStatus.value = await action()
    } catch (error) {
      actionStatus.value = { tone: 'error', text: messageOf(error) }
    } finally {
      isBusy.value = false
    }
  }

  function download(id: ModelId): Promise<void> {
    return run('', async () => {
      apply(await downloadModel(id))
      return null
    })
  }

  function pause(id: ModelId): Promise<void> {
    return run('', async () => {
      apply(await pauseModel(id))
      return null
    })
  }

  function remove(id: ModelId): Promise<void> {
    return run('正在删除…', async () => {
      apply(await deleteModel(id))
      return { tone: 'success', text: '模型已删除' }
    })
  }

  function changeDir(): Promise<void> {
    return run('请在弹出的窗口中选择目录…', async () => {
      const dir = await pickModelsDir()
      if (!dir) {
        return null
      }
      const result = await moveModelsDir(dir)
      apply(result.snapshot)
      return result.moved
        ? { tone: 'success', text: `模型目录已改为 ${result.snapshot.dir}` }
        : { tone: 'info', text: '所选目录就是当前模型目录，没有移动' }
    })
  }

  function resetDir(): Promise<void> {
    return run('正在移回程序目录…', async () => {
      const result = await moveModelsDir(null)
      apply(result.snapshot)
      return result.moved ? { tone: 'success', text: '模型已移回程序目录下的 models 文件夹' } : null
    })
  }

  function importCustom(): Promise<void> {
    return run('请在弹出的窗口中选择 .onnx 模型文件…', async () => {
      const result = await importCustomModel()
      apply(result.snapshot)
      if (!result.imported) {
        return null
      }
      const name = result.snapshot.custom.find((item) => item.id === result.imported)?.name ?? '模型'
      return { tone: 'success', text: `已导入「${name}」，第一次使用时会自动识别放大倍数` }
    })
  }

  function renameCustom(id: string, name: string): Promise<void> {
    return run('', async () => {
      apply(await renameCustomModel(id, name))
      return null
    })
  }

  function removeCustom(id: string): Promise<void> {
    return run('正在删除…', async () => {
      apply(await deleteCustomModel(id))
      return { tone: 'success', text: '自定义模型已删除' }
    })
  }

  function openDir(): Promise<void> {
    return run('', async () => {
      await openModelsDir()
      return null
    })
  }

  onBeforeUnmount(() => {
    disposed = true
    window.clearTimeout(pollTimer)
  })

  void refresh()

  return {
    isAvailable: enabled,
    snapshot,
    loadError,
    actionStatus,
    isBusy,
    refresh,
    statusOf,
    download,
    pause,
    remove,
    changeDir,
    resetDir,
    openDir,
    importCustom,
    renameCustom,
    removeCustom,
  }
}
