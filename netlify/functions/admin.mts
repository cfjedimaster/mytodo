import type { Config } from '@netlify/functions'
import {
  anonymizeUserId,
  clearAdminSessionCookie,
  createAdminSessionCookie,
  getAdminConfig,
  requireAdminAuth,
  requireSameOrigin,
  verifyAdminPassword
} from '../lib/auth.ts'
import { getDb } from '../lib/db.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'
import { parseJsonBody } from '../lib/validation.ts'

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export default async (req: Request): Promise<Response> => {
  try {
    const pathname = new URL(req.url).pathname
    const method = req.method.toUpperCase()

    if (method === 'POST' && pathname === '/api/admin/login') {
      requireSameOrigin(req)
      const adminConfig = getAdminConfig()
      if (!adminConfig.isConfigured) {
        throw new ApiError(503, 'Admin access is not configured.', 'NOT_CONFIGURED')
      }

      const body = await parseJsonBody(req)
      const password = typeof body.password === 'string' ? body.password : ''

      if (!verifyAdminPassword(password)) {
        throw new ApiError(401, 'Invalid password.', 'INVALID_PASSWORD')
      }

      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, private'
      })
      headers.append('set-cookie', createAdminSessionCookie(req.url))

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
      requireSameOrigin(req)
      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, private'
      })
      headers.append('set-cookie', clearAdminSessionCookie(req.url))

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    if (method === 'GET' && pathname === '/api/admin/report') {
      requireAdminAuth(req)
      const db = getDb()

      const [userCounts, listCounts, todoCounts, recentRows] = await Promise.all([
        db.sql<{ count: number }>`
          SELECT count(*)::int AS count
          FROM public.users
        `,
        db.sql<{ count: number }>`
          SELECT count(*)::int AS count
          FROM public.todo_lists
        `,
        db.sql<{ total: number; completed: number }>`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE is_completed)::int AS completed
          FROM public.todos
        `,
        db.sql<{ id: string; last_login_at: Date | string; created_at: Date | string }>`
          SELECT id, last_login_at, created_at
          FROM public.users
          ORDER BY last_login_at DESC
          LIMIT 10
        `
      ])

      const totalTodos = todoCounts[0]?.total ?? 0
      const completedTodos = todoCounts[0]?.completed ?? 0

      return jsonResponse({
        generatedAt: new Date().toISOString(),
        totals: {
          users: userCounts[0]?.count ?? 0,
          lists: listCounts[0]?.count ?? 0,
          todos: totalTodos,
          activeTodos: totalTodos - completedTodos,
          completedTodos
        },
        recentLogins: recentRows.map(row => ({
          account: anonymizeUserId(row.id),
          lastLoginAt: toIsoString(row.last_login_at),
          joinedAt: toIsoString(row.created_at)
        }))
      })
    }

    throw new ApiError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED')
  } catch (err) {
    return handleRouteError(err)
  }
}

export const config: Config = {
  path: ['/api/admin/login', '/api/admin/logout', '/api/admin/report'],
  method: ['GET', 'POST']
}
