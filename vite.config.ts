import { readFileSync } from 'node:fs'
import { defaultClientConditions, defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    // onnxruntime-web 用「外置 wasm」的版本：wasm 运行库由 EXE 启动器下载提供，不打进页面；
    // 胶水脚本 ort-wasm-simd-threaded.mjs 单独成文件，多线程时 onnxruntime 用它起子线程。
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: {
    format: 'es',
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
  },
})
