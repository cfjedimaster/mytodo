import './styles/theme.css'
import './styles/login.css'
import Alpine from 'alpinejs'
import { getAuthStatus, startGoogleLogin } from './lib/auth.js'
import { getResolvedTheme, setThemePreference, subscribeThemeChanges } from './lib/theme.js'
import { registerServiceWorker } from './lib/pwa.js'

registerServiceWorker()

function readAuthErrorFromUrl() {
  const searchParams = new URLSearchParams(window.location.search)
  const description = searchParams.get('error_description') || searchParams.get('error')
  return description ? description.replace(/\+/g, ' ') : ''
}

Alpine.data('loginPage', () => ({
  ready: false,
  loading: false,
  googleEnabled: false,
  theme: getResolvedTheme(),
  errorMessage: readAuthErrorFromUrl(),

  setTheme(nextTheme) {
    this.theme = setThemePreference(nextTheme)
  },

  async init() {
    subscribeThemeChanges(resolved => {
      this.theme = resolved
    })

    try {
      const { configured, user } = await getAuthStatus()
      if (user) {
        window.location.replace('/app')
        return
      }
      this.googleEnabled = configured
    } catch {
      this.googleEnabled = false
    }

    if (!this.googleEnabled && !this.errorMessage) {
      this.errorMessage = 'Sign-in is not configured yet.'
    }

    this.ready = true
  },

  signInWithGoogle() {
    if (this.loading || !this.googleEnabled) return
    this.loading = true
    this.errorMessage = ''
    startGoogleLogin()
  }
}))

Alpine.start()
