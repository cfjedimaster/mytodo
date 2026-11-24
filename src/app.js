import './styles/theme.css'
import './styles/app.css'
import Alpine from 'alpinejs'
import { getCurrentUser, signOutUser } from './lib/auth.js'
import { getResolvedTheme, setThemePreference, subscribeThemeChanges } from './lib/theme.js'
import { registerServiceWorker } from './lib/pwa.js'
import {
  clearFiredForTodo,
  dispatchReminderNotification,
  getAlertsPreference,
  getNotificationPermission,
  hasReminderFired,
  isNotificationSupported,
  markReminderFired,
  requestAlertsPermission,
  setAlertsPreference,
  subscribePermissionChanges
} from './lib/notifications.js'
import {
  advanceDueDate,
  advanceReminderAt,
  ensureTemporal,
  formatCreatedStamp,
  formatDueDate,
  formatMyDayHeading,
  formatReminder,
  formatRepeatLabel,
  fromDateTimeLocalValue,
  getNextWeekIso,
  getReminderPresetIso,
  getTodayIso,
  getTomorrowIso,
  isDueToday,
  isOverdue,
  isReminderPast,
  toDateTimeLocalValue
} from './lib/dates.js'
import {
  completeTodoWithRepeat,
  createGroup,
  createList,
  createStep,
  createTodo,
  deleteGroup,
  deleteList,
  deleteStep,
  deleteTodo,
  fetchWorkspaceData,
  restoreTodoSnapshot,
  updateGroup,
  updateList,
  updateStep,
  updateTodo
} from './lib/db.js'
import {
  clearUserOfflineData,
  enqueueMutation,
  getOutboxCount,
  loadCachedWorkspace,
  loadLastCachedWorkspace,
  saveCachedWorkspace
} from './lib/offline-store.js'
import { generateId, isNetworkError, syncOutbox } from './lib/sync.js'

registerServiceWorker()

const LIST_COLORS = ['pink', 'purple', 'blue', 'yellow', 'mint']

function installDialogLightDismissFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return

  const isOutside = (event, dialog) => {
    const rect = dialog.getBoundingClientRect()
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
  }

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false
    dialog.addEventListener('pointerdown', event => {
      pressedOutside = isOutside(event, dialog)
    })
    dialog.addEventListener('pointerup', event => {
      if (pressedOutside && isOutside(event, dialog)) {
        dialog.close()
      }
      pressedOutside = false
    })
  }
}

Alpine.data('todoApp', () => ({
  authReady: false,
  loadingWorkspace: true,
  loggingOut: false,
  user: null,
  theme: getResolvedTheme(),
  listColors: LIST_COLORS,

  // Offline & sync state
  isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  isSyncing: false,
  pendingSyncCount: 0,
  syncNeedsAuth: false,
  lastRefreshAt: 0,

  // Data collections
  groups: [],
  lists: [],
  todos: [],

  // Navigation & selection
  activeView: 'my-day', // 'my-day' | 'tasks' | 'list'
  activeListId: null,
  selectedTodoId: null,
  searchQuery: '',
  routeInitialized: false,

  // Quick-add state
  newTaskTitle: '',
  newTaskDueDate: '',
  newTaskReminderLocal: '',
  newTaskRepeat: '',
  addBarExpanded: false,
  creatingTask: false,

  // Detail pane state
  newStepTitle: '',
  savingStatus: '',
  errorMessage: '',
  detailSaveTimers: {},
  savedPulseTimer: null,

  // Date snapshots refreshed on init / midnight
  todayIso: '',
  tomorrowIso: '',
  nextWeekIso: '',
  myDayHeading: '',

  // Mobile layout & swipe drawer
  mobileView: 'list', // 'list' | 'detail'
  drawerVisible: false,
  drawerOpen: false,
  drawerObserver: null,
  drawerMediaQuery: null,

  // Dialog states
  dialogError: '',
  listDialog: { id: null, name: '', color: 'purple', groupId: '' },
  groupDialog: { id: null, name: '' },
  pendingDeleteList: null,
  pendingDeleteGroup: null,

  // Toast & desktop notification state
  toast: { visible: false, message: '', actionLabel: '', onAction: null },
  toastTimer: null,
  notifiedReminderIds: new Set(),
  reminderIntervalId: null,
  notificationSupported: isNotificationSupported(),
  notificationPermission: getNotificationPermission(),
  alertsEnabled: getAlertsPreference(),

  get alertsActive() {
    return this.notificationSupported && this.notificationPermission === 'granted' && this.alertsEnabled
  },

  get alertsButtonTitle() {
    if (this.notificationPermission === 'denied') return 'Desktop alerts blocked in site settings'
    if (this.notificationPermission !== 'granted') return 'Turn on desktop alerts'
    return this.alertsEnabled ? 'Desktop alerts on (click to mute)' : 'Desktop alerts muted (click to unmute)'
  },

  // Exposed date helpers for templates
  formatDueDate,
  formatReminder,
  formatRepeatLabel,
  formatCreatedStamp,
  toDateTimeLocalValue,
  isDueToday,
  isOverdue,
  isReminderPast,

  get userId() {
    return this.user?.id || null
  },

  get userProfileSnapshot() {
    if (!this.user?.id) return null
    return {
      id: this.user.id,
      email: this.user.email || '',
      user_metadata: {
        full_name: this.user.user_metadata?.full_name || ''
      }
    }
  },

  get showSyncBar() {
    return this.isOffline || this.isSyncing || this.pendingSyncCount > 0 || this.syncNeedsAuth
  },

  get syncBarTone() {
    if (this.syncNeedsAuth) return 'warning'
    if (this.isOffline) return 'offline'
    if (this.isSyncing) return 'syncing'
    if (this.pendingSyncCount > 0) return 'pending'
    return ''
  },

  get syncBarMessage() {
    if (this.syncNeedsAuth) {
      return 'Sign in again to finish syncing your offline changes.'
    }
    if (this.isOffline) {
      if (this.pendingSyncCount > 0) {
        const noun = this.pendingSyncCount === 1 ? 'change' : 'changes'
        return `Offline mode · ${this.pendingSyncCount} ${noun} waiting to sync`
      }
      return 'Offline mode · Changes save on this device and sync when back online'
    }
    if (this.isSyncing) {
      if (this.pendingSyncCount > 0) {
        const noun = this.pendingSyncCount === 1 ? 'change' : 'changes'
        return `Syncing ${this.pendingSyncCount} ${noun}…`
      }
      return 'Syncing changes…'
    }
    if (this.pendingSyncCount > 0) {
      const noun = this.pendingSyncCount === 1 ? 'change' : 'changes'
      return `${this.pendingSyncCount} ${noun} waiting to sync`
    }
    return ''
  },

  get userEmail() {
    return this.user?.email || ''
  },

  get userDisplayName() {
    return this.user?.user_metadata?.full_name || this.user?.email || 'Account'
  },

  get userInitial() {
    const label = this.userDisplayName.trim()
    return label ? label[0].toUpperCase() : 'U'
  },

  get isSearching() {
    return this.searchQuery.trim().length > 0
  },

  get currentList() {
    if (this.activeView !== 'list' || !this.activeListId) return null
    return this.lists.find(list => list.id === this.activeListId) ?? null
  },

  get ungroupedLists() {
    return this.lists.filter(list => !list.groupId)
  },

  listsInGroup(groupId) {
    return this.lists.filter(list => list.groupId === groupId)
  },

  get myDayCount() {
    return this.todos.filter(todo => !todo.isCompleted && isDueToday(todo.dueDate)).length
  },

  get defaultTasksCount() {
    return this.todos.filter(todo => !todo.isCompleted && !todo.listId).length
  },

  countForList(listId) {
    return this.todos.filter(todo => !todo.isCompleted && todo.listId === listId).length
  },

  get filteredTodos() {
    if (this.isSearching) {
      const q = this.searchQuery.trim().toLowerCase()
      return this.todos.filter(todo => {
        if (todo.title.toLowerCase().includes(q)) return true
        if (todo.note && todo.note.toLowerCase().includes(q)) return true
        if (todo.steps.some(step => step.title.toLowerCase().includes(q))) return true
        return false
      })
    }

    if (this.activeView === 'my-day') {
      return this.todos.filter(todo => isDueToday(todo.dueDate))
    }

    if (this.activeView === 'tasks') {
      return this.todos.filter(todo => !todo.listId)
    }

    if (this.activeView === 'list' && this.activeListId) {
      return this.todos.filter(todo => todo.listId === this.activeListId)
    }

    return []
  },

  get activeTodos() {
    return this.filteredTodos
      .filter(todo => !todo.isCompleted)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  },

  get completedTodos() {
    return this.filteredTodos
      .filter(todo => todo.isCompleted)
      .sort((a, b) => (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || ''))
  },

  get selectedTodo() {
    if (!this.selectedTodoId) return null
    return this.todos.find(todo => todo.id === this.selectedTodoId) ?? null
  },

  get viewTitle() {
    if (this.isSearching) return `Search: "${this.searchQuery.trim()}"`
    if (this.activeView === 'my-day') return 'My Day'
    if (this.activeView === 'tasks') return 'Tasks'
    return this.currentList?.name || 'List'
  },

  get viewSubtitle() {
    if (this.isSearching) {
      const total = this.activeTodos.length + this.completedTodos.length
      return total === 1 ? '1 matching task' : `${total} matching tasks`
    }
    if (this.activeView === 'my-day') {
      return this.myDayHeading
    }
    if (this.activeView === 'list' && this.currentList?.groupId) {
      const group = this.groups.find(g => g.id === this.currentList.groupId)
      const count = this.activeTodos.length
      const taskText = count === 1 ? '1 open task' : `${count} open tasks`
      return group ? `${group.name} · ${taskText}` : taskText
    }
    const count = this.activeTodos.length
    return count === 1 ? '1 open task' : `${count} open tasks`
  },

  get emptyHeading() {
    if (this.isSearching) return 'No matching tasks'
    if (this.activeView === 'my-day') return 'Nothing due today yet'
    return 'No tasks here yet'
  },

  get emptyDescription() {
    if (this.isSearching) return 'Try a different word from a title, step, or note.'
    if (this.activeView === 'my-day') return 'Add a task below and it will automatically get today’s due date.'
    return 'Use the bar below to add a task, break it into steps, or set a reminder.'
  },

  get deleteListMessage() {
    if (!this.pendingDeleteList) return ''
    const count = this.todos.filter(t => t.listId === this.pendingDeleteList.id).length
    if (count === 0) {
      return `"${this.pendingDeleteList.name}" has no tasks and will be permanently removed.`
    }
    const noun = count === 1 ? '1 task' : `${count} tasks`
    return `Deleting "${this.pendingDeleteList.name}" will also delete ${noun} inside it.`
  },

  get deleteGroupMessage() {
    if (!this.pendingDeleteGroup) return ''
    const listsCount = this.listsInGroup(this.pendingDeleteGroup.id).length
    if (listsCount === 0) {
      return `Delete the empty group "${this.pendingDeleteGroup.name}"?`
    }
    const noun = listsCount === 1 ? '1 list' : `${listsCount} lists`
    return `Deleting "${this.pendingDeleteGroup.name}" will keep its ${noun} and move them to your ungrouped lists.`
  },

  listNameFor(listId) {
    if (!listId) return 'Tasks'
    return this.lists.find(l => l.id === listId)?.name || 'Tasks'
  },

  listColorFor(listId) {
    if (!listId) return 'purple'
    return this.lists.find(l => l.id === listId)?.color || 'purple'
  },

  showListPill(todo) {
    return this.isSearching || this.activeView === 'my-day'
  },

  stepProgressText(todo) {
    const done = todo.steps.filter(s => s.isCompleted).length
    return `${done} of ${todo.steps.length}`
  },

  hasMeta(todo) {
    return Boolean(
      this.showListPill(todo) ||
      todo.steps.length > 0 ||
      todo.dueDate ||
      todo.reminderAt ||
      todo.repeatPattern ||
      (todo.note && todo.note.trim().length > 0)
    )
  },

  setTheme(nextTheme) {
    this.theme = setThemePreference(nextTheme)
  },

  refreshDateAnchors() {
    this.todayIso = getTodayIso()
    this.tomorrowIso = getTomorrowIso()
    this.nextWeekIso = getNextWeekIso()
    this.myDayHeading = formatMyDayHeading()
  },

  async init() {
    await ensureTemporal()
    this.refreshDateAnchors()

    subscribeThemeChanges(resolved => {
      this.theme = resolved
    })

    subscribePermissionChanges(permission => {
      this.notificationPermission = permission
    })

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'OPEN_TODO' && event.data.todoId) {
          this.openTodoById(event.data.todoId)
        }
      })
    }

    let currentUser = null
    let authError = null
    try {
      currentUser = await getCurrentUser()
    } catch (err) {
      authError = err
    }

    if (currentUser) {
      this.user = currentUser
      this.authReady = true
    } else if (!navigator.onLine || isNetworkError(authError)) {
      const cached = await loadLastCachedWorkspace()
      if (cached?.userId) {
        this.user = cached.userProfile || {
          id: cached.userId,
          email: '',
          user_metadata: {}
        }
        this.isOffline = true
        this.authReady = true
      } else {
        window.location.replace('/login')
        return
      }
    } else {
      window.location.replace('/login')
      return
    }

    this.setupConnectivityListeners()
    this.setupHistoryListener()

    this.$nextTick(() => {
      installDialogLightDismissFallback()
      this.setupDrawer()
    })

    await this.loadWorkspace()
    this.applyRouteFromUrl({ normalize: true })
    this.startReminderTicker()
  },

  setupConnectivityListeners() {
    window.addEventListener('online', () => {
      this.isOffline = false
      this.syncNow({ announce: true })
    })

    window.addEventListener('offline', () => {
      this.isOffline = true
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (!navigator.onLine) {
        this.isOffline = true
        return
      }
      this.isOffline = false
      if (this.pendingSyncCount > 0) {
        this.syncNow({ announce: true })
      } else if (Date.now() - this.lastRefreshAt > 30000) {
        this.refreshWorkspaceSilently()
      }
    })
  },

  shouldQueueLocally() {
    return this.isOffline || this.pendingSyncCount > 0 || this.syncNeedsAuth
  },

  async persistWorkspaceCache() {
    if (!this.userId) return
    await saveCachedWorkspace(this.userId, {
      groups: this.groups,
      lists: this.lists,
      todos: this.todos,
      userProfile: this.userProfileSnapshot
    })
  },

  async queueOfflineOp(op) {
    if (!this.userId) return
    this.pendingSyncCount = await enqueueMutation(this.userId, op)
    await this.persistWorkspaceCache()
  },

  applyWorkspaceData({ groups, lists, todos }) {
    this.groups = groups
    this.lists = lists
    this.todos = todos

    let routeChanged = false
    if (this.activeView === 'list' && this.activeListId && !lists.some(l => l.id === this.activeListId)) {
      this.activeView = 'tasks'
      this.activeListId = null
      routeChanged = true
    }
    if (this.selectedTodoId && !todos.some(t => t.id === this.selectedTodoId)) {
      this.selectedTodoId = null
      this.mobileView = 'list'
      routeChanged = true
    }
    if (this.routeInitialized) {
      if (routeChanged) {
        this.syncUrl({ replace: true })
      } else {
        this.updateDocumentTitle()
      }
    }
  },

  setupHistoryListener() {
    window.addEventListener('popstate', () => {
      this.flushPendingSaves()
      this.applyRouteFromUrl({ normalize: false, fromPopstate: true })
    })
  },

  buildCurrentUrl() {
    const params = new URLSearchParams()
    if (this.activeView === 'list' && this.activeListId) {
      params.set('list', this.activeListId)
    } else if (this.activeView === 'tasks') {
      params.set('view', 'tasks')
    } else if (this.selectedTodoId) {
      params.set('view', 'my-day')
    }

    if (this.selectedTodoId) {
      params.set('task', this.selectedTodoId)
    }

    const query = params.toString()
    return `${window.location.pathname}${query ? `?${query}` : ''}`
  },

  updateDocumentTitle() {
    const selected = this.selectedTodo
    const section = this.viewTitle
    if (selected?.title) {
      document.title = `${selected.title} — ${section} — My To Do`
    } else if (section) {
      document.title = `${section} — My To Do`
    } else {
      document.title = 'My To Do'
    }
  },

  syncUrl({ replace = false } = {}) {
    const nextUrl = this.buildCurrentUrl()
    const currentUrl = `${window.location.pathname}${window.location.search}`
    this.updateDocumentTitle()

    if (nextUrl === currentUrl) return
    if (replace) {
      window.history.replaceState({}, '', nextUrl)
    } else {
      window.history.pushState({}, '', nextUrl)
    }
  },

  applyRouteFromUrl({ normalize = true, fromPopstate = false } = {}) {
    const params = new URLSearchParams(window.location.search)
    const listParam = params.get('list')
    const viewParam = params.get('view')
    const taskParam = params.get('task')

    const matchedTask = taskParam
      ? this.todos.find(todo => todo.id === taskParam) ?? null
      : null

    this.searchQuery = ''

    if (listParam && this.lists.some(list => list.id === listParam)) {
      this.activeView = 'list'
      this.activeListId = listParam
    } else if (viewParam === 'tasks') {
      this.activeView = 'tasks'
      this.activeListId = null
    } else if (viewParam === 'my-day') {
      this.activeView = 'my-day'
      this.activeListId = null
    } else if (matchedTask) {
      if (matchedTask.listId && this.lists.some(list => list.id === matchedTask.listId)) {
        this.activeView = 'list'
        this.activeListId = matchedTask.listId
      } else if (isDueToday(matchedTask.dueDate)) {
        this.activeView = 'my-day'
        this.activeListId = null
      } else {
        this.activeView = 'tasks'
        this.activeListId = null
      }
    } else {
      this.activeView = 'my-day'
      this.activeListId = null
    }

    if (matchedTask) {
      this.selectedTodoId = matchedTask.id
      this.mobileView = 'detail'
      this.newStepTitle = ''
      this.savingStatus = ''
      if (matchedTask.isCompleted) {
        this.$nextTick(() => {
          if (this.$refs.completedDetails) {
            this.$refs.completedDetails.open = true
          }
        })
      }
    } else {
      this.selectedTodoId = null
      this.mobileView = 'list'
      this.collapseCompletedSection()
    }

    if (normalize || fromPopstate) {
      this.routeInitialized = true
    }

    if (normalize && !fromPopstate) {
      this.syncUrl({ replace: true })
    } else {
      this.updateDocumentTitle()
    }
  },

  openTodoById(todoId) {
    const target = this.todos.find(todo => todo.id === todoId)
    if (!target) return
    this.searchQuery = ''
    if (target.listId) {
      this.activeView = 'list'
      this.activeListId = target.listId
    } else if (isDueToday(target.dueDate)) {
      this.activeView = 'my-day'
      this.activeListId = null
    } else {
      this.activeView = 'tasks'
      this.activeListId = null
    }
    this.selectTodo(target.id)
  },

  async toggleDesktopAlerts() {
    if (!this.notificationSupported) return

    if (this.notificationPermission === 'denied') {
      this.showToast('Alerts are blocked in your site settings.', { durationMs: 4500 })
      return
    }

    if (this.notificationPermission !== 'granted') {
      const permission = await requestAlertsPermission()
      this.notificationPermission = permission
      if (permission === 'granted') {
        this.alertsEnabled = true
        this.showToast('Desktop alerts enabled.', { durationMs: 3500 })
      } else if (permission === 'denied') {
        this.showToast('Desktop alerts were blocked.', { durationMs: 4500 })
      }
      return
    }

    this.alertsEnabled = !this.alertsEnabled
    setAlertsPreference(this.alertsEnabled)
    this.showToast(this.alertsEnabled ? 'Desktop alerts unmuted.' : 'Desktop alerts muted.', {
      durationMs: 3000
    })
  },

  async loadWorkspace() {
    this.loadingWorkspace = true
    this.errorMessage = ''

    const cached = await loadCachedWorkspace(this.userId)
    this.pendingSyncCount = await getOutboxCount(this.userId)

    let hydratedFromCache = false
    if (cached) {
      this.applyWorkspaceData({
        groups: cached.groups || [],
        lists: cached.lists || [],
        todos: cached.todos || []
      })
      this.applyRouteFromUrl({ normalize: false })
      hydratedFromCache = true
      this.loadingWorkspace = false
    }

    if (!navigator.onLine) {
      this.isOffline = true
      this.loadingWorkspace = false
      if (!hydratedFromCache) {
        this.errorMessage = 'You are offline and no tasks are saved on this device yet.'
      }
      return
    }

    if (this.pendingSyncCount > 0) {
      await this.syncNow({ announce: true })
      this.loadingWorkspace = false
      return
    }

    try {
      const fresh = await fetchWorkspaceData()
      this.isOffline = false
      this.applyWorkspaceData(fresh)
      this.lastRefreshAt = Date.now()
      await this.persistWorkspaceCache()
    } catch (err) {
      if (isNetworkError(err)) {
        this.isOffline = true
        if (!hydratedFromCache) {
          this.errorMessage = 'You appear to be offline and no tasks are saved on this device yet.'
        }
      } else if (err?.status === 401 || err?.code === 'UNAUTHORIZED') {
        if (hydratedFromCache) {
          this.syncNeedsAuth = true
        } else {
          window.location.replace('/login')
          return
        }
      } else {
        console.error('Failed to load workspace:', err)
        if (!hydratedFromCache) {
          this.errorMessage = err.message || 'Unable to load your tasks right now.'
        }
      }
    } finally {
      this.loadingWorkspace = false
    }
  },

  async refreshWorkspaceSilently() {
    if (!this.userId || this.isOffline || this.isSyncing || this.pendingSyncCount > 0) return
    if (!navigator.onLine) {
      this.isOffline = true
      return
    }

    try {
      const fresh = await fetchWorkspaceData()
      this.isOffline = false
      this.applyWorkspaceData(fresh)
      this.lastRefreshAt = Date.now()
      await this.persistWorkspaceCache()
    } catch (err) {
      if (isNetworkError(err)) {
        this.isOffline = true
      } else if (err?.status === 401 || err?.code === 'UNAUTHORIZED') {
        this.syncNeedsAuth = true
      }
    }
  },

  async syncNow({ announce = true } = {}) {
    if (!this.userId || this.isSyncing) return

    await this.flushPendingSaves()

    if (!navigator.onLine) {
      this.isOffline = true
      return
    }

    this.isSyncing = true
    this.errorMessage = ''

    try {
      const result = await syncOutbox(this.userId)
      this.pendingSyncCount = result.remaining

      if (result.offline) {
        this.isOffline = true
        return
      }

      if (result.authError) {
        this.syncNeedsAuth = true
        return
      }

      this.syncNeedsAuth = false

      if (result.error) {
        console.error('Sync failed:', result.error)
        this.errorMessage = result.error.message || 'Some offline changes could not sync yet.'
        return
      }

      // Outbox is empty — fetch fresh workspace so desktop changes merge cleanly
      const fresh = await fetchWorkspaceData()
      this.isOffline = false
      this.applyWorkspaceData(fresh)
      this.lastRefreshAt = Date.now()
      await this.persistWorkspaceCache()

      if (announce && result.synced > 0) {
        if (result.rescuedTasks > 0) {
          const noun = result.rescuedTasks === 1 ? 'task' : 'tasks'
          this.showToast(
            `Synced! Moved ${result.rescuedTasks} ${noun} to Tasks because their list was deleted.`,
            { durationMs: 6500 }
          )
        } else if (result.ungroupedLists > 0) {
          const noun = result.ungroupedLists === 1 ? 'list' : 'lists'
          this.showToast(
            `Synced! Moved ${result.ungroupedLists} ${noun} out of a deleted group.`,
            { durationMs: 5500 }
          )
        } else {
          const noun = result.synced === 1 ? 'change' : 'changes'
          this.showToast(`Synced ${result.synced} offline ${noun}.`, { durationMs: 4000 })
        }
      }
    } catch (err) {
      if (isNetworkError(err)) {
        this.isOffline = true
      } else {
        console.error('Sync refresh failed:', err)
        this.errorMessage = err.message || 'Unable to finish syncing right now.'
      }
    } finally {
      this.isSyncing = false
    }
  },

  startReminderTicker() {
    const checkReminders = () => {
      this.refreshDateAnchors()
      const nowMs = Date.now()
      for (const todo of this.todos) {
        if (todo.isCompleted || !todo.reminderAt) continue
        if (this.notifiedReminderIds.has(todo.id) || hasReminderFired(todo)) continue
        const reminderMs = Date.parse(todo.reminderAt)
        if (Number.isNaN(reminderMs)) continue
        const diff = nowMs - reminderMs
        if (diff >= 0 && diff < 300000) {
          this.notifiedReminderIds.add(todo.id)
          markReminderFired(todo)
          dispatchReminderNotification(todo, {
            listName: this.listNameFor(todo.listId),
            onOpen: () => this.openTodoById(todo.id)
          })
          this.showToast(`Reminder: ${todo.title}`, {
            actionLabel: 'Open',
            durationMs: 9000,
            onAction: () => this.openTodoById(todo.id)
          })
          break
        }
      }
    }

    checkReminders()
    this.reminderIntervalId = window.setInterval(checkReminders, 10000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkReminders()
      }
    })
  },

  // ===========================
  // Navigation & Search
  // ===========================
  collapseCompletedSection() {
    this.$nextTick(() => {
      if (this.$refs.completedDetails) {
        this.$refs.completedDetails.open = false
      }
    })
  },

  selectView(view) {
    const switching = this.activeView !== view || this.activeListId !== null || this.isSearching
    if (switching && this.selectedTodoId) {
      this.flushPendingSaves()
      this.selectedTodoId = null
    }
    this.searchQuery = ''
    this.activeView = view
    this.activeListId = null
    this.mobileView = 'list'
    this.collapseCompletedSection()
    this.closeDrawer()
    this.syncUrl()
  },

  selectCustomList(listId) {
    const switching = this.activeView !== 'list' || this.activeListId !== listId || this.isSearching
    if (switching && this.selectedTodoId) {
      this.flushPendingSaves()
      this.selectedTodoId = null
    }
    this.searchQuery = ''
    this.activeView = 'list'
    this.activeListId = listId
    this.mobileView = 'list'
    this.collapseCompletedSection()
    this.closeDrawer()
    this.syncUrl()
  },

  onSearchInput() {
    this.collapseCompletedSection()
  },

  submitSearch() {
    if (this.isSearching) {
      this.closeDrawer()
    }
  },

  clearSearch({ focusInput = false } = {}) {
    this.searchQuery = ''
    this.collapseCompletedSection()
    if (focusInput) {
      this.$nextTick(() => this.$refs.searchInput?.focus())
    }
  },

  selectTodo(todoId) {
    this.selectedTodoId = todoId
    this.mobileView = 'detail'
    this.newStepTitle = ''
    this.savingStatus = ''
    this.syncUrl()
  },

  closeDetail() {
    this.flushPendingSaves()
    this.selectedTodoId = null
    this.mobileView = 'list'
    this.syncUrl()
  },

  // ===========================
  // Task CRUD
  // ===========================
  async submitNewTask() {
    const title = this.newTaskTitle.trim()
    if (!title || this.creatingTask) return

    this.creatingTask = true
    this.errorMessage = ''

    const id = generateId()
    const now = new Date().toISOString()
    const listId = this.activeView === 'list' ? this.activeListId : null
    const dueDate =
      this.newTaskDueDate || (this.activeView === 'my-day' ? getTodayIso() : null)
    const reminderAt = this.newTaskReminderLocal
      ? fromDateTimeLocalValue(this.newTaskReminderLocal)
      : null
    const repeatPattern = this.newTaskRepeat || null

    const localTodo = {
      id,
      listId,
      title,
      note: '',
      isCompleted: false,
      completedAt: null,
      dueDate,
      reminderAt,
      repeatPattern,
      position: 0,
      createdAt: now,
      updatedAt: now,
      steps: []
    }

    const applyOffline = async () => {
      this.todos.unshift(localTodo)
      await this.queueOfflineOp({
        entity: 'todo',
        action: 'create',
        entityId: id,
        payload: {
          title,
          listId,
          dueDate,
          reminderAt,
          repeatPattern,
          note: '',
          isCompleted: false,
          completedAt: null,
          position: 0
        }
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          const created = await createTodo({
            id,
            title,
            listId,
            dueDate,
            reminderAt,
            repeatPattern
          })
          this.todos.unshift(created)
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }

      this.newTaskTitle = ''
      this.newTaskDueDate = ''
      this.newTaskReminderLocal = ''
      this.newTaskRepeat = ''
      this.$nextTick(() => {
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
        this.$refs.tasksScroller?.scrollTo({ top: 0, behavior })
        this.$refs.newTaskInput?.focus()
      })
    } catch (err) {
      console.error('Create task failed:', err)
      this.errorMessage = err.message || 'Unable to add task.'
    } finally {
      this.creatingTask = false
    }
  },

  async toggleTodo(todo) {
    const wasCompleted = todo.isCompleted
    this.errorMessage = ''

    const applyOffline = async () => {
      const now = new Date().toISOString()
      if (!wasCompleted) {
        const updatedLocal = {
          ...todo,
          isCompleted: true,
          completedAt: now,
          updatedAt: now
        }
        this.replaceTodo(updatedLocal)
        await this.queueOfflineOp({
          entity: 'todo',
          action: 'update',
          entityId: todo.id,
          payload: { isCompleted: true, completedAt: now }
        })

        if (todo.repeatPattern) {
          const nextId = generateId()
          const nextDueDate = advanceDueDate(todo.dueDate, todo.repeatPattern)
          const nextReminderAt = advanceReminderAt(todo.reminderAt, todo.repeatPattern)
          const nextSteps = (todo.steps || []).map((step, index) => ({
            id: generateId(),
            todoId: nextId,
            title: step.title,
            isCompleted: false,
            position: index,
            createdAt: now
          }))
          const nextLocal = {
            id: nextId,
            listId: todo.listId,
            title: todo.title,
            note: todo.note,
            isCompleted: false,
            completedAt: null,
            dueDate: nextDueDate,
            reminderAt: nextReminderAt,
            repeatPattern: todo.repeatPattern,
            position: 0,
            createdAt: now,
            updatedAt: now,
            steps: nextSteps
          }
          this.todos.unshift(nextLocal)
          await this.queueOfflineOp({
            entity: 'todo',
            action: 'create',
            entityId: nextId,
            payload: {
              title: nextLocal.title,
              listId: nextLocal.listId,
              dueDate: nextLocal.dueDate,
              reminderAt: nextLocal.reminderAt,
              repeatPattern: nextLocal.repeatPattern,
              note: nextLocal.note,
              isCompleted: false,
              completedAt: null,
              position: 0,
              sourceRepeatTodoId: todo.id
            }
          })
          for (const step of nextSteps) {
            await this.queueOfflineOp({
              entity: 'step',
              action: 'create',
              entityId: step.id,
              parentId: nextId,
              payload: {
                title: step.title,
                isCompleted: false,
                position: step.position
              }
            })
          }
          this.showToast(
            `Next ${formatRepeatLabel(nextLocal.repeatPattern).toLowerCase()} task scheduled for ${formatDueDate(nextLocal.dueDate)}.`,
            { durationMs: 4500 }
          )
        }
      } else {
        const updatedLocal = {
          ...todo,
          isCompleted: false,
          completedAt: null,
          updatedAt: now
        }
        this.replaceTodo(updatedLocal)
        await this.queueOfflineOp({
          entity: 'todo',
          action: 'update',
          entityId: todo.id,
          payload: { isCompleted: false, completedAt: null }
        })
      }
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
        return
      }

      try {
        if (!wasCompleted) {
          const { updatedTodo, nextTodo } = await completeTodoWithRepeat(todo)
          this.replaceTodo(updatedTodo)
          if (nextTodo) {
            this.todos.unshift(nextTodo)
            this.showToast(
              `Next ${formatRepeatLabel(nextTodo.repeatPattern).toLowerCase()} task scheduled for ${formatDueDate(nextTodo.dueDate)}.`,
              { durationMs: 4500 }
            )
          }
        } else {
          const updatedTodo = await updateTodo(todo.id, { isCompleted: false })
          this.replaceTodo(updatedTodo)
        }
        await this.persistWorkspaceCache()
      } catch (err) {
        if (isNetworkError(err)) {
          this.isOffline = true
          await applyOffline()
        } else {
          throw err
        }
      }
    } catch (err) {
      console.error('Toggle task failed:', err)
      this.errorMessage = err.message || 'Unable to update task.'
    }
  },

  replaceTodo(updated) {
    const idx = this.todos.findIndex(t => t.id === updated.id)
    if (idx !== -1) {
      this.todos.splice(idx, 1, updated)
    }
  },

  scheduleDetailSave(todo) {
    if (!todo) return
    const id = todo.id
    this.savingStatus = 'Saving…'
    clearTimeout(this.detailSaveTimers[id])
    this.detailSaveTimers[id] = window.setTimeout(() => {
      this.persistTodoText(id)
    }, 450)
  },

  flushDetailSave(todo) {
    if (!todo) return
    const id = todo.id
    if (this.detailSaveTimers[id]) {
      clearTimeout(this.detailSaveTimers[id])
      delete this.detailSaveTimers[id]
      return this.persistTodoText(id)
    }
  },

  flushPendingSaves() {
    const promises = []
    for (const id of Object.keys(this.detailSaveTimers)) {
      clearTimeout(this.detailSaveTimers[id])
      delete this.detailSaveTimers[id]
      promises.push(this.persistTodoText(id))
    }
    return Promise.all(promises)
  },

  async persistTodoText(todoId) {
    const todo = this.todos.find(t => t.id === todoId)
    if (!todo) return
    const trimmedTitle = todo.title.trim()
    if (!trimmedTitle) return

    const patch = {
      title: trimmedTitle,
      note: todo.note
    }

    const applyOffline = async () => {
      todo.title = trimmedTitle
      todo.updatedAt = new Date().toISOString()
      await this.queueOfflineOp({
        entity: 'todo',
        action: 'update',
        entityId: todo.id,
        payload: patch
      })
      this.pulseSaved()
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
        return
      }

      try {
        const updated = await updateTodo(todo.id, patch)
        todo.updatedAt = updated.updatedAt
        await this.persistWorkspaceCache()
        this.pulseSaved()
      } catch (err) {
        if (isNetworkError(err)) {
          this.isOffline = true
          await applyOffline()
        } else {
          throw err
        }
      }
    } catch (err) {
      console.error('Save task failed:', err)
      this.savingStatus = ''
      this.errorMessage = err.message || 'Unable to save changes.'
    }
  },

  pulseSaved() {
    this.savingStatus = this.isOffline ? '✓ Saved offline' : '✓ Saved'
    clearTimeout(this.savedPulseTimer)
    this.savedPulseTimer = window.setTimeout(() => {
      this.savingStatus = ''
    }, 2000)
  },

  async patchSelectedTodo(todo, patch, errorFallback) {
    if (!todo) return
    this.errorMessage = ''

    const applyOffline = async () => {
      const updatedLocal = {
        ...todo,
        ...patch,
        updatedAt: new Date().toISOString()
      }
      this.replaceTodo(updatedLocal)
      await this.queueOfflineOp({
        entity: 'todo',
        action: 'update',
        entityId: todo.id,
        payload: patch
      })
      this.pulseSaved()
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
        return
      }

      try {
        const updated = await updateTodo(todo.id, patch)
        this.replaceTodo(updated)
        await this.persistWorkspaceCache()
        this.pulseSaved()
      } catch (err) {
        if (isNetworkError(err)) {
          this.isOffline = true
          await applyOffline()
        } else {
          throw err
        }
      }
    } catch (err) {
      this.errorMessage = err.message || errorFallback
    }
  },

  async setSelectedDueDate(dueDateIso) {
    await this.patchSelectedTodo(
      this.selectedTodo,
      { dueDate: dueDateIso || null },
      'Unable to update due date.'
    )
  },

  async setSelectedReminder(reminderIso) {
    const todo = this.selectedTodo
    if (!todo) return
    this.notifiedReminderIds.delete(todo.id)
    clearFiredForTodo(todo.id)
    await this.patchSelectedTodo(
      todo,
      { reminderAt: reminderIso || null },
      'Unable to update reminder.'
    )
  },

  setSelectedReminderFromLocal(localValue) {
    const iso = localValue ? fromDateTimeLocalValue(localValue) : null
    this.setSelectedReminder(iso)
  },

  applyReminderPreset(preset) {
    const iso = getReminderPresetIso(preset)
    if (iso) {
      this.setSelectedReminder(iso)
    }
  },

  async setSelectedRepeat(pattern) {
    const todo = this.selectedTodo
    if (!todo) return
    const patch = { repeatPattern: pattern || null }
    if (pattern && !todo.dueDate) {
      patch.dueDate = getTodayIso()
    }
    await this.patchSelectedTodo(todo, patch, 'Unable to update repeat schedule.')
  },

  async moveSelectedTodoToList(listId) {
    await this.patchSelectedTodo(
      this.selectedTodo,
      { listId: listId || null },
      'Unable to move task.'
    )
  },

  async restoreOfflineSnapshot(snapshot) {
    const now = new Date().toISOString()
    const newId = generateId()
    const restoredSteps = (snapshot.steps || []).map((step, index) => ({
      id: generateId(),
      todoId: newId,
      title: step.title,
      isCompleted: Boolean(step.isCompleted),
      position: index,
      createdAt: now
    }))

    const restored = {
      id: newId,
      listId: snapshot.listId || null,
      title: snapshot.title,
      note: snapshot.note || '',
      isCompleted: Boolean(snapshot.isCompleted),
      completedAt: snapshot.isCompleted ? (snapshot.completedAt || now) : null,
      dueDate: snapshot.dueDate || null,
      reminderAt: snapshot.reminderAt || null,
      repeatPattern: snapshot.repeatPattern || null,
      position: snapshot.position ?? 0,
      createdAt: now,
      updatedAt: now,
      steps: restoredSteps
    }

    this.todos.unshift(restored)
    await this.queueOfflineOp({
      entity: 'todo',
      action: 'create',
      entityId: newId,
      payload: {
        title: restored.title,
        listId: restored.listId,
        dueDate: restored.dueDate,
        reminderAt: restored.reminderAt,
        repeatPattern: restored.repeatPattern,
        note: restored.note,
        isCompleted: restored.isCompleted,
        completedAt: restored.completedAt,
        position: restored.position
      }
    })
    for (const step of restoredSteps) {
      await this.queueOfflineOp({
        entity: 'step',
        action: 'create',
        entityId: step.id,
        parentId: newId,
        payload: {
          title: step.title,
          isCompleted: step.isCompleted,
          position: step.position
        }
      })
    }
    return restored
  },

  async deleteSelectedTodo() {
    const todo = this.selectedTodo
    if (!todo) return
    const snapshot = JSON.parse(JSON.stringify(todo))
    this.errorMessage = ''

    const removeLocal = () => {
      this.todos = this.todos.filter(t => t.id !== todo.id)
      this.selectedTodoId = null
      this.mobileView = 'list'
      this.syncUrl({ replace: true })
    }

    const applyOffline = async () => {
      removeLocal()
      await this.queueOfflineOp({
        entity: 'todo',
        action: 'delete',
        entityId: todo.id
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          await deleteTodo(todo.id)
          removeLocal()
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }

      this.showToast('Task deleted.', {
        actionLabel: 'Undo',
        durationMs: 6000,
        onAction: async () => {
          try {
            if (this.shouldQueueLocally()) {
              const restored = await this.restoreOfflineSnapshot(snapshot)
              this.selectTodo(restored.id)
              return
            }
            try {
              const restored = await restoreTodoSnapshot(snapshot)
              this.todos.unshift(restored)
              await this.persistWorkspaceCache()
              this.selectTodo(restored.id)
            } catch (err) {
              if (isNetworkError(err)) {
                this.isOffline = true
                const restored = await this.restoreOfflineSnapshot(snapshot)
                this.selectTodo(restored.id)
              } else {
                throw err
              }
            }
          } catch (err) {
            this.errorMessage = err.message || 'Unable to restore task.'
          }
        }
      })
    } catch (err) {
      this.errorMessage = err.message || 'Unable to delete task.'
    }
  },

  // ===========================
  // Steps CRUD
  // ===========================
  async addStepToSelected() {
    const todo = this.selectedTodo
    const title = this.newStepTitle.trim()
    if (!todo || !title) return

    this.errorMessage = ''
    const id = generateId()
    const position = todo.steps.length
    const localStep = {
      id,
      todoId: todo.id,
      title,
      isCompleted: false,
      position,
      createdAt: new Date().toISOString()
    }

    const applyOffline = async () => {
      todo.steps.push(localStep)
      await this.queueOfflineOp({
        entity: 'step',
        action: 'create',
        entityId: id,
        parentId: todo.id,
        payload: {
          title,
          isCompleted: false,
          position
        }
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          const step = await createStep({
            id,
            todoId: todo.id,
            title,
            position
          })
          todo.steps.push(step)
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
      this.newStepTitle = ''
      this.pulseSaved()
    } catch (err) {
      this.errorMessage = err.message || 'Unable to add step.'
    }
  },

  async toggleStep(todo, step) {
    this.errorMessage = ''
    const nextCompleted = !step.isCompleted

    const applyOffline = async () => {
      const updatedLocal = { ...step, isCompleted: nextCompleted }
      const idx = todo.steps.findIndex(s => s.id === step.id)
      if (idx !== -1) todo.steps.splice(idx, 1, updatedLocal)
      await this.queueOfflineOp({
        entity: 'step',
        action: 'update',
        entityId: step.id,
        parentId: todo.id,
        payload: { isCompleted: nextCompleted }
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          const updated = await updateStep(step.id, { isCompleted: nextCompleted })
          const idx = todo.steps.findIndex(s => s.id === step.id)
          if (idx !== -1) todo.steps.splice(idx, 1, updated)
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
      this.pulseSaved()
    } catch (err) {
      this.errorMessage = err.message || 'Unable to update step.'
    }
  },

  async saveStepTitle(step) {
    const trimmed = step.title.trim()
    if (!trimmed) return

    const applyOffline = async () => {
      step.title = trimmed
      await this.queueOfflineOp({
        entity: 'step',
        action: 'update',
        entityId: step.id,
        parentId: step.todoId,
        payload: { title: trimmed }
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          await updateStep(step.id, { title: trimmed })
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
      this.pulseSaved()
    } catch (err) {
      this.errorMessage = err.message || 'Unable to rename step.'
    }
  },

  async removeStep(todo, step) {
    this.errorMessage = ''

    const applyOffline = async () => {
      todo.steps = todo.steps.filter(s => s.id !== step.id)
      await this.queueOfflineOp({
        entity: 'step',
        action: 'delete',
        entityId: step.id,
        parentId: todo.id
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          await deleteStep(step.id)
          todo.steps = todo.steps.filter(s => s.id !== step.id)
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
      this.pulseSaved()
    } catch (err) {
      this.errorMessage = err.message || 'Unable to remove step.'
    }
  },

  // ===========================
  // Custom Lists & Groups Dialogs
  // ===========================
  openListDialog(list) {
    this.dialogError = ''
    if (list) {
      this.listDialog = {
        id: list.id,
        name: list.name,
        color: list.color || 'purple',
        groupId: list.groupId || ''
      }
    } else {
      this.listDialog = {
        id: null,
        name: '',
        color: LIST_COLORS[this.lists.length % LIST_COLORS.length],
        groupId: ''
      }
    }
    this.$refs.listDialog?.showModal()
    this.$nextTick(() => this.$refs.listNameInput?.focus())
  },

  async saveListDialog() {
    const name = this.listDialog.name.trim()
    if (!name) {
      this.dialogError = 'Please enter a list name.'
      return
    }
    this.dialogError = ''

    const color = this.listDialog.color
    const groupId = this.listDialog.groupId || null

    try {
      if (this.listDialog.id) {
        const id = this.listDialog.id
        const existing = this.lists.find(l => l.id === id)
        const applyOffline = async () => {
          const updatedLocal = {
            ...(existing || { id, position: 0, createdAt: new Date().toISOString() }),
            name,
            color,
            groupId
          }
          const idx = this.lists.findIndex(l => l.id === id)
          if (idx !== -1) this.lists.splice(idx, 1, updatedLocal)
          await this.queueOfflineOp({
            entity: 'list',
            action: 'update',
            entityId: id,
            payload: { name, color, groupId }
          })
        }

        if (this.shouldQueueLocally()) {
          await applyOffline()
        } else {
          try {
            const updated = await updateList({ id, name, color, groupId })
            const idx = this.lists.findIndex(l => l.id === updated.id)
            if (idx !== -1) this.lists.splice(idx, 1, updated)
            await this.persistWorkspaceCache()
          } catch (err) {
            if (isNetworkError(err)) {
              this.isOffline = true
              await applyOffline()
            } else {
              throw err
            }
          }
        }
      } else {
        const id = generateId()
        const position = this.lists.length
        const localList = {
          id,
          groupId,
          name,
          color,
          position,
          createdAt: new Date().toISOString()
        }

        const applyOffline = async () => {
          this.lists.push(localList)
          this.selectCustomList(id)
          await this.queueOfflineOp({
            entity: 'list',
            action: 'create',
            entityId: id,
            payload: { name, color, groupId, position }
          })
        }

        if (this.shouldQueueLocally()) {
          await applyOffline()
        } else {
          try {
            const created = await createList({ id, name, color, groupId, position })
            this.lists.push(created)
            this.selectCustomList(created.id)
            await this.persistWorkspaceCache()
          } catch (err) {
            if (isNetworkError(err)) {
              this.isOffline = true
              await applyOffline()
            } else {
              throw err
            }
          }
        }
      }
      this.$refs.listDialog?.close()
    } catch (err) {
      this.dialogError = err.message || 'Unable to save list.'
    }
  },

  switchToDeleteList() {
    const list = this.lists.find(l => l.id === this.listDialog.id)
    this.$refs.listDialog?.close()
    if (list) this.openDeleteListDialog(list)
  },

  openDeleteListDialog(list) {
    this.dialogError = ''
    this.pendingDeleteList = list
    this.$refs.deleteListDialog?.showModal()
  },

  async confirmDeleteList() {
    const target = this.pendingDeleteList
    if (!target) return
    this.dialogError = ''

    const cascadeTodoIds = this.todos.filter(t => t.listId === target.id).map(t => t.id)

    const removeLocal = () => {
      this.lists = this.lists.filter(l => l.id !== target.id)
      this.todos = this.todos.filter(t => t.listId !== target.id)
      if (this.selectedTodoId && !this.todos.some(t => t.id === this.selectedTodoId)) {
        this.selectedTodoId = null
        this.mobileView = 'list'
      }
      if (this.activeView === 'list' && this.activeListId === target.id) {
        this.activeView = 'tasks'
        this.activeListId = null
      }
      this.syncUrl({ replace: true })
      this.pendingDeleteList = null
      this.$refs.deleteListDialog?.close()
    }

    const applyOffline = async () => {
      removeLocal()
      await this.queueOfflineOp({
        entity: 'list',
        action: 'delete',
        entityId: target.id,
        cascadeTodoIds
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          await deleteList(target.id)
          removeLocal()
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
    } catch (err) {
      this.dialogError = err.message || 'Unable to delete list.'
    }
  },

  openGroupDialog(group) {
    this.dialogError = ''
    if (group) {
      this.groupDialog = { id: group.id, name: group.name }
    } else {
      this.groupDialog = { id: null, name: '' }
    }
    this.$refs.groupDialog?.showModal()
    this.$nextTick(() => this.$refs.groupNameInput?.focus())
  },

  async saveGroupDialog() {
    const name = this.groupDialog.name.trim()
    if (!name) {
      this.dialogError = 'Please enter a group name.'
      return
    }
    this.dialogError = ''

    try {
      if (this.groupDialog.id) {
        const id = this.groupDialog.id
        const existing = this.groups.find(g => g.id === id)
        const applyOffline = async () => {
          const updatedLocal = {
            ...(existing || { id, position: 0, createdAt: new Date().toISOString() }),
            name
          }
          const idx = this.groups.findIndex(g => g.id === id)
          if (idx !== -1) this.groups.splice(idx, 1, updatedLocal)
          await this.queueOfflineOp({
            entity: 'group',
            action: 'update',
            entityId: id,
            payload: { name }
          })
        }

        if (this.shouldQueueLocally()) {
          await applyOffline()
        } else {
          try {
            const updated = await updateGroup({ id, name })
            const idx = this.groups.findIndex(g => g.id === updated.id)
            if (idx !== -1) this.groups.splice(idx, 1, updated)
            await this.persistWorkspaceCache()
          } catch (err) {
            if (isNetworkError(err)) {
              this.isOffline = true
              await applyOffline()
            } else {
              throw err
            }
          }
        }
      } else {
        const id = generateId()
        const position = this.groups.length
        const localGroup = {
          id,
          name,
          position,
          createdAt: new Date().toISOString()
        }

        const applyOffline = async () => {
          this.groups.push(localGroup)
          await this.queueOfflineOp({
            entity: 'group',
            action: 'create',
            entityId: id,
            payload: { name, position }
          })
        }

        if (this.shouldQueueLocally()) {
          await applyOffline()
        } else {
          try {
            const created = await createGroup({ id, name, position })
            this.groups.push(created)
            await this.persistWorkspaceCache()
          } catch (err) {
            if (isNetworkError(err)) {
              this.isOffline = true
              await applyOffline()
            } else {
              throw err
            }
          }
        }
      }
      this.$refs.groupDialog?.close()
    } catch (err) {
      this.dialogError = err.message || 'Unable to save group.'
    }
  },

  switchToDeleteGroup() {
    const group = this.groups.find(g => g.id === this.groupDialog.id)
    this.$refs.groupDialog?.close()
    if (group) this.openDeleteGroupDialog(group)
  },

  openDeleteGroupDialog(group) {
    this.dialogError = ''
    this.pendingDeleteGroup = group
    this.$refs.deleteGroupDialog?.showModal()
  },

  async confirmDeleteGroup() {
    const target = this.pendingDeleteGroup
    if (!target) return
    this.dialogError = ''

    const removeLocal = () => {
      this.groups = this.groups.filter(g => g.id !== target.id)
      this.lists = this.lists.map(list =>
        list.groupId === target.id ? { ...list, groupId: null } : list
      )
      this.pendingDeleteGroup = null
      this.$refs.deleteGroupDialog?.close()
    }

    const applyOffline = async () => {
      removeLocal()
      await this.queueOfflineOp({
        entity: 'group',
        action: 'delete',
        entityId: target.id
      })
    }

    try {
      if (this.shouldQueueLocally()) {
        await applyOffline()
      } else {
        try {
          await deleteGroup(target.id)
          removeLocal()
          await this.persistWorkspaceCache()
        } catch (err) {
          if (isNetworkError(err)) {
            this.isOffline = true
            await applyOffline()
          } else {
            throw err
          }
        }
      }
    } catch (err) {
      this.dialogError = err.message || 'Unable to delete group.'
    }
  },

  // ===========================
  // Toast & Keyboard Shortcuts
  // ===========================
  showToast(message, { actionLabel = '', onAction = null, durationMs = 5000 } = {}) {
    clearTimeout(this.toastTimer)
    this.toast = { visible: true, message, actionLabel, onAction }
    this.toastTimer = window.setTimeout(() => {
      this.toast.visible = false
    }, durationMs)
  },

  async runToastAction() {
    const action = this.toast.onAction
    clearTimeout(this.toastTimer)
    this.toast.visible = false
    if (typeof action === 'function') {
      await action()
    }
  },

  handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
      if (this.drawerOpen) {
        this.closeDrawer()
      } else if (this.selectedTodoId && !document.querySelector('dialog[open]')) {
        this.closeDetail()
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (this.drawerMediaQuery?.matches && !this.drawerOpen) {
        this.openDrawer()
      }
      this.$nextTick(() => this.$refs.searchInput?.focus())
    }
  },

  // ===========================
  // Responsive Navigation Drawer (Modern Web Guidance pattern)
  // ===========================
  setupDrawer() {
    const drawer = this.$refs.sidebarDrawer
    const scroller = this.$refs.sidebarScroller
    const sheet = this.$refs.sidebarSheet
    if (!drawer || !scroller || !sheet) return

    this.drawerMediaQuery = window.matchMedia('(max-width: 960px)')
    this.drawerMediaQuery.addEventListener('change', event => {
      if (!event.matches) {
        this.drawerVisible = false
        this.drawerOpen = false
      }
    })

    if (!CSS.supports('animation-timeline: scroll()')) {
      scroller.addEventListener('scroll', () => {
        if (!this.drawerVisible || !sheet.offsetWidth) return
        const ratio = Math.max(0, Math.min(1, 1 - scroller.scrollLeft / sheet.offsetWidth))
        drawer.style.setProperty('--drawer-backdrop', String(ratio))
      })
    }

    const visibleThreshold = 0.02
    this.drawerObserver = new IntersectionObserver(
      entries => {
        if (!this.drawerVisible) return
        const entry = entries.at(-1)
        if (!entry) return
        if (entry.intersectionRatio < visibleThreshold && this.drawerOpen) {
          this.drawerVisible = false
          this.drawerOpen = false
          this.$refs.drawerToggle?.focus()
        } else if (entry.intersectionRatio >= 0.98) {
          this.drawerOpen = true
        }
      },
      { root: drawer, threshold: [visibleThreshold, 0.98] }
    )
    this.drawerObserver.observe(sheet)
  },

  openDrawer() {
    if (!this.drawerMediaQuery?.matches) return
    const scroller = this.$refs.sidebarScroller
    const sheet = this.$refs.sidebarSheet
    if (!scroller || !sheet) return

    this.drawerVisible = true
    this.$nextTick(() => {
      if (!CSS.supports('scroll-initial-target', 'nearest')) {
        scroller.scrollTo({ left: sheet.offsetWidth, behavior: 'instant' })
      }
      requestAnimationFrame(() => {
        scroller.scrollTo({ left: 0, behavior: 'auto' })
        this.drawerOpen = true
        sheet.focus()
      })
    })
  },

  closeDrawer() {
    if (!this.drawerVisible) return
    const scroller = this.$refs.sidebarScroller
    const sheet = this.$refs.sidebarSheet
    if (!scroller || !sheet) {
      this.drawerVisible = false
      this.drawerOpen = false
      return
    }
    scroller.scrollTo({ left: sheet.offsetWidth, behavior: 'auto' })
  },

  handleDrawerBackdropClick(event) {
    if (!this.drawerVisible) return
    const sheet = this.$refs.sidebarSheet
    if (sheet && !sheet.contains(event.target)) {
      this.closeDrawer()
    }
  },

  async logout() {
    if (this.loggingOut) return

    await this.flushPendingSaves()

    if (this.pendingSyncCount > 0 && (this.isOffline || !navigator.onLine)) {
      this.showToast('Wait until you are back online so your offline changes can sync before logging out.', {
        durationMs: 5500
      })
      return
    }

    this.loggingOut = true
    try {
      if (this.pendingSyncCount > 0 && navigator.onLine) {
        await syncOutbox(this.userId)
      }
      await clearUserOfflineData(this.userId)
      try {
        await signOutUser()
      } catch {
        // Ignore network errors on sign-out after clearing local session data
      }
      window.location.replace('/')
    } finally {
      this.loggingOut = false
    }
  }
}))

Alpine.start()
