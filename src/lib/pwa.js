export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Ignore registration errors in restricted browsing contexts
    })
  })
}
