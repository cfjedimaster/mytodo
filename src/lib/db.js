import { advanceDueDate, advanceReminderAt } from './dates.js'

async function apiRequest(path, { method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/json'
  }
  const init = {
    method,
    credentials: 'same-origin',
    headers
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(path, init)

  let data = null
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      data = await response.json()
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status}).`
    const err = new Error(message)
    err.status = response.status
    err.code = data?.code || (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR')
    throw err
  }

  return data
}

export async function fetchWorkspaceData() {
  const data = await apiRequest('/api/workspace')
  return {
    groups: Array.isArray(data?.groups) ? data.groups : [],
    lists: Array.isArray(data?.lists) ? data.lists : [],
    todos: Array.isArray(data?.todos) ? data.todos : []
  }
}

export async function fetchServerEntityIds() {
  const data = await apiRequest('/api/workspace/ids')
  return {
    groupIds: new Set(data?.groupIds ?? []),
    listIds: new Set(data?.listIds ?? []),
    todoIds: new Set(data?.todoIds ?? []),
    completedTodoIds: new Set(data?.completedTodoIds ?? []),
    stepIds: new Set(data?.stepIds ?? [])
  }
}

export async function createGroup({ id, name, position = 0 }) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new Error('Group name is required.')

  const body = { name: trimmed, position }
  if (id) body.id = id

  return apiRequest('/api/groups', { method: 'POST', body })
}

export async function updateGroup({ id, name }) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new Error('Group name is required.')

  return apiRequest(`/api/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name: trimmed }
  })
}

export async function deleteGroup(id) {
  await apiRequest(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}

export async function createList({ id, name, color = 'purple', groupId = null, position = 0 }) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new Error('List name is required.')

  const body = {
    name: trimmed,
    color,
    groupId: groupId || null,
    position
  }
  if (id) body.id = id

  return apiRequest('/api/lists', { method: 'POST', body })
}

export async function updateList({ id, name, color, groupId }) {
  const body = {}
  if (name !== undefined) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) throw new Error('List name is required.')
    body.name = trimmed
  }
  if (color !== undefined) body.color = color
  if (groupId !== undefined) body.groupId = groupId || null

  return apiRequest(`/api/lists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body
  })
}

export async function deleteList(id) {
  await apiRequest(`/api/lists/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}

export async function createTodo({
  id,
  title,
  listId = null,
  dueDate = null,
  reminderAt = null,
  repeatPattern = null,
  note = '',
  isCompleted = false,
  completedAt = null,
  position = 0
}) {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  if (!trimmed) throw new Error('Task title is required.')

  const body = {
    title: trimmed,
    listId: listId || null,
    dueDate: dueDate || null,
    reminderAt: reminderAt || null,
    repeatPattern: repeatPattern || null,
    note,
    isCompleted: Boolean(isCompleted),
    completedAt: isCompleted ? (completedAt || new Date().toISOString()) : null,
    position
  }
  if (id) body.id = id

  return apiRequest('/api/todos', { method: 'POST', body })
}

export async function updateTodo(id, patch) {
  const body = {}

  if (patch.title !== undefined) {
    const trimmed = typeof patch.title === 'string' ? patch.title.trim() : ''
    if (!trimmed) throw new Error('Task title is required.')
    body.title = trimmed
  }
  if (patch.listId !== undefined) body.listId = patch.listId || null
  if (patch.note !== undefined) body.note = patch.note
  if (patch.isCompleted !== undefined) {
    body.isCompleted = Boolean(patch.isCompleted)
    body.completedAt = patch.isCompleted
      ? (patch.completedAt || new Date().toISOString())
      : null
  }
  if (patch.dueDate !== undefined) body.dueDate = patch.dueDate || null
  if (patch.reminderAt !== undefined) body.reminderAt = patch.reminderAt || null
  if (patch.repeatPattern !== undefined) body.repeatPattern = patch.repeatPattern || null

  return apiRequest(`/api/todos/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body
  })
}

export async function completeTodoWithRepeat(todo) {
  const nextDueDate = todo.repeatPattern
    ? advanceDueDate(todo.dueDate, todo.repeatPattern)
    : null
  const nextReminderAt = todo.repeatPattern
    ? advanceReminderAt(todo.reminderAt, todo.repeatPattern)
    : null

  return apiRequest(`/api/todos/${encodeURIComponent(todo.id)}/complete-repeat`, {
    method: 'POST',
    body: { nextDueDate, nextReminderAt }
  })
}

export async function deleteTodo(id) {
  await apiRequest(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}

export async function restoreTodoSnapshot(snapshot) {
  return apiRequest('/api/todos/restore', {
    method: 'POST',
    body: {
      title: snapshot.title,
      listId: snapshot.listId || null,
      dueDate: snapshot.dueDate || null,
      reminderAt: snapshot.reminderAt || null,
      repeatPattern: snapshot.repeatPattern || null,
      note: snapshot.note ?? '',
      isCompleted: Boolean(snapshot.isCompleted),
      completedAt: snapshot.isCompleted ? (snapshot.completedAt || new Date().toISOString()) : null,
      steps: Array.isArray(snapshot.steps)
        ? snapshot.steps.map(step => ({
            title: step.title,
            isCompleted: Boolean(step.isCompleted)
          }))
        : []
    }
  })
}

export async function createStep({ id, todoId, title, isCompleted = false, position = 0 }) {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  if (!trimmed) throw new Error('Step title is required.')

  const body = {
    todoId,
    title: trimmed,
    isCompleted: Boolean(isCompleted),
    position
  }
  if (id) body.id = id

  return apiRequest('/api/steps', { method: 'POST', body })
}

export async function updateStep(id, patch) {
  const body = {}
  if (patch.title !== undefined) {
    const trimmed = typeof patch.title === 'string' ? patch.title.trim() : ''
    if (!trimmed) throw new Error('Step title is required.')
    body.title = trimmed
  }
  if (patch.isCompleted !== undefined) {
    body.isCompleted = Boolean(patch.isCompleted)
  }

  return apiRequest(`/api/steps/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body
  })
}

export async function deleteStep(id) {
  await apiRequest(`/api/steps/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}
