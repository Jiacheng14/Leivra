import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => ({
  server: { proxy: mode === 'real' ? { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } } : undefined },
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['avatar.svg', 'user.svg'],
    manifest: {
      name: 'Leivra', short_name: 'Leivra', lang: 'zh-CN',
      description: '我的目光永远注视着你。人格聊天本地原型。',
      theme_color: '#78917e', background_color: '#f6f7f3',
      display: 'standalone', start_url: '/', scope: '/',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallbackDenylist: [/^\/api\//] }
  })]
}))
