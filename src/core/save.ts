export interface SaveWritable {
  write(data: Blob): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface SaveFileHandle {
  createWritable(): Promise<SaveWritable>
}

interface SavePickerOptions {
  suggestedName: string
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type SavePicker = (options: SavePickerOptions) => Promise<SaveFileHandle>

type WindowWithSavePicker = Window & {
  showSaveFilePicker?: SavePicker
}

export interface SaveDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<SaveDirectoryHandle>

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: DirectoryPicker
}

/** 只有 Chromium 系浏览器支持系统保存对话框，其它浏览器回退到下载目录。 */
export function getSavePicker(): SavePicker | null {
  const picker = (window as WindowWithSavePicker).showSaveFilePicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

/** 批量导出选文件夹；同样只有 Chromium 系浏览器支持，其它浏览器逐个下载。 */
export function getDirectoryPicker(): (() => Promise<SaveDirectoryHandle>) | null {
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker
  return typeof picker === 'function' ? () => picker.call(window, { mode: 'readwrite' }) : null
}

/** 文件夹里是否已有同名文件；同名的子文件夹也算占用。 */
export async function hasEntry(directory: SaveDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name)
    return true
  } catch (error) {
    const errorName = (error as { name?: unknown } | null)?.name
    return errorName === 'TypeMismatchError'
  }
}

export function isSaveCanceled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

export async function writeBlobToHandle(
  handle: SaveFileHandle,
  blob: Blob,
): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (error) {
    try {
      await writable.abort?.()
    } catch {
      // 中断失败不能掩盖真正的写入错误。
    }
    throw error
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)

  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1500)
  }
}
