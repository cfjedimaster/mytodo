import type { Config, Context } from '@netlify/functions'
import { requireAuth, requireSameOrigin } from '../lib/auth.ts'
import { getDb, withTransaction } from '../lib/db.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'
import { mapTodo, type StepRow, type TodoRow } from '../lib/mappers.ts'
import {
  optionalNote,
  optionalUuid,
  parseJsonBody,
  requireTrimmedText,
  requireUuid,
  validateBoolean,
  validateIsoDate,
  validateIsoTimestamp,
  validatePosition,
  validateRepeatPattern
} from '../lib/validation.ts'

const TODO_SELECT_COLUMNS = `
  id,
  list_id,
  title,
  note,
  is_completed,
  completed_at,
  due_date::text AS due_date,
  reminder_at,
  repeat_pattern,
  position,
  created_at,
  updated_at
`

async function assertListOwned(listId: string, userId: string): Promise<void> {
  const db = getDb()
  const rows = await db.sql<{ id: string }>`
    SELECT id
    FROM public.todo_lists
    WHERE id = ${listId} AND user_id = ${userId}
  `
  if (rows.length === 0) {
    throw new ApiError(404, 'List not found.', 'NOT_FOUND')
  }
}

export default async (req: Request, context: Context): Promise<Response> => {
  try {
    requireSameOrigin(req)
    const user = requireAuth(req)
    const db = getDb()
    const method = req.method.toUpperCase()
    const pathname = new URL(req.url).pathname

    // POST /api/todos/restore — atomic restore of a deleted task and its steps
    if (method === 'POST' && pathname === '/api/todos/restore') {
      const body = await parseJsonBody(req)
      const title = requireTrimmedText(body.title, 'Task title', 500)
      const listId = optionalUuid(body.listId, 'list id')
      const dueDate = validateIsoDate(body.dueDate, 'dueDate')
      const reminderAt = validateIsoTimestamp(body.reminderAt, 'reminderAt')
      const repeatPattern = validateRepeatPattern(body.repeatPattern)
      const note = optionalNote(body.note)
      const isCompleted = validateBoolean(body.isCompleted, false)
      const completedAt = isCompleted
        ? (validateIsoTimestamp(body.completedAt, 'completedAt') ?? new Date().toISOString())
        : null
      const position = validatePosition(body.position, 0)

      const rawSteps = Array.isArray(body.steps) ? body.steps : []
      if (rawSteps.length > 500) {
        throw new ApiError(400, 'Too many steps to restore.', 'INVALID_INPUT')
      }
      const stepsToInsert = rawSteps.map((rawStep, index) => {
        if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
          throw new ApiError(400, 'Invalid step entry.', 'INVALID_INPUT')
        }
        const entry = rawStep as Record<string, unknown>
        return {
          title: requireTrimmedText(entry.title, 'Step title', 500),
          isCompleted: validateBoolean(entry.isCompleted, false),
          position: index
        }
      })

      if (listId) {
        await assertListOwned(listId, user.id)
      }

      const restored = await withTransaction(async client => {
        const todoRes = await client.query(
          `INSERT INTO public.todos (
             user_id, list_id, title, note, is_completed, completed_at,
             due_date, reminder_at, repeat_pattern, position
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING ${TODO_SELECT_COLUMNS}`,
          [
            user.id,
            listId,
            title,
            note,
            isCompleted,
            completedAt,
            dueDate,
            reminderAt,
            repeatPattern,
            position
          ]
        )
        const todoRow = todoRes.rows[0] as unknown as TodoRow
        const stepRows: StepRow[] = []

        for (const step of stepsToInsert) {
          const stepRes = await client.query(
            `INSERT INTO public.todo_steps (user_id, todo_id, title, is_completed, position)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, todo_id, title, is_completed, position, created_at`,
            [user.id, todoRow.id, step.title, step.isCompleted, step.position]
          )
          stepRows.push(stepRes.rows[0] as unknown as StepRow)
        }

        return mapTodo(todoRow, stepRows)
      })

      return jsonResponse(restored, 201)
    }

    // POST /api/todos/:id/complete-repeat — atomically complete & spawn next repeating occurrence
    if (method === 'POST' && pathname.endsWith('/complete-repeat')) {
      const id = requireUuid(context.params.id, 'task id')
      const body = await parseJsonBody(req)
      const nextDueDate = validateIsoDate(body.nextDueDate, 'nextDueDate')
      const nextReminderAt = validateIsoTimestamp(body.nextReminderAt, 'nextReminderAt')

      const result = await withTransaction(async client => {
        const updatedRes = await client.query(
          `UPDATE public.todos
           SET is_completed = true, completed_at = now()
           WHERE id = $1 AND user_id = $2
           RETURNING ${TODO_SELECT_COLUMNS}`,
          [id, user.id]
        )
        if (updatedRes.rows.length === 0) {
          throw new ApiError(404, 'Task not found.', 'NOT_FOUND')
        }

        const updatedRow = updatedRes.rows[0] as unknown as TodoRow
        const originalStepsRes = await client.query(
          `SELECT id, todo_id, title, is_completed, position, created_at
           FROM public.todo_steps
           WHERE todo_id = $1 AND user_id = $2
           ORDER BY position ASC, created_at ASC`,
          [id, user.id]
        )
        const originalSteps = originalStepsRes.rows as unknown as StepRow[]

        if (!updatedRow.repeat_pattern) {
          return {
            updatedTodo: mapTodo(updatedRow, originalSteps),
            nextTodo: null
          }
        }

        const nextTodoRes = await client.query(
          `INSERT INTO public.todos (
             user_id, list_id, title, note, is_completed, completed_at,
             due_date, reminder_at, repeat_pattern, position
           )
           VALUES ($1, $2, $3, $4, false, NULL, $5, $6, $7, $8)
           RETURNING ${TODO_SELECT_COLUMNS}`,
          [
            user.id,
            updatedRow.list_id,
            updatedRow.title,
            updatedRow.note ?? '',
            nextDueDate,
            nextReminderAt,
            updatedRow.repeat_pattern,
            updatedRow.position ?? 0
          ]
        )
        const nextRow = nextTodoRes.rows[0] as unknown as TodoRow
        const copiedSteps: StepRow[] = []

        for (let i = 0; i < originalSteps.length; i++) {
          const stepRes = await client.query(
            `INSERT INTO public.todo_steps (user_id, todo_id, title, is_completed, position)
             VALUES ($1, $2, $3, false, $4)
             RETURNING id, todo_id, title, is_completed, position, created_at`,
            [user.id, nextRow.id, originalSteps[i].title, i]
          )
          copiedSteps.push(stepRes.rows[0] as unknown as StepRow)
        }

        return {
          updatedTodo: mapTodo(updatedRow, originalSteps),
          nextTodo: mapTodo(nextRow, copiedSteps)
        }
      })

      return jsonResponse(result)
    }

    // POST /api/todos — create a task
    if (method === 'POST') {
      const body = await parseJsonBody(req)
      const id = optionalUuid(body.id, 'task id')
      const title = requireTrimmedText(body.title, 'Task title', 500)
      const listId = optionalUuid(body.listId, 'list id')
      const dueDate = validateIsoDate(body.dueDate, 'dueDate')
      const reminderAt = validateIsoTimestamp(body.reminderAt, 'reminderAt')
      const repeatPattern = validateRepeatPattern(body.repeatPattern)
      const note = optionalNote(body.note)
      const isCompleted = validateBoolean(body.isCompleted, false)
      const completedAt = isCompleted
        ? (validateIsoTimestamp(body.completedAt, 'completedAt') ?? new Date().toISOString())
        : null
      const position = validatePosition(body.position, 0)

      if (listId) {
        await assertListOwned(listId, user.id)
      }

      if (id) {
        const rows = await db.sql<TodoRow>`
          INSERT INTO public.todos (
            id, user_id, list_id, title, note, is_completed, completed_at,
            due_date, reminder_at, repeat_pattern, position
          )
          VALUES (
            ${id}, ${user.id}, ${listId}, ${title}, ${note}, ${isCompleted}, ${completedAt},
            ${dueDate}, ${reminderAt}, ${repeatPattern}, ${position}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING
            id, list_id, title, note, is_completed, completed_at,
            due_date::text AS due_date, reminder_at, repeat_pattern, position, created_at, updated_at
        `
        if (rows.length > 0) {
          return jsonResponse(mapTodo(rows[0], []), 201)
        }

        const owned = await db.sql<{ id: string }>`
          SELECT id
          FROM public.todos
          WHERE id = ${id} AND user_id = ${user.id}
        `
        if (owned.length > 0) {
          throw new ApiError(409, 'Task already exists.', 'DUPLICATE_KEY')
        }
        throw new ApiError(409, 'Unable to create task with that identifier.', 'CONFLICT')
      }

      const rows = await db.sql<TodoRow>`
        INSERT INTO public.todos (
          user_id, list_id, title, note, is_completed, completed_at,
          due_date, reminder_at, repeat_pattern, position
        )
        VALUES (
          ${user.id}, ${listId}, ${title}, ${note}, ${isCompleted}, ${completedAt},
          ${dueDate}, ${reminderAt}, ${repeatPattern}, ${position}
        )
        RETURNING
          id, list_id, title, note, is_completed, completed_at,
          due_date::text AS due_date, reminder_at, repeat_pattern, position, created_at, updated_at
      `
      return jsonResponse(mapTodo(rows[0], []), 201)
    }

    const id = requireUuid(context.params.id, 'task id')

    // PATCH /api/todos/:id — partial update
    if (method === 'PATCH') {
      const body = await parseJsonBody(req)
      const assignments: string[] = []
      const params: unknown[] = []

      if (body.title !== undefined) {
        const title = requireTrimmedText(body.title, 'Task title', 500)
        params.push(title)
        assignments.push(`title = $${params.length}`)
      }
      if (body.listId !== undefined) {
        const listId = optionalUuid(body.listId, 'list id')
        if (listId) {
          await assertListOwned(listId, user.id)
        }
        params.push(listId)
        assignments.push(`list_id = $${params.length}`)
      }
      if (body.note !== undefined) {
        const note = optionalNote(body.note)
        params.push(note)
        assignments.push(`note = $${params.length}`)
      }
      if (body.isCompleted !== undefined) {
        const isCompleted = validateBoolean(body.isCompleted)
        const completedAt = isCompleted
          ? (validateIsoTimestamp(body.completedAt, 'completedAt') ?? new Date().toISOString())
          : null
        params.push(isCompleted)
        assignments.push(`is_completed = $${params.length}`)
        params.push(completedAt)
        assignments.push(`completed_at = $${params.length}`)
      }
      if (body.dueDate !== undefined) {
        const dueDate = validateIsoDate(body.dueDate, 'dueDate')
        params.push(dueDate)
        assignments.push(`due_date = $${params.length}`)
      }
      if (body.reminderAt !== undefined) {
        const reminderAt = validateIsoTimestamp(body.reminderAt, 'reminderAt')
        params.push(reminderAt)
        assignments.push(`reminder_at = $${params.length}`)
      }
      if (body.repeatPattern !== undefined) {
        const repeatPattern = validateRepeatPattern(body.repeatPattern)
        params.push(repeatPattern)
        assignments.push(`repeat_pattern = $${params.length}`)
      }

      if (assignments.length === 0) {
        throw new ApiError(400, 'No valid fields provided for update.', 'INVALID_INPUT')
      }

      params.push(id, user.id)
      const idIdx = params.length - 1
      const userIdx = params.length

      const { rows } = await db.pool.query(
        `UPDATE public.todos
         SET ${assignments.join(', ')}
         WHERE id = $${idIdx} AND user_id = $${userIdx}
         RETURNING ${TODO_SELECT_COLUMNS}`,
        params
      )

      if (rows.length === 0) {
        throw new ApiError(404, 'Task not found.', 'NOT_FOUND')
      }

      const steps = await db.sql<StepRow>`
        SELECT id, todo_id, title, is_completed, position, created_at
        FROM public.todo_steps
        WHERE todo_id = ${id} AND user_id = ${user.id}
        ORDER BY position ASC, created_at ASC
      `

      return jsonResponse(mapTodo(rows[0] as TodoRow, steps))
    }

    // DELETE /api/todos/:id
    if (method === 'DELETE') {
      await db.sql`
        DELETE FROM public.todos
        WHERE id = ${id} AND user_id = ${user.id}
      `
      return jsonResponse({ deleted: true })
    }

    throw new ApiError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED')
  } catch (err) {
    return handleRouteError(err)
  }
}

export const config: Config = {
  path: ['/api/todos', '/api/todos/restore', '/api/todos/:id', '/api/todos/:id/complete-repeat'],
  method: ['POST', 'PATCH', 'DELETE']
}
