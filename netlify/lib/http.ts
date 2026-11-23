const PRIVATE_HEADERS = {
  'cache-control': 'no-store, private',
  'content-type': 'application/json; charset=utf-8'
}

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, message: string, code = 'BAD_REQUEST') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: PRIVATE_HEADERS
  })
}

export function errorResponse(status: number, message: string, code = 'ERROR'): Response {
  return jsonResponse({ error: message, code }, status)
}

export function handleRouteError(err: unknown): Response {
  if (err instanceof ApiError) {
    return errorResponse(err.status, err.message, err.code)
  }

  const pgCode = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : ''

  if (pgCode === '22P02') {
    return errorResponse(400, 'Invalid identifier or value format.', 'INVALID_INPUT')
  }
  if (pgCode === '23503') {
    return errorResponse(400, 'Referenced parent item was not found.', 'INVALID_REFERENCE')
  }
  if (pgCode === '23505') {
    return errorResponse(409, 'Item already exists.', 'DUPLICATE_KEY')
  }
  if (pgCode === '23514') {
    return errorResponse(400, 'One or more fields failed validation.', 'INVALID_INPUT')
  }

  console.error('Unhandled API error:', err)
  return errorResponse(500, 'An unexpected server error occurred.', 'INTERNAL_ERROR')
}
