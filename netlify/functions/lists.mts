import type { Config, Context } from '@netlify/functions'
import { requireAuth, requireSameOrigin } from '../lib/auth.ts'
import { getDb } from '../lib/db.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'
import { mapList, type ListRow } from '../lib/mappers.ts'
import {
  optionalUuid,
  parseJsonBody,
  requireTrimmedText,
  requireUuid,
  validateColor,
  validatePosition
} from '../lib/validation.ts'

async function assertGroupOwned(groupId: string, userId: string): Promise<void> {
  const db = getDb()
  const rows = await db.sql<{ id: string }>`
    SELECT id
    FROM public.list_groups
    WHERE id = ${groupId} AND user_id = ${userId}
  `
  if (rows.length === 0) {
    throw new ApiError(404, 'Group not found.', 'NOT_FOUND')
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
      const id = optionalUuid(body.id, 'list id')
      const name = requireTrimmedText(body.name, 'List name', 200)
      const color = validateColor(body.color, 'purple')
      const groupId = optionalUuid(body.groupId, 'group id')
      const position = validatePosition(body.position, 0)

      if (groupId) {
        await assertGroupOwned(groupId, user.id)
      }

      if (id) {
        const rows = await db.sql<ListRow>`
          INSERT INTO public.todo_lists (id, user_id, group_id, name, color, position)
          VALUES (${id}, ${user.id}, ${groupId}, ${name}, ${color}, ${position})
          ON CONFLICT (id) DO NOTHING
          RETURNING id, group_id, name, color, position, created_at
        `
        if (rows.length > 0) {
          return jsonResponse(mapList(rows[0]), 201)
        }

        const owned = await db.sql<{ id: string }>`
          SELECT id
          FROM public.todo_lists
          WHERE id = ${id} AND user_id = ${user.id}
        `
        if (owned.length > 0) {
          throw new ApiError(409, 'List already exists.', 'DUPLICATE_KEY')
        }
        throw new ApiError(409, 'Unable to create list with that identifier.', 'CONFLICT')
      }

      const rows = await db.sql<ListRow>`
        INSERT INTO public.todo_lists (user_id, group_id, name, color, position)
        VALUES (${user.id}, ${groupId}, ${name}, ${color}, ${position})
        RETURNING id, group_id, name, color, position, created_at
      `
      return jsonResponse(mapList(rows[0]), 201)
    }

    const id = requireUuid(context.params.id, 'list id')

    if (method === 'PATCH') {
      const body = await parseJsonBody(req)
      const assignments: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) {
        const name = requireTrimmedText(body.name, 'List name', 200)
        params.push(name)
        assignments.push(`name = $${params.length}`)
      }
      if (body.color !== undefined) {
        const color = validateColor(body.color)
        params.push(color)
        assignments.push(`color = $${params.length}`)
      }
      if (body.groupId !== undefined) {
        const groupId = optionalUuid(body.groupId, 'group id')
        if (groupId) {
          await assertGroupOwned(groupId, user.id)
        }
        params.push(groupId)
        assignments.push(`group_id = $${params.length}`)
      }

      if (assignments.length === 0) {
        throw new ApiError(400, 'No valid fields provided for update.', 'INVALID_INPUT')
      }

      params.push(id, user.id)
      const idIdx = params.length - 1
      const userIdx = params.length

      const { rows } = await db.pool.query(
        `UPDATE public.todo_lists
         SET ${assignments.join(', ')}
         WHERE id = $${idIdx} AND user_id = $${userIdx}
         RETURNING id, group_id, name, color, position, created_at`,
        params
      )

      if (rows.length === 0) {
        throw new ApiError(404, 'List not found.', 'NOT_FOUND')
      }

      return jsonResponse(mapList(rows[0] as ListRow))
    }

    if (method === 'DELETE') {
      await db.sql`
        DELETE FROM public.todo_lists
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
  path: ['/api/lists', '/api/lists/:id'],
  method: ['POST', 'PATCH', 'DELETE']
}
