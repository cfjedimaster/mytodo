import type { Config, Context } from '@netlify/functions'
import { requireAuth, requireSameOrigin } from '../lib/auth.ts'
import { getDb } from '../lib/db.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'
import { mapGroup, type GroupRow } from '../lib/mappers.ts'
import {
  optionalUuid,
  parseJsonBody,
  requireTrimmedText,
  requireUuid,
  validatePosition
} from '../lib/validation.ts'

export default async (req: Request, context: Context): Promise<Response> => {
  try {
    requireSameOrigin(req)
    const user = requireAuth(req)
    const db = getDb()
    const method = req.method.toUpperCase()

    if (method === 'POST') {
      const body = await parseJsonBody(req)
      const id = optionalUuid(body.id, 'group id')
      const name = requireTrimmedText(body.name, 'Group name', 200)
      const position = validatePosition(body.position, 0)

      if (id) {
        const rows = await db.sql<GroupRow>`
          INSERT INTO public.list_groups (id, user_id, name, position)
          VALUES (${id}, ${user.id}, ${name}, ${position})
          ON CONFLICT (id) DO NOTHING
          RETURNING id, name, position, created_at
        `
        if (rows.length > 0) {
          return jsonResponse(mapGroup(rows[0]), 201)
        }

        const owned = await db.sql<{ id: string }>`
          SELECT id
          FROM public.list_groups
          WHERE id = ${id} AND user_id = ${user.id}
        `
        if (owned.length > 0) {
          throw new ApiError(409, 'Group already exists.', 'DUPLICATE_KEY')
        }
        throw new ApiError(409, 'Unable to create group with that identifier.', 'CONFLICT')
      }

      const rows = await db.sql<GroupRow>`
        INSERT INTO public.list_groups (user_id, name, position)
        VALUES (${user.id}, ${name}, ${position})
        RETURNING id, name, position, created_at
      `
      return jsonResponse(mapGroup(rows[0]), 201)
    }

    const id = requireUuid(context.params.id, 'group id')

    if (method === 'PATCH') {
      const body = await parseJsonBody(req)
      const name = requireTrimmedText(body.name, 'Group name', 200)

      const rows = await db.sql<GroupRow>`
        UPDATE public.list_groups
        SET name = ${name}
        WHERE id = ${id} AND user_id = ${user.id}
        RETURNING id, name, position, created_at
      `
      if (rows.length === 0) {
        throw new ApiError(404, 'Group not found.', 'NOT_FOUND')
      }

      return jsonResponse(mapGroup(rows[0]))
    }

    if (method === 'DELETE') {
      await db.sql`
        DELETE FROM public.list_groups
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
  path: ['/api/groups', '/api/groups/:id'],
  method: ['POST', 'PATCH', 'DELETE']
}
