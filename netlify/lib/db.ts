import { getDatabase, type DatabaseConnection } from '@netlify/database'

let cachedDb: DatabaseConnection | null = null

export function getDb(): DatabaseConnection {
  if (!cachedDb) {
    cachedDb = getDatabase()
  }
  return cachedDb
}

export async function resetDb(): Promise<void> {
  if (cachedDb) {
    try {
      await cachedDb.pool.end()
    } catch {
      // Ignore pool shutdown errors during test cleanup
    }
    cachedDb = null
  }
}

export async function withTransaction<T>(
  fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }) => Promise<T>
): Promise<T> {
  const db = getDb()
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> })
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Ignore rollback errors if connection already closed
    }
    throw err
  } finally {
    client.release()
  }
}
