import { getCurrentUser } from './auth.js'
import {
  createGroup,
  createList,
  createStep,
  createTodo,
  deleteGroup,
  deleteList,
  deleteStep,
  deleteTodo,
  fetchServerEntityIds,
  updateGroup,
  updateList,
  updateStep,
  updateTodo
} from './db.js'
import { getOutbox, getOutboxCount, removeOutboxSeq } from './offline-store.js'

const inFlightSyncs = new Map()

export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // RFC 4122 v4 fallback
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isNetworkError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }
  if (!err) return false

  if (err.name === 'AuthRetryableFetchError' || err.status === 0) {
    return true
  }

  const msg = String(err.message || err.details || err)
  if (
    /failed to fetch|networkerror|load failed|network request failed|fetch failed|internet disconnected|offline|err_network/i.test(
      msg
    )
  ) {
    return true
  }

  return err instanceof TypeError && /fetch|network|load/i.test(msg)
}

function isDuplicateKeyError(err) {
  return err?.code === 'DUPLICATE_KEY' || err?.code === '23505'
}

function isRowGoneError(err) {
  return err?.code === 'NOT_FOUND' || err?.status === 404
}

function isAuthError(err) {
  if (!err) return false
  if (err.status === 401 || err.status === 403 || err.code === 'UNAUTHORIZED') return true
  const msg = String(err.message || '')
  return /jwt expired|invalid jwt|refresh token|session.*missing|not authenticated|authentication required/i.test(
    msg
  )
}

async function ensureFreshSession() {
  try {
    const user = await getCurrentUser()
    if (!user) {
      return { ok: false, authError: true }
    }
    return { ok: true, user }
  } catch (err) {
    return isNetworkError(err) ? { ok: false, offline: true } : { ok: false, authError: true }
  }
}

export async function syncOutbox(userId) {
  if (!userId) {
    return {
      synced: 0,
      remaining: 0,
      rescuedTasks: 0,
      ungroupedLists: 0,
      skippedDeleted: 0,
      offline: false,
      authError: false
    }
  }

  if (inFlightSyncs.has(userId)) {
    return inFlightSyncs.get(userId)
  }

  const promise = runSync(userId).finally(() => {
    inFlightSyncs.delete(userId)
  })
  inFlightSyncs.set(userId, promise)
  return promise
}

async function runSync(userId) {
  const result = {
    synced: 0,
    remaining: 0,
    rescuedTasks: 0,
    ungroupedLists: 0,
    skippedDeleted: 0,
    offline: false,
    authError: false,
    error: null
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    result.offline = true
    result.remaining = await getOutboxCount(userId)
    return result
  }

  const ops = await getOutbox(userId)
  if (ops.length === 0) {
    return result
  }

  const sessionState = await ensureFreshSession()
  if (!sessionState.ok) {
    result.offline = Boolean(sessionState.offline)
    result.authError = Boolean(sessionState.authError)
    result.remaining = ops.length
    return result
  }

  // Preflight ID check so missing parents/deleted rows are handled cleanly
  let server
  try {
    server = await fetchServerEntityIds()
  } catch (err) {
    if (isNetworkError(err)) {
      result.offline = true
    } else if (isAuthError(err)) {
      result.authError = true
    } else {
      result.error = err
    }
    result.remaining = ops.length
    return result
  }

  const skippedRepeatTodoIds = new Set()

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]

    try {
      await replayOperation(op, server, skippedRepeatTodoIds, result)
      await removeOutboxSeq(op.seq)
      result.synced++
    } catch (err) {
      if (isNetworkError(err)) {
        result.offline = true
        result.remaining = ops.length - i
        return result
      }
      if (isAuthError(err)) {
        result.authError = true
        result.remaining = ops.length - i
        return result
      }
      result.error = err
      result.remaining = ops.length - i
      return result
    }
  }

  result.remaining = 0
  return result
}

async function replayOperation(op, server, skippedRepeatTodoIds, counters) {
  const { entity, action, entityId, parentId, payload = {} } = op

  if (entity === 'group') {
    if (action === 'create') {
      try {
        await createGroup({
          id: entityId,
          name: payload.name,
          position: payload.position ?? 0
        })
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err
      }
      server.groupIds.add(entityId)
      return
    }

    if (action === 'update') {
      if (!server.groupIds.has(entityId)) {
        counters.skippedDeleted++
        return
      }
      try {
        await updateGroup({ id: entityId, name: payload.name })
      } catch (err) {
        if (isRowGoneError(err)) {
          server.groupIds.delete(entityId)
          counters.skippedDeleted++
          return
        }
        throw err
      }
      return
    }

    if (action === 'delete') {
      await deleteGroup(entityId)
      server.groupIds.delete(entityId)
      return
    }
  }

  if (entity === 'list') {
    if (action === 'create') {
      let groupId = payload.groupId || null
      if (groupId && !server.groupIds.has(groupId)) {
        groupId = null
        counters.ungroupedLists++
      }

      try {
        await createList({
          id: entityId,
          name: payload.name,
          color: payload.color || 'purple',
          groupId,
          position: payload.position ?? 0
        })
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err
      }
      server.listIds.add(entityId)
      return
    }

    if (action === 'update') {
      if (!server.listIds.has(entityId)) {
        counters.skippedDeleted++
        return
      }

      const patch = { id: entityId, ...payload }
      if (patch.groupId && !server.groupIds.has(patch.groupId)) {
        patch.groupId = null
        counters.ungroupedLists++
      }

      try {
        await updateList(patch)
      } catch (err) {
        if (isRowGoneError(err)) {
          server.listIds.delete(entityId)
          counters.skippedDeleted++
          return
        }
        throw err
      }
      return
    }

    if (action === 'delete') {
      await deleteList(entityId)
      server.listIds.delete(entityId)
      return
    }
  }

  if (entity === 'todo') {
    if (action === 'create') {
      // If another device already completed this repeating task before we came online,
      // skip spawning a duplicate next occurrence.
      if (
        payload.sourceRepeatTodoId &&
        server.completedTodoIds.has(payload.sourceRepeatTodoId)
      ) {
        skippedRepeatTodoIds.add(entityId)
        return
      }

      let listId = payload.listId || null
      if (listId && !server.listIds.has(listId)) {
        listId = null
        counters.rescuedTasks++
      }

      try {
        await createTodo({
          id: entityId,
          title: payload.title,
          listId,
          dueDate: payload.dueDate || null,
          reminderAt: payload.reminderAt || null,
          repeatPattern: payload.repeatPattern || null,
          note: payload.note ?? '',
          isCompleted: Boolean(payload.isCompleted),
          completedAt: payload.completedAt || null,
          position: payload.position ?? 0
        })
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err
      }
      server.todoIds.add(entityId)
      return
    }

    if (action === 'update') {
      if (!server.todoIds.has(entityId)) {
        counters.skippedDeleted++
        return
      }

      const patch = { ...payload }
      if (patch.listId && !server.listIds.has(patch.listId)) {
        patch.listId = null
        counters.rescuedTasks++
      }

      try {
        await updateTodo(entityId, patch)
      } catch (err) {
        if (isRowGoneError(err)) {
          server.todoIds.delete(entityId)
          counters.skippedDeleted++
          return
        }
        throw err
      }
      return
    }

    if (action === 'delete') {
      await deleteTodo(entityId)
      server.todoIds.delete(entityId)
      return
    }
  }

  if (entity === 'step') {
    if (action === 'create') {
      if (skippedRepeatTodoIds.has(parentId)) {
        return
      }
      if (!parentId || !server.todoIds.has(parentId)) {
        counters.skippedDeleted++
        return
      }

      try {
        await createStep({
          id: entityId,
          todoId: parentId,
          title: payload.title,
          isCompleted: Boolean(payload.isCompleted),
          position: payload.position ?? 0
        })
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err
      }
      server.stepIds.add(entityId)
      return
    }

    if (action === 'update') {
      if (
        !parentId ||
        !server.todoIds.has(parentId) ||
        !server.stepIds.has(entityId)
      ) {
        counters.skippedDeleted++
        return
      }

      try {
        await updateStep(entityId, payload)
      } catch (err) {
        if (isRowGoneError(err)) {
          server.stepIds.delete(entityId)
          counters.skippedDeleted++
          return
        }
        throw err
      }
      return
    }

    if (action === 'delete') {
      await deleteStep(entityId)
      server.stepIds.delete(entityId)
    }
  }
}
