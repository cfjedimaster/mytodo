import './styles/theme.css'
import './styles/admin.css'
import Alpine from 'alpinejs'
import { getResolvedTheme, setThemePreference, subscribeThemeChanges } from './lib/theme.js'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const numberFormatter = new Intl.NumberFormat()

Alpine.data('adminPage', () => ({
  ready: false,
  authenticated: false,
  loading: false,
  submitting: false,
  showPassword: false,
  password: '',
  errorMessage: '',
  report: null,
  theme: getResolvedTheme(),

  setTheme(nextTheme) {
    this.theme = setThemePreference(nextTheme)
  },

  formatNumber(value) {
    return typeof value === 'number' ? numberFormatter.format(value) : '0'
  },

  formatDateTime(isoString) {
    if (!isoString) return '—'
    const parsed = new Date(isoString)
    if (Number.isNaN(parsed.getTime())) return '—'
    return dateFormatter.format(parsed)
  },

  async init() {
    subscribeThemeChanges(resolved => {
      this.theme = resolved
    })

    await this.loadReport({ silentAuthFailure: true })
    this.ready = true

    if (!this.authenticated) {
      this.$nextTick(() => this.$refs.passwordInput?.focus())
    }
  },

  async loadReport({ silentAuthFailure = false } = {}) {
    this.loading = true
    if (!silentAuthFailure) {
      this.errorMessage = ''
    }

    try {
      const response = await fetch('/api/admin/report', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      })

      if (response.status === 401) {
        this.authenticated = false
        this.report = null
        if (!silentAuthFailure) {
          this.errorMessage = 'Your admin session expired. Please sign in again.'
        }
        return
      }

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to load report.')
      }

      this.report = data
      this.authenticated = true
      this.errorMessage = ''
    } catch (err) {
      if (!silentAuthFailure) {
        this.errorMessage = err?.message || 'Unable to load report.'
      }
    } finally {
      this.loading = false
    }
  },

  async submitPassword() {
    if (this.submitting || !this.password) return
    this.submitting = true
    this.errorMessage = ''

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: this.password })
      })

      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Invalid password.')
      }

      this.password = ''
      this.showPassword = false
      await this.loadReport()
    } catch (err) {
      this.errorMessage = err?.message || 'Unable to sign in.'
      this.$nextTick(() => this.$refs.passwordInput?.focus())
    } finally {
      this.submitting = false
    }
  },

  async signOut() {
    this.loading = true
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      })
    } finally {
      this.authenticated = false
      this.report = null
      this.errorMessage = ''
      this.loading = false
      this.$nextTick(() => this.$refs.passwordInput?.focus())
    }
  }
}))

Alpine.start()
