import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // CDN 基础路径，默认为 '/'
  // 设置后静态资源会从 CDN 加载
  const cdnBase = env.VITE_CDN_BASE?.trim().replace(/\/+$/, '') || ''
  const base = cdnBase ? `${cdnBase}/` : '/'

  return {
    plugins: [react()],
    base,
    build: {
      // 资源文件名带哈希，利于 CDN 缓存
      rollupOptions: {
        output: {
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
        },
      },
    },
  }
})
