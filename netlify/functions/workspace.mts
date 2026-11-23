import type { Config } from '@netlify/functions'
import { requireAuth } from '../lib/auth.ts'
import { getDb } from '../lib/db.ts'
import { handleRouteError, jsonResponse } from '../lib/http.ts'
import {
  mapGroup,
  mapList,
  mapTodo,
  type GroupRow,
  type ListRow,
  type StepRow,
  type TodoRow
} from '../lib/mappers.ts'

export default async (req: Request): Promise<Response> => {
  try {
    const user = requireAuth(req)
    const db = getDb()
    const pathname = new URL(req.url).pathname

    if (pathname === '/api/workspace/ids') {
      const [groups, lists, todos, steps] = await Promise.all([
        db.sql<{ id: string }>`
          SELECT id
          FROM public.list_groups
          WHERE user_id = ${user.id}
        `,
        db.sql<{ id: string }>`
          SELECT id
          FROM public.todo_lists
          WHERE user_id = ${user.id}
        `,
        db.sql<{ id: string; is_completed: boolean }>`
          SELECT id, is_completed
          FROM public.todos
          WHERE user_id = ${user.id}
        `,
        db.sql<{ id: string }>`
          SELECT id
          FROM public.todo_steps
          WHERE user_id = ${user.id}
        `
      ])

      return jsonResponse({
        groupIds: groups.map(r => r.id),
        listIds: lists.map(r => r.id),
        todoIds: todos.map(r => r.id),
        completedTodoIds: todos.filter(r => r.is_completed).map(r => r.id),
        stepIds: steps.map(r => r.id)
      })
    }

    const [groups, lists, todos, steps] = await Promise.all([
      db.sql<GroupRow>`
        SELECT id, name, position, created_at
        FROM public.list_groups
        WHERE user_id = ${user.id}
        ORDER BY position ASC, created_at ASC
      `,
      db.sql<ListRow>`
        SELECT id, group_id, name, color, position, created_at
        FROM public.todo_lists
        WHERE user_id = ${user.id}
        ORDER BY position ASC, created_at ASC
      `,
      db.sql<TodoRow>`
        SELECT
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
        FROM public.todos
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC
      `,
      db.sql<StepRow>`
        SELECT id, todo_id, title, is_completed, position, created_at
        FROM public.todo_steps
        WHERE user_id = ${user.id}
        ORDER BY position ASC, created_at ASC
      `
    ])

    const stepsByTodoId = new Map<string, StepRow[]>()
    for (const step of steps) {
      const existing = stepsByTodoId.get(step.todo_id)
      if (existing) {
        existing.push(step)
      } else {
        stepsByTodoId.set(step.todo_id, [step])
      }
    }

    return jsonResponse({
      groups: groups.map(mapGroup),
      lists: lists.map(mapList),
      todos: todos.map(todo => mapTodo(todo, stepsByTodoId.get(todo.id) ?? []))
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

export const config: Config = {
  path: ['/api/workspace', '/api/workspace/ids'],
  method: ['GET']
}
