export interface GroupRow {
  id: string
  name: string
  position: number | null
  created_at: Date | string
}

export interface ListRow {
  id: string
  group_id: string | null
  name: string
  color: string | null
  position: number | null
  created_at: Date | string
}

export interface StepRow {
  id: string
  todo_id: string
  title: string
  is_completed: boolean
  position: number | null
  created_at: Date | string
}

export interface TodoRow {
  id: string
  list_id: string | null
  title: string
  note: string | null
  is_completed: boolean
  completed_at: Date | string | null
  due_date: Date | string | null
  reminder_at: Date | string | null
  repeat_pattern: string | null
  position: number | null
  created_at: Date | string
  updated_at: Date | string
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const year = value.getUTCFullYear()
    const month = String(value.getUTCMonth() + 1).padStart(2, '0')
    const day = String(value.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return String(value).slice(0, 10)
}

export function mapGroup(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    position: row.position ?? 0,
    createdAt: toIsoString(row.created_at) ?? ''
  }
}

export function mapList(row: ListRow) {
  return {
    id: row.id,
    groupId: row.group_id ?? null,
    name: row.name,
    color: row.color ?? 'purple',
    position: row.position ?? 0,
    createdAt: toIsoString(row.created_at) ?? ''
  }
}

export function mapStep(row: StepRow) {
  return {
    id: row.id,
    todoId: row.todo_id,
    title: row.title ?? '',
    isCompleted: Boolean(row.is_completed),
    position: row.position ?? 0,
    createdAt: toIsoString(row.created_at) ?? ''
  }
}

export function mapTodo(row: TodoRow, steps: StepRow[] = []) {
  const mappedSteps = [...steps]
    .sort((a, b) => {
      const posDiff = (a.position ?? 0) - (b.position ?? 0)
      if (posDiff !== 0) return posDiff
      return (toIsoString(a.created_at) ?? '').localeCompare(toIsoString(b.created_at) ?? '')
    })
    .map(mapStep)

  return {
    id: row.id,
    listId: row.list_id ?? null,
    title: row.title ?? '',
    note: row.note ?? '',
    isCompleted: Boolean(row.is_completed),
    completedAt: toIsoString(row.completed_at),
    dueDate: toIsoDate(row.due_date),
    reminderAt: toIsoString(row.reminder_at),
    repeatPattern: row.repeat_pattern ?? null,
    position: row.position ?? 0,
    createdAt: toIsoString(row.created_at) ?? '',
    updatedAt: toIsoString(row.updated_at) ?? '',
    steps: mappedSteps
  }
}
