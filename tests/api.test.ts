import { NetlifyDB } from '@netlify/database-dev'
import type { Context } from '@netlify/functions'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import adminHandler from '../netlify/functions/admin.mts'
import authHandler from '../netlify/functions/auth.mts'
import groupsHandler from '../netlify/functions/groups.mts'
import listsHandler from '../netlify/functions/lists.mts'
import stepsHandler from '../netlify/functions/steps.mts'
import todosHandler from '../netlify/functions/todos.mts'
import workspaceHandler from '../netlify/functions/workspace.mts'
import {
  ADMIN_COOKIE_NAME,
  createSessionCookie,
  SESSION_COOKIE_NAME,
  type AuthenticatedUser
} from '../netlify/lib/auth.ts'
import { getDb, resetDb } from '../netlify/lib/db.ts'

const ORIGIN = 'https://mytodo.raymondcamden.com'
const USER_A: AuthenticatedUser = {
  id: '100000000000000000001',
  email: 'alice@example.com',
  name: 'Alice Example'
}
const USER_B: AuthenticatedUser = {
  id: '200000000000000000002',
  email: 'bob@example.com',
  name: 'Bob Example'
}

let netlifyDb: NetlifyDB

function makeContext(params: Record<string, string> = {}): Context {
  return { params } as unknown as Context
}

function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]
}

function sessionCookieFor(user: AuthenticatedUser): string {
  return cookiePairFromSetCookie(createSessionCookie(user, `${ORIGIN}/api/auth/google/callback`))
}

function makeRequest(
  path: string,
  {
    method = 'GET',
    body,
    user = null,
    cookie,
    origin = ORIGIN,
    includeOrigin = method !== 'GET'
  }: {
    method?: string
    body?: unknown
    user?: AuthenticatedUser | null
    cookie?: string
    origin?: string
    includeOrigin?: boolean
  } = {}
): Request {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cookie) {
    headers.Cookie = cookie
  } else if (user) {
    headers.Cookie = sessionCookieFor(user)
  }
  if (includeOrigin && origin) {
    headers.Origin = origin
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return new Request(`${ORIGIN}${path}`, init)
}

async function readJson(res: Response) {
  return res.json() as Promise<Record<string, any>>
}

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
  process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef'
  process.env.ADMIN_PASSWORD = 'test-admin-password'

  netlifyDb = new NetlifyDB()
  const connectionString = await netlifyDb.start()
  await netlifyDb.applyMigrations('./netlify/database/migrations')
  process.env.NETLIFY_DB_URL = connectionString
}, 60_000)

afterAll(async () => {
  await resetDb()
  if (netlifyDb) {
    await netlifyDb.stop()
  }
})

beforeEach(async () => {
  const db = getDb()
  await db.sql`TRUNCATE public.todo_steps, public.todos, public.todo_lists, public.list_groups, public.users CASCADE`
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Vanilla Google OAuth 2.0 + PKCE and signed session cookies', () => {
  it('completes OAuth login flow, sets HttpOnly Secure session cookie, and rejects tampered cookies', async () => {
    // 1. Unauthenticated status
    const statusBefore = await authHandler(makeRequest('/api/auth/status'))
    expect(statusBefore.status).toBe(200)
    expect(await readJson(statusBefore)).toEqual({ configured: true, user: null })

    // 2. Start OAuth redirect with PKCE + state cookie
    const startRes = await authHandler(makeRequest('/api/auth/google'))
    expect(startRes.status).toBe(302)
    const location = new URL(startRes.headers.get('location')!)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com')
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/google/callback`)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    const state = location.searchParams.get('state')!
    expect(state).toBeTruthy()

    const oauthSetCookie = startRes.headers.get('set-cookie')!
    expect(oauthSetCookie).toContain('HttpOnly')
    expect(oauthSetCookie).toContain('SameSite=Lax')
    expect(oauthSetCookie).toContain('Secure')
    const oauthCookiePair = cookiePairFromSetCookie(oauthSetCookie)

    // 3. Mismatched state is rejected cleanly
    const badStateRes = await authHandler(
      makeRequest(`/api/auth/google/callback?code=abc&state=wrong-state`, {
        cookie: oauthCookiePair
      })
    )
    expect(badStateRes.status).toBe(302)
    expect(badStateRes.headers.get('location')).toContain('/login?error=')

    // 4. Valid callback exchanges code + PKCE verifier with Google and issues signed session cookie
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const target = String(input)
      if (target === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'google-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (target === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(
          JSON.stringify({
            sub: USER_A.id,
            email: USER_A.email,
            email_verified: true,
            name: USER_A.name
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`Unexpected fetch URL: ${target}`)
    })

    const callbackRes = await authHandler(
      makeRequest(`/api/auth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`, {
        cookie: oauthCookiePair
      })
    )
    expect(callbackRes.status).toBe(302)
    expect(callbackRes.headers.get('location')).toBe(`${ORIGIN}/app`)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const setCookies = callbackRes.headers.getSetCookie()
    const sessionSetCookie = setCookies.find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))!
    expect(sessionSetCookie).toContain('HttpOnly')
    expect(sessionSetCookie).toContain('SameSite=Lax')
    expect(sessionSetCookie).toContain('Secure')
    const sessionCookiePair = cookiePairFromSetCookie(sessionSetCookie)

    // 5. Issued cookie authenticates /api/auth/status and /api/workspace, and user login was recorded
    const db = getDb()
    const recordedUsers = await db.sql<{ id: string; email: string; name: string; last_login_at: Date }>`
      SELECT id, email, name, last_login_at FROM public.users WHERE id = ${USER_A.id}
    `
    expect(recordedUsers).toHaveLength(1)
    expect(recordedUsers[0].email).toBe(USER_A.email)
    expect(recordedUsers[0].name).toBe(USER_A.name)
    expect(recordedUsers[0].last_login_at).toBeTruthy()

    const statusAfter = await authHandler(
      makeRequest('/api/auth/status', { cookie: sessionCookiePair })
    )
    expect(await readJson(statusAfter)).toEqual({
      configured: true,
      user: {
        id: USER_A.id,
        email: USER_A.email,
        user_metadata: { full_name: USER_A.name }
      }
    })

    const wsRes = await workspaceHandler(
      makeRequest('/api/workspace', { cookie: sessionCookiePair })
    )
    expect(wsRes.status).toBe(200)

    // 6. Tampered cookie is rejected with 401
    const tamperedCookie = `${sessionCookiePair.slice(0, -1)}${
      sessionCookiePair.endsWith('a') ? 'b' : 'a'
    }`
    const tamperedRes = await workspaceHandler(
      makeRequest('/api/workspace', { cookie: tamperedCookie })
    )
    expect(tamperedRes.status).toBe(401)

    // 7. Logout enforces same-origin and clears cookie
    const badLogout = await authHandler(
      makeRequest('/api/auth/logout', {
        method: 'POST',
        cookie: sessionCookiePair,
        origin: 'https://evil.example'
      })
    )
    expect(badLogout.status).toBe(403)

    const logoutRes = await authHandler(
      makeRequest('/api/auth/logout', { method: 'POST', cookie: sessionCookiePair })
    )
    expect(logoutRes.status).toBe(200)
    expect(logoutRes.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=;`)
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('Authentication, CSRF, and validation', () => {
  it('rejects unauthenticated requests with 401 and no-store cache headers', async () => {
    const res = await workspaceHandler(makeRequest('/api/workspace'))
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const data = await readJson(res)
    expect(data.code).toBe('UNAUTHORIZED')

    const groupRes = await groupsHandler(
      makeRequest('/api/groups', { method: 'POST', body: { name: 'Work' } }),
      makeContext()
    )
    expect(groupRes.status).toBe(401)
  })

  it('blocks cross-origin and missing-origin mutations with 403', async () => {
    const evilRes = await groupsHandler(
      makeRequest('/api/groups', {
        method: 'POST',
        user: USER_A,
        body: { name: 'Evil' },
        origin: 'https://evil.example'
      }),
      makeContext()
    )
    expect(evilRes.status).toBe(403)
    expect((await readJson(evilRes)).code).toBe('FORBIDDEN_ORIGIN')

    const noOriginRes = await groupsHandler(
      makeRequest('/api/groups', {
        method: 'POST',
        user: USER_A,
        body: { name: 'NoOrigin' },
        includeOrigin: false
      }),
      makeContext()
    )
    expect(noOriginRes.status).toBe(403)
  })

  it('rejects invalid UUIDs, colors, repeat patterns, and empty names with 400', async () => {
    const badGroup = await groupsHandler(
      makeRequest('/api/groups', { method: 'POST', user: USER_A, body: { name: '   ' } }),
      makeContext()
    )
    expect(badGroup.status).toBe(400)

    const badColor = await listsHandler(
      makeRequest('/api/lists', {
        method: 'POST',
        user: USER_A,
        body: { name: 'L', color: 'neon' }
      }),
      makeContext()
    )
    expect(badColor.status).toBe(400)

    const badRepeat = await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_A,
        body: { title: 'Task', repeatPattern: 'hourly' }
      }),
      makeContext()
    )
    expect(badRepeat.status).toBe(400)

    const badId = await todosHandler(
      makeRequest('/api/todos/not-a-uuid', {
        method: 'PATCH',
        user: USER_A,
        body: { title: 'X' }
      }),
      makeContext({ id: 'not-a-uuid' })
    )
    expect(badId.status).toBe(400)
  })
})

describe('Workspace CRUD, repeating tasks, restore, and DB constraints', () => {
  it('supports full lifecycle with exact ISO dueDate, updated_at trigger, and fts vector', async () => {
    const groupRes = await groupsHandler(
      makeRequest('/api/groups', {
        method: 'POST',
        user: USER_A,
        body: { name: 'Personal', position: 1 }
      }),
      makeContext()
    )
    expect(groupRes.status).toBe(201)
    const group = await readJson(groupRes)

    const listRes = await listsHandler(
      makeRequest('/api/lists', {
        method: 'POST',
        user: USER_A,
        body: { name: 'Groceries', color: 'mint', groupId: group.id }
      }),
      makeContext()
    )
    expect(listRes.status).toBe(201)
    const list = await readJson(listRes)

    const todoRes = await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_A,
        body: {
          title: 'Buy espresso beans',
          listId: list.id,
          dueDate: '2026-11-23',
          reminderAt: '2026-11-23T15:00:00.000Z',
          repeatPattern: 'weekly',
          note: 'Medium roast'
        }
      }),
      makeContext()
    )
    expect(todoRes.status).toBe(201)
    const todo = await readJson(todoRes)
    expect(todo.dueDate).toBe('2026-11-23')

    const step1 = await readJson(
      await stepsHandler(
        makeRequest('/api/steps', {
          method: 'POST',
          user: USER_A,
          body: { todoId: todo.id, title: 'Check grinder', position: 0 }
        }),
        makeContext()
      )
    )
    const step2 = await readJson(
      await stepsHandler(
        makeRequest('/api/steps', {
          method: 'POST',
          user: USER_A,
          body: { todoId: todo.id, title: 'Visit roaster', isCompleted: true, position: 1 }
        }),
        makeContext()
      )
    )

    const ws = await readJson(await workspaceHandler(makeRequest('/api/workspace', { user: USER_A })))
    expect(ws.groups).toHaveLength(1)
    expect(ws.lists).toHaveLength(1)
    expect(ws.todos).toHaveLength(1)
    expect(ws.todos[0].dueDate).toBe('2026-11-23')
    expect(ws.todos[0].steps.map((s: any) => s.id)).toEqual([step1.id, step2.id])

    const ids = await readJson(
      await workspaceHandler(makeRequest('/api/workspace/ids', { user: USER_A }))
    )
    expect(ids.groupIds).toEqual([group.id])
    expect(ids.listIds).toEqual([list.id])
    expect(ids.todoIds).toEqual([todo.id])
    expect(ids.completedTodoIds).toEqual([])
    expect(ids.stepIds.sort()).toEqual([step1.id, step2.id].sort())

    const db = getDb()
    const ftsMatch = await db.sql<{ id: string }>`
      SELECT id FROM public.todos
      WHERE user_id = ${USER_A.id}
        AND fts @@ plainto_tsquery('english', 'espresso roast')
    `
    expect(ftsMatch.map(r => r.id)).toEqual([todo.id])

    const repeatRes = await todosHandler(
      makeRequest(`/api/todos/${todo.id}/complete-repeat`, {
        method: 'POST',
        user: USER_A,
        body: {
          nextDueDate: '2026-11-30',
          nextReminderAt: '2026-11-30T15:00:00.000Z'
        }
      }),
      makeContext({ id: todo.id })
    )
    expect(repeatRes.status).toBe(200)
    const repeatData = await readJson(repeatRes)
    expect(repeatData.updatedTodo.isCompleted).toBe(true)
    expect(repeatData.nextTodo.dueDate).toBe('2026-11-30')
    expect(repeatData.nextTodo.steps).toHaveLength(2)
    expect(repeatData.nextTodo.steps.every((s: any) => s.isCompleted === false)).toBe(true)

    const delGroupRes = await groupsHandler(
      makeRequest(`/api/groups/${group.id}`, { method: 'DELETE', user: USER_A }),
      makeContext({ id: group.id })
    )
    expect(delGroupRes.status).toBe(200)
    const wsAfterGroupDel = await readJson(
      await workspaceHandler(makeRequest('/api/workspace', { user: USER_A }))
    )
    expect(wsAfterGroupDel.groups).toHaveLength(0)
    expect(wsAfterGroupDel.lists[0].groupId).toBeNull()

    const restoreRes = await todosHandler(
      makeRequest('/api/todos/restore', {
        method: 'POST',
        user: USER_A,
        body: {
          title: 'Restored task',
          listId: list.id,
          dueDate: '2026-12-01',
          note: 'Back again',
          isCompleted: true,
          steps: [
            { title: 'Step A', isCompleted: true },
            { title: 'Step B', isCompleted: false }
          ]
        }
      }),
      makeContext()
    )
    expect(restoreRes.status).toBe(201)
    const restored = await readJson(restoreRes)
    expect(restored.steps).toHaveLength(2)
  })
})

describe('Cross-tenant isolation (RLS replacement)', () => {
  it('completely isolates User A and User B across every endpoint and database FK', async () => {
    const groupA = await readJson(
      await groupsHandler(
        makeRequest('/api/groups', { method: 'POST', user: USER_A, body: { name: 'Alice Group' } }),
        makeContext()
      )
    )
    const listA = await readJson(
      await listsHandler(
        makeRequest('/api/lists', {
          method: 'POST',
          user: USER_A,
          body: { name: 'Alice List', groupId: groupA.id }
        }),
        makeContext()
      )
    )
    const todoA = await readJson(
      await todosHandler(
        makeRequest('/api/todos', {
          method: 'POST',
          user: USER_A,
          body: { title: 'Alice Secret', listId: listA.id, repeatPattern: 'daily' }
        }),
        makeContext()
      )
    )
    const stepA = await readJson(
      await stepsHandler(
        makeRequest('/api/steps', {
          method: 'POST',
          user: USER_A,
          body: { todoId: todoA.id, title: 'Alice Step' }
        }),
        makeContext()
      )
    )

    // User B sees nothing
    const wsB = await readJson(await workspaceHandler(makeRequest('/api/workspace', { user: USER_B })))
    expect(wsB).toEqual({ groups: [], lists: [], todos: [] })

    // User B cannot PATCH User A's records
    expect(
      (
        await groupsHandler(
          makeRequest(`/api/groups/${groupA.id}`, {
            method: 'PATCH',
            user: USER_B,
            body: { name: 'Hacked' }
          }),
          makeContext({ id: groupA.id })
        )
      ).status
    ).toBe(404)

    expect(
      (
        await listsHandler(
          makeRequest(`/api/lists/${listA.id}`, {
            method: 'PATCH',
            user: USER_B,
            body: { name: 'Hacked' }
          }),
          makeContext({ id: listA.id })
        )
      ).status
    ).toBe(404)

    expect(
      (
        await todosHandler(
          makeRequest(`/api/todos/${todoA.id}`, {
            method: 'PATCH',
            user: USER_B,
            body: { title: 'Hacked' }
          }),
          makeContext({ id: todoA.id })
        )
      ).status
    ).toBe(404)

    expect(
      (
        await stepsHandler(
          makeRequest(`/api/steps/${stepA.id}`, {
            method: 'PATCH',
            user: USER_B,
            body: { title: 'Hacked' }
          }),
          makeContext({ id: stepA.id })
        )
      ).status
    ).toBe(404)

    // User B cannot attach records to User A's parent IDs
    expect(
      (
        await listsHandler(
          makeRequest('/api/lists', {
            method: 'POST',
            user: USER_B,
            body: { name: 'Sneaky List', groupId: groupA.id }
          }),
          makeContext()
        )
      ).status
    ).toBe(404)

    expect(
      (
        await todosHandler(
          makeRequest('/api/todos', {
            method: 'POST',
            user: USER_B,
            body: { title: 'Sneaky Task', listId: listA.id }
          }),
          makeContext()
        )
      ).status
    ).toBe(404)

    expect(
      (
        await stepsHandler(
          makeRequest('/api/steps', {
            method: 'POST',
            user: USER_B,
            body: { todoId: todoA.id, title: 'Sneaky Step' }
          }),
          makeContext()
        )
      ).status
    ).toBe(404)

    expect(
      (
        await todosHandler(
          makeRequest(`/api/todos/${todoA.id}/complete-repeat`, {
            method: 'POST',
            user: USER_B,
            body: { nextDueDate: '2026-11-24', nextReminderAt: null }
          }),
          makeContext({ id: todoA.id })
        )
      ).status
    ).toBe(404)

    expect(
      (
        await todosHandler(
          makeRequest('/api/todos/restore', {
            method: 'POST',
            user: USER_B,
            body: { title: 'Sneaky Restore', listId: listA.id }
          }),
          makeContext()
        )
      ).status
    ).toBe(404)

    // User B cannot DELETE User A's records
    await stepsHandler(
      makeRequest(`/api/steps/${stepA.id}`, { method: 'DELETE', user: USER_B }),
      makeContext({ id: stepA.id })
    )
    await todosHandler(
      makeRequest(`/api/todos/${todoA.id}`, { method: 'DELETE', user: USER_B }),
      makeContext({ id: todoA.id })
    )
    await listsHandler(
      makeRequest(`/api/lists/${listA.id}`, { method: 'DELETE', user: USER_B }),
      makeContext({ id: listA.id })
    )
    await groupsHandler(
      makeRequest(`/api/groups/${groupA.id}`, { method: 'DELETE', user: USER_B }),
      makeContext({ id: groupA.id })
    )

    // Offline duplicate-ID conflict does not leak or overwrite User A's row
    const collideRes = await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_B,
        body: { id: todoA.id, title: 'Overwrite attempt' }
      }),
      makeContext()
    )
    expect(collideRes.status).toBe(409)
    expect((await readJson(collideRes)).code).toBe('CONFLICT')

    // Database composite FK blocks cross-tenant link directly in SQL
    const db = getDb()
    await expect(
      db.sql`
        INSERT INTO public.todos (user_id, list_id, title)
        VALUES (${USER_B.id}, ${listA.id}, 'Direct SQL cross-tenant attempt')
      `
    ).rejects.toThrow()

    // User A's data is 100% intact
    const wsA = await readJson(await workspaceHandler(makeRequest('/api/workspace', { user: USER_A })))
    expect(wsA.groups).toHaveLength(1)
    expect(wsA.lists).toHaveLength(1)
    expect(wsA.todos).toHaveLength(1)
    expect(wsA.todos[0].title).toBe('Alice Secret')
    expect(wsA.todos[0].steps).toHaveLength(1)

    // Same user replaying offline create with same UUID gets DUPLICATE_KEY
    const dupRes = await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_A,
        body: { id: todoA.id, title: 'Alice Secret' }
      }),
      makeContext()
    )
    expect(dupRes.status).toBe(409)
    expect((await readJson(dupRes)).code).toBe('DUPLICATE_KEY')
  })
})

describe('Admin authentication and privacy-safe usage report', () => {
  it('guards /api/admin/report, verifies password, and returns aggregate counts + anonymized last 10 logins', async () => {
    // 1. Unauthenticated and regular user sessions are both rejected with 401
    expect((await adminHandler(makeRequest('/api/admin/report'))).status).toBe(401)
    expect((await adminHandler(makeRequest('/api/admin/report', { user: USER_A }))).status).toBe(401)

    // 2. Cross-origin login blocked with 403; wrong password rejected with 401
    expect(
      (
        await adminHandler(
          makeRequest('/api/admin/login', {
            method: 'POST',
            body: { password: 'test-admin-password' },
            origin: 'https://evil.example'
          })
        )
      ).status
    ).toBe(403)

    expect(
      (
        await adminHandler(
          makeRequest('/api/admin/login', {
            method: 'POST',
            body: { password: 'wrong-password' }
          })
        )
      ).status
    ).toBe(401)

    // 3. Seed 12 users, 2 lists, and 3 todos (1 completed)
    const db = getDb()
    for (let i = 1; i <= 12; i++) {
      await db.sql`
        INSERT INTO public.users (id, email, name, last_login_at)
        VALUES (
          ${`google-sub-${i}`},
          ${`private-user-${i}@example.com`},
          ${`Private Name ${i}`},
          now() - make_interval(mins => ${12 - i})
        )
      `
    }

    const list1 = await readJson(
      await listsHandler(
        makeRequest('/api/lists', { method: 'POST', user: USER_A, body: { name: 'Secret List 1' } }),
        makeContext()
      )
    )
    await listsHandler(
      makeRequest('/api/lists', { method: 'POST', user: USER_B, body: { name: 'Secret List 2' } }),
      makeContext()
    )
    await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_A,
        body: { title: 'Private Task 1', listId: list1.id }
      }),
      makeContext()
    )
    await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_A,
        body: { title: 'Private Task 2', isCompleted: true }
      }),
      makeContext()
    )
    await todosHandler(
      makeRequest('/api/todos', {
        method: 'POST',
        user: USER_B,
        body: { title: 'Private Task 3' }
      }),
      makeContext()
    )

    // 4. Valid admin login sets HttpOnly Secure cookie
    const loginRes = await adminHandler(
      makeRequest('/api/admin/login', {
        method: 'POST',
        body: { password: 'test-admin-password' }
      })
    )
    expect(loginRes.status).toBe(200)
    const adminSetCookie = loginRes.headers.get('set-cookie')!
    expect(adminSetCookie).toContain(`${ADMIN_COOKIE_NAME}=`)
    expect(adminSetCookie).toContain('HttpOnly')
    expect(adminSetCookie).toContain('SameSite=Lax')
    expect(adminSetCookie).toContain('Secure')
    const adminCookiePair = cookiePairFromSetCookie(adminSetCookie)

    // 5. Fetch report and verify totals, cap of 10 logins, and zero PII/content leaks
    const reportRes = await adminHandler(
      makeRequest('/api/admin/report', { cookie: adminCookiePair })
    )
    expect(reportRes.status).toBe(200)
    expect(reportRes.headers.get('cache-control')).toContain('no-store')

    const report = await readJson(reportRes)
    expect(report.totals).toEqual({
      users: 12,
      lists: 2,
      todos: 3,
      activeTodos: 2,
      completedTodos: 1
    })
    expect(report.recentLogins).toHaveLength(10)
    expect(report.recentLogins[0].account).toMatch(/^User #[0-9a-f]{8}$/)

    // Verify descending order by lastLoginAt
    for (let i = 1; i < report.recentLogins.length; i++) {
      expect(Date.parse(report.recentLogins[i - 1].lastLoginAt)).toBeGreaterThanOrEqual(
        Date.parse(report.recentLogins[i].lastLoginAt)
      )
    }

    // Verify zero PII or user content appears anywhere in the JSON payload
    const rawPayload = JSON.stringify(report)
    expect(rawPayload).not.toContain('private-user-')
    expect(rawPayload).not.toContain('Private Name')
    expect(rawPayload).not.toContain('google-sub-')
    expect(rawPayload).not.toContain('Secret List')
    expect(rawPayload).not.toContain('Private Task')

    // 6. Logout clears admin cookie
    const logoutRes = await adminHandler(
      makeRequest('/api/admin/logout', { method: 'POST', cookie: adminCookiePair })
    )
    expect(logoutRes.status).toBe(200)
    expect(logoutRes.headers.get('set-cookie')).toContain(`${ADMIN_COOKIE_NAME}=;`)
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})
