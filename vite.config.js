import { defineConfig } from 'vite'
import { readdirSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const secretName = /^(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|\.npmrc|\.wrangler(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|.*\.(?:pem|crt|key|p12|pfx))$/i

export default defineConfig(({ mode }) => ({
  server: {
    // Vite 7 defaults are included explicitly because fs.deny replaces, rather than extends, them.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.dev.vars', '**/.dev.vars.*', '**/.npmrc', '**/.wrangler*', '**/credentials*', '**/secrets*', '**/id_rsa*', '**/*.{key,p12,pfx}'] },
    proxy: mode === 'real' ? { '/api': { target: `http://127.0.0.1:${process.env.LEIVRA_TEST_WORKER_PORT === '8791' ? 8791 : 8787}`, changeOrigin: true } } : undefined
  },
  plugins: [{
    name: 'reject-public-secrets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname
        try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) }
        catch { response.writeHead(400).end(); return }
        let forbidden = pathname.split('/').some(part => secretName.test(part))
        if (!forbidden && server.config.publicDir) {
          try {
            const root = realpathSync(server.config.publicDir)
            const target = realpathSync(resolve(root, '.' + pathname))
            forbidden = (target !== root && !target.startsWith(root + sep)) || target.slice(root.length + 1).split(sep).some(part => secretName.test(part))
          } catch { /* Missing public asset; Vite handles the request. */ }
        }
        if (forbidden) {
          response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
          return
        }
        next()
      })
    },
    configResolved(config) {
      if (!config.publicDir) return
      for (const entry of readdirSync(config.publicDir, { recursive: true, withFileTypes: true })) {
        if (entry.isSymbolicLink() || (entry.isFile() && secretName.test(entry.name))) throw new Error(`Secret-like file or symlink cannot be served from public/: ${entry.name}`)
      }
    }
  }, react(), tailwindcss(), VitePWA({
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
