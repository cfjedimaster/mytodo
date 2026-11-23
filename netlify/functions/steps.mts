import type { Config, Context } from '@netlify/functions'
import { requireAuth, requireSameOrigin } from '../lib/auth.ts'
import { getDb } from '../lib/db.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'
import { mapStep, type StepRow } from '../lib/mappers.ts'
import {
  optionalUuid,
  parseJsonBody,
  requireTrimmedText,
  requireUuid,
  validateBoolean,
  validatePosition
} from '../lib/validation.ts'

async function assertTodoOwned(todoId: string, userId: string): Promise<void> {
  const db = getDb()
  const rows = await db.sql<{ id: string }>`
    SELECT id
    FROM public.todos
    WHERE id = ${todoId} AND user_id = ${userId}
  `
  if (rows.length === 0) {
    throw new ApiError(404, 'Task not found.', 'NOT_FOUND')
  }
}

export default async (req: Request, context: Context): Promise<Response> => {
  try {
    requireSameOrigin(req)
    const user = requireAuth(req)
    const db = getDb()
    const method = req.method.toUpperCase()

    if (method === 'POST') {
      const body = await parseJsonBody(req)
      const id = optionalUuid(body.id, 'step id')
      const todoId = requireUuid(body.todoId, 'task id')
      const title = requireTrimmedText(body.title, 'Step title', 500)
      const isCompleted = validateBoolean(body.isCompleted, false)
      const position = validatePosition(body.position, 0)

      await assertTodoOwned(todoId, user.id)

      if (id) {
        const rows = await db.sql<StepRow>`
          INSERT INTO public.todo_steps (id, user_id, todo_id, title, is_completed, position)
          VALUES (${id}, ${user.id}, ${todoId}, ${title}, ${isCompleted}, ${position})
          ON CONFLICT (id) DO NOTHING
          RETURNING id, todo_id, title, is_completed, position, created_at
        `
        if (rows.length > 0) {
          return jsonResponse(mapStep(rows[0]), 201)
        }

        const owned = await db.sql<{ id: string }>`
          SELECT id
          FROM public.todo_steps
          WHERE id = ${id} AND user_id = ${user.id}
        `
        if (owned.length > 0) {
          throw new ApiError(409, 'Step already exists.', 'DUPLICATE_KEY')
        }
        throw new ApiError(409, 'Unable to create step with that identifier.', 'CONFLICT')
      }

      const rows = await db.sql<StepRow>`
        INSERT INTO public.todo_steps (user_id, todo_id, title, is_completed, position)
        VALUES (${user.id}, ${todoId}, ${title}, ${isCompleted}, ${position})
        RETURNING id, todo_id, title, is_completed, position, created_at
      `
      return jsonResponse(mapStep(rows[0]), 201)
    }

    const id = requireUuid(context.params.id, 'step id')

    if (method === 'PATCH') {
      const body = await parseJsonBody(req)
      const assignments: string[] = []
      const params: unknown[] = []

      if (body.title !== undefined) {
        const title = requireTrimmedText(body.title, 'Step title', 500)
        params.push(title)
        assignments.push(`title = $${params.length}`)
      }
      if (body.isCompleted !== undefined) {
        const isCompleted = validateBoolean(body.isCompleted)
        params.push(isCompleted)
        assignments.push(`is_completed = $${params.length}`)
      }

      if (assignments.length === 0) {
        throw new ApiError(400, 'No valid fields provided for update.', 'INVALID_INPUT')
      }

      params.push(id, user.id)
      const idIdx = params.length - 1
      const userIdx = params.length

      const { rows } = await db.pool.query(
        `UPDATE public.todo_steps
         SET ${assignments.join(', ')}
         WHERE id = $${idIdx} AND user_id = $${userIdx}
         RETURNING id, todo_id, title, is_completed, position, created_at`,
        params
      )

      if (rows.length === 0) {
        throw new ApiError(404, 'Step not found.', 'NOT_FOUND')
      }

      return jsonResponse(mapStep(rows[0] as StepRow))
    }

    if (method === 'DELETE') {
      await db.sql`
        DELETE FROM public.todo_steps
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
  path: ['/api/steps', '/api/steps/:id'],
  method: ['POST', 'PATCH', 'DELETE']
}
