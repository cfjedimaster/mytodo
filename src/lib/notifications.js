const ENABLED_KEY = 'mytodo-alerts-enabled'
const FIRED_KEY = 'mytodo-fired-reminders'
const MAX_FIRED_HISTORY = 100

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function getNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported'
  return Notification.permission
}

export function getAlertsPreference() {
  try {
    const val = localStorage.getItem(ENABLED_KEY)
    if (val === 'false') return false
    return true
  } catch {
    return true
  }
}

export function setAlertsPreference(enabled) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore restricted storage contexts
  }
}

export function isAlertsActive() {
  return getNotificationPermission() === 'granted' && getAlertsPreference()
}

export async function requestAlertsPermission() {
  if (!isNotificationSupported()) return 'unsupported'
  const result = await Notification.requestPermission()
  if (result === 'granted') {
    setAlertsPreference(true)
  }
  return result
}

export function subscribePermissionChanges(onChange) {
  if (!isNotificationSupported() || !navigator.permissions?.query) {
    return () => {}
  }

  let statusObj = null
  const handleChange = () => {
    onChange(getNotificationPermission())
  }

  navigator.permissions
    .query({ name: 'notifications' })
    .then(status => {
      statusObj = status
      status.addEventListener('change', handleChange)
    })
    .catch(() => {
      // Ignore browsers that do not support querying notifications permission
    })

  return () => {
    statusObj?.removeEventListener('change', handleChange)
  }
}

function loadFiredKeys() {
  try {
    const raw = localStorage.getItem(FIRED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveFiredKeys(keys) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(keys.slice(-MAX_FIRED_HISTORY)))
  } catch {
    // Ignore storage errors
  }
}

export function reminderKeyFor(todo) {
  return `${todo.id}:${todo.reminderAt || ''}`
}

export function hasReminderFired(todo) {
  const key = reminderKeyFor(todo)
  return loadFiredKeys().includes(key)
}

export function markReminderFired(todo) {
  const key = reminderKeyFor(todo)
  const keys = loadFiredKeys()
  if (!keys.includes(key)) {
    keys.push(key)
    saveFiredKeys(keys)
  }
}

export function clearFiredForTodo(todoId) {
  const prefix = `${todoId}:`
  const keys = loadFiredKeys().filter(key => !key.startsWith(prefix))
  saveFiredKeys(keys)
}

export async function dispatchReminderNotification(todo, { listName = 'Tasks', onOpen = null } = {}) {
  if (!isAlertsActive()) return false

  const noteSnippet = todo.note?.trim()
    ? todo.note.trim().slice(0, 110)
    : `From ${listName}`

  const options = {
    body: noteSnippet,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: `todo-reminder-${todo.id}`,
    renotify: true,
    data: { todoId: todo.id, url: `/app?task=${encodeURIComponent(todo.id)}` }
  }

  // Prefer Service Worker notifications when active (better mobile/installed app behavior)
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration?.active && typeof registration.showNotification === 'function') {
        await registration.showNotification(todo.title, options)
        return true
      }
    } catch {
      // Fall back to direct window Notification below
    }
  }

  try {
    const notification = new Notification(todo.title, options)
    notification.addEventListener('click', () => {
      window.focus()
      notification.close()
      if (typeof onOpen === 'function') onOpen()
    })
    return true
  } catch {
    return false
  }
}
