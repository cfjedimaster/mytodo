import { ApiError } from './http.ts'

export const LIST_COLORS = new Set(['pink', 'purple', 'blue', 'yellow', 'mint'])
export const REPEAT_PATTERNS = new Set(['daily', 'weekly', 'monthly', 'yearly'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new ApiError(400, 'Invalid JSON request body.', 'INVALID_JSON')
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object.', 'INVALID_JSON')
  }

  return body as Record<string, unknown>
}

export function requireUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new ApiError(400, `Invalid ${fieldName}.`, 'INVALID_INPUT')
  }
  return value.trim().toLowerCase()
}

export function optionalUuid(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  return requireUuid(value, fieldName)
}

export function requireTrimmedText(
  value: unknown,
  fieldName: string,
  maxLength = 500
): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, `${fieldName} is required.`, 'INVALID_INPUT')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new ApiError(400, `${fieldName} is required.`, 'INVALID_INPUT')
  }
  if (trimmed.length > maxLength) {
    throw new ApiError(400, `${fieldName} is too long.`, 'INVALID_INPUT')
  }
  return trimmed
}

export function optionalNote(value: unknown, maxLength = 20000): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new ApiError(400, 'Note must be text.', 'INVALID_INPUT')
  }
  if (value.length > maxLength) {
    throw new ApiError(400, 'Note is too long.', 'INVALID_INPUT')
  }
  return value
}

export function validateColor(value: unknown, fallback = 'purple'): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !LIST_COLORS.has(value)) {
    throw new ApiError(400, 'Invalid list color.', 'INVALID_INPUT')
  }
  return value
}

export function validateRepeatPattern(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !REPEAT_PATTERNS.has(value)) {
    throw new ApiError(400, 'Invalid repeat pattern.', 'INVALID_INPUT')
  }
  return value
}

export function validateIsoDate(value: unknown, fieldName = 'dueDate'): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new ApiError(400, `Invalid ${fieldName}.`, 'INVALID_INPUT')
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, `Invalid ${fieldName}.`, 'INVALID_INPUT')
  }
  return value
}

export function validateIsoTimestamp(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ApiError(400, `Invalid ${fieldName}.`, 'INVALID_INPUT')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, `Invalid ${fieldName}.`, 'INVALID_INPUT')
  }
  return parsed.toISOString()
}

export function validatePosition(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new ApiError(400, 'Invalid position.', 'INVALID_INPUT')
  }
  return value
}

export function validateBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'Expected a boolean value.', 'INVALID_INPUT')
  }
  return value
}
