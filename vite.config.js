import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const rootDir = dirname(fileURLToPath(import.meta.url))

function createCleanRoutesPlugin() {
  const attachCleanRoutes = server => {
    server.middlewares.use((req, _res, next) => {
      if (!req.url) return next()
      const [pathname, query] = req.url.split('?')
      const suffix = query ? `?${query}` : ''
      if (pathname === '/login' || pathname === '/login/') {
        req.url = `/login/index.html${suffix}`
      } else if (pathname === '/app' || pathname === '/app/') {
        req.url = `/app/index.html${suffix}`
      }
      next()
    })
  }

  return {
    name: 'mytodo-clean-routes',
    configureServer: attachCleanRoutes,
    configurePreviewServer: attachCleanRoutes
  }
}

function createPrecacheManifestPlugin() {
  return {
    name: 'mytodo-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter(fileName => fileName.startsWith('assets/'))
        .map(fileName => `/${fileName}`)
        .sort()

      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify({ assets }, null, 2)
      })
    }
  }
}

export default defineConfig({
  appType: 'mpa',
  plugins: [createCleanRoutesPlugin(), createPrecacheManifestPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        login: resolve(rootDir, 'login/index.html'),
        app: resolve(rootDir, 'app/index.html')
      }
    }
  }
})
