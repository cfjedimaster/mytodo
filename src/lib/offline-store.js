const DB_NAME = 'my-to-do-offline'
const DB_VERSION = 1
const WORKSPACE_STORE = 'workspaces'
const OUTBOX_STORE = 'outbox'

let dbPromise = null

function isIndexedDbSupported() {
  return typeof indexedDB !== 'undefined'
}

function plainClone(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function openDb() {
  if (!isIndexedDbSupported()) {
    return Promise.resolve(null)
  }

  if (dbPromise) return dbPromise

  dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
          db.createObjectStore(WORKSPACE_STORE, { keyPath: 'userId' })
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          const outbox = db.createObjectStore(OUTBOX_STORE, {
            keyPath: 'seq',
            autoIncrement: true
          })
          outbox.createIndex('by_user', 'userId', { unique: false })
        }
      }

      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }

      request.onerror = () => {
        dbPromise = null
        resolve(null)
      }

      request.onblocked = () => {
        resolve(null)
      }
    } catch {
      dbPromise = null
      resolve(null)
    }
  })

  return dbPromise
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'))
  })
}

export async function loadCachedWorkspace(userId) {
  if (!userId) return null
  const db = await openDb()
  if (!db) return null

  try {
    const tx = db.transaction(WORKSPACE_STORE, 'readonly')
    const record = await requestToPromise(tx.objectStore(WORKSPACE_STORE).get(userId))
    return record || null
  } catch {
    return null
  }
}

export async function loadLastCachedWorkspace() {
  const db = await openDb()
  if (!db) return null

  try {
    const tx = db.transaction(WORKSPACE_STORE, 'readonly')
    const all = await requestToPromise(tx.objectStore(WORKSPACE_STORE).getAll())
    if (!Array.isArray(all) || all.length === 0) return null
    all.sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''))
    return all[0]
  } catch {
    return null
  }
}

export async function saveCachedWorkspace(userId, { groups, lists, todos, userProfile = null }) {
  if (!userId) return false
  const db = await openDb()
  if (!db) return false

  try {
    const tx = db.transaction(WORKSPACE_STORE, 'readwrite')
    const store = tx.objectStore(WORKSPACE_STORE)
    const existing = await requestToPromise(store.get(userId))

    const record = {
      userId,
      groups: plainClone(groups || []),
      lists: plainClone(lists || []),
      todos: plainClone(todos || []),
      userProfile: userProfile
        ? plainClone(userProfile)
        : (existing?.userProfile || null),
      cachedAt: new Date().toISOString()
    }

    store.put(record)
    await txDone(tx)
    return true
  } catch {
    return false
  }
}

export async function getOutbox(userId) {
  if (!userId) return []
  const db = await openDb()
  if (!db) return []

  try {
    const tx = db.transaction(OUTBOX_STORE, 'readonly')
    const index = tx.objectStore(OUTBOX_STORE).index('by_user')
    const ops = await requestToPromise(index.getAll(userId))
    return (ops || []).sort((a, b) => a.seq - b.seq)
  } catch {
    return []
  }
}

export async function getOutboxCount(userId) {
  if (!userId) return 0
  const db = await openDb()
  if (!db) return 0

  try {
    const tx = db.transaction(OUTBOX_STORE, 'readonly')
    const index = tx.objectStore(OUTBOX_STORE).index('by_user')
    const count = await requestToPromise(index.count(userId))
    return count || 0
  } catch {
    return 0
  }
}

/**
 * Enqueue a mutation into the user's outbox, coalescing redundant offline edits
 * and pruning child ops when a parent is deleted offline.
 */
export async function enqueueMutation(
  userId,
  { entity, action, entityId, parentId = null, payload = {}, cascadeTodoIds = [] }
) {
  if (!userId) return 0
  const db = await openDb()
  if (!db) return 0

  const cleanPayload = plainClone(payload || {})
  const now = new Date().toISOString()

  try {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite')
    const store = tx.objectStore(OUTBOX_STORE)
    const index = store.index('by_user')
    const existing = ((await requestToPromise(index.getAll(userId))) || []).sort(
      (a, b) => a.seq - b.seq
    )

    if (action === 'update') {
      const queuedCreate = existing.find(
        op => op.entity === entity && op.entityId === entityId && op.action === 'create'
      )
      if (queuedCreate) {
        queuedCreate.payload = { ...queuedCreate.payload, ...cleanPayload }
        store.put(queuedCreate)
        await txDone(tx)
        return existing.length
      }

      const queuedUpdate = [...existing]
        .reverse()
        .find(op => op.entity === entity && op.entityId === entityId && op.action === 'update')
      if (queuedUpdate) {
        queuedUpdate.payload = { ...queuedUpdate.payload, ...cleanPayload }
        store.put(queuedUpdate)
        await txDone(tx)
        return existing.length
      }

      store.add({
        userId,
        entity,
        action,
        entityId,
        parentId,
        payload: cleanPayload,
        createdAt: now
      })
      await txDone(tx)
      return existing.length + 1
    }

    if (action === 'delete') {
      const hadQueuedCreate = existing.some(
        op => op.entity === entity && op.entityId === entityId && op.action === 'create'
      )

      const cascadeTodoSet = new Set(cascadeTodoIds || [])
      if (entity === 'todo') {
        cascadeTodoSet.add(entityId)
      }

      let removedCount = 0

      for (const op of existing) {
        // Drop any prior creates/updates for the deleted entity itself
        if (op.entity === entity && op.entityId === entityId && op.action !== 'delete') {
          store.delete(op.seq)
          removedCount++
          continue
        }

        // If deleting a list, drop queued ops for todos belonging to it and their steps
        if (entity === 'list') {
          if (
            op.entity === 'todo' &&
            (cascadeTodoSet.has(op.entityId) || op.payload?.listId === entityId)
          ) {
            cascadeTodoSet.add(op.entityId)
            store.delete(op.seq)
            removedCount++
            continue
          }
        }

        // If deleting a todo (or a list containing todos), drop queued step ops for those todos
        if (op.entity === 'step' && cascadeTodoSet.has(op.parentId)) {
          store.delete(op.seq)
          removedCount++
          continue
        }

        // If deleting a group, ungroup any queued list create/update pointing to it
        if (
          entity === 'group' &&
          op.entity === 'list' &&
          (op.action === 'create' || op.action === 'update') &&
          op.payload?.groupId === entityId
        ) {
          op.payload = { ...op.payload, groupId: null }
          store.put(op)
        }
      }

      // Only queue a server delete if this entity didn't originate offline
      let addedCount = 0
      if (!hadQueuedCreate) {
        const alreadyDeleting = existing.some(
          op => op.entity === entity && op.entityId === entityId && op.action === 'delete'
        )
        if (!alreadyDeleting) {
          store.add({
            userId,
            entity,
            action: 'delete',
            entityId,
            parentId,
            payload: {},
            createdAt: now
          })
          addedCount = 1
        }
      }

      await txDone(tx)
      return Math.max(0, existing.length - removedCount + addedCount)
    }

    // Default: 'create'
    store.add({
      userId,
      entity,
      action,
      entityId,
      parentId,
      payload: cleanPayload,
      createdAt: now
    })
    await txDone(tx)
    return existing.length + 1
  } catch {
    return 0
  }
}

export async function removeOutboxSeq(seq) {
  const db = await openDb()
  if (!db) return false

  try {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite')
    tx.objectStore(OUTBOX_STORE).delete(seq)
    await txDone(tx)
    return true
  } catch {
    return false
  }
}

export async function clearUserOfflineData(userId) {
  const db = await openDb()
  if (!db) return false

  try {
    const tx = db.transaction([WORKSPACE_STORE, OUTBOX_STORE], 'readwrite')
    const wsStore = tx.objectStore(WORKSPACE_STORE)
    const outboxStore = tx.objectStore(OUTBOX_STORE)

    if (userId) {
      wsStore.delete(userId)
      const ops = await requestToPromise(outboxStore.index('by_user').getAll(userId))
      for (const op of ops || []) {
        outboxStore.delete(op.seq)
      }
    } else {
      wsStore.clear()
      outboxStore.clear()
    }

    await txDone(tx)
    return true
  } catch {
    return false
  }
}
