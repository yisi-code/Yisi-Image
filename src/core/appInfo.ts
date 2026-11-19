export const APP_VERSION = __APP_VERSION__

/** EXE 启动器固定在本机这个端口提供页面与本地接口（更新检查、配置文件）。 */
export const DESKTOP_APP_PORT = '47831'

export const IS_DESKTOP_APP =
  typeof window !== 'undefined' && window.location.port === DESKTOP_APP_PORT
