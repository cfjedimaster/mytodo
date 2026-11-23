import './styles/theme.css'
import './styles/marketing.css'
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

Alpine.data('marketingPage', () => ({
  ready: false,
  loading: false,
  googleEnabled: false,
  errorMessage: readAuthErrorFromUrl(),
  theme: getResolvedTheme(),

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

    this.ready = true
  },

  signInWithGoogle() {
    if (this.loading) return

    if (!this.googleEnabled) {
      this.errorMessage = 'Sign-in is not configured for this environment yet.'
      return
    }

    this.loading = true
    this.errorMessage = ''
    startGoogleLogin()
  }
}))

Alpine.start()
