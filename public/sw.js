const CACHE_NAME = 'my-to-do-shell-v4'
const SHELL_URLS = [
  '/',
  '/app',
  '/app/',
  '/login',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
]

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME)
  const urls = new Set(SHELL_URLS)

  try {
    const manifestRes = await fetch('/precache-manifest.json', { cache: 'no-store' })
    if (manifestRes.ok) {
      const data = await manifestRes.json()
      if (Array.isArray(data?.assets)) {
        for (const assetUrl of data.assets) {
          if (typeof assetUrl === 'string' && assetUrl.startsWith('/')) {
            urls.add(assetUrl)
          }
        }
      }
    }
  } catch {
    // Manifest optional during dev or offline install
  }

  await Promise.allSettled(
    [...urls].map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    )
  )
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell())
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/precache-manifest.json') return
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/.netlify/') ||
    url.pathname === '/admin' ||
    url.pathname.startsWith('/admin/')
  ) {
    return
  }

  // Network-first for HTML navigations so auth redirects & fresh deploys work immediately
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {})
          }
          return response
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then(cached => cached || caches.match('/app') || caches.match('/app/'))
        )
    )
    return
  }

  // Stale-while-revalidate for static assets on the same origin
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webmanifest')
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request)
          .then(response => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {})
            }
            return response
          })
          .catch(() => cached)

        return cached || networkFetch
      })
    )
  }
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const todoId = event.notification.data?.todoId
  const targetUrl = event.notification.data?.url || '/app'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (new URL(client.url).pathname.startsWith('/app') && 'focus' in client) {
          client.focus()
          if (todoId) {
            client.postMessage({ type: 'OPEN_TODO', todoId })
          }
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
