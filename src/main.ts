import { createApp } from 'vue'
import App from './App.vue'
import { loadInitialSettings } from './composables/useSettings'
import './styles/base.css'

// 先读设置再挂载：EXE 版设置在配置文件里，读取是异步的，避免首屏按默认值渲染后再跳变。
const initialSettings = await loadInitialSettings()

createApp(App, { initialSettings }).mount('#app')
