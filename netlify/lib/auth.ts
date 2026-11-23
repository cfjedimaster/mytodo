import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from './http.ts'

export const SESSION_COOKIE_NAME = 'mytodo_session'
export const OAUTH_COOKIE_NAME = 'mytodo_oauth'

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const OAUTH_TTL_SECONDS = 60 * 10 // 10 minutes

export interface AuthenticatedUser {
  id: string
  email: string
  name: string
}

export interface OAuthStatePayload {
  state: string
  codeVerifier: string
  exp: number
}

interface SessionPayload {
  id: string
  email: string
  name: string
  iat: number
  exp: number
}

declare global {
  var Netlify: { env?: { get(key: string): string | undefined } } | undefined
}

export function getEnv(key: string): string {
  const fromNetlify =
    typeof globalThis.Netlify?.env?.get === 'function'
      ? globalThis.Netlify.env.get(key)
      : undefined
  const value = fromNetlify ?? process.env[key] ?? ''
  return typeof value === 'string' ? value.trim() : ''
}

export function getOAuthConfig() {
  const clientId = getEnv('GOOGLE_CLIENT_ID')
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')
  const sessionSecret = getEnv('SESSION_SECRET')

  return {
    clientId,
    clientSecret,
    sessionSecret,
    isConfigured: Boolean(clientId && clientSecret && sessionSecret.length >= 16)
  }
}

export function generateRandomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function signPayload(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifySignedPayload<T extends { exp?: number }>(token: string, secret: string): T | null {
  if (!token || !secret) return null
  const dotIdx = token.indexOf('.')
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf('.')) return null

  const encoded = token.slice(0, dotIdx)
  const providedSig = token.slice(dotIdx + 1)
  const expectedSig = createHmac('sha256', secret).update(encoded).digest('base64url')

  if (!safeEqual(providedSig, expectedSig)) return null

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
    const now = Math.floor(Date.now() / 1000)
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {}
  const result: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    const name = part.slice(0, eqIdx).trim()
    const value = part.slice(eqIdx + 1).trim()
    if (name) {
      result[name] = value
    }
  }
  return result
}

function isHttpsRequest(reqUrl: string): boolean {
  try {
    return new URL(reqUrl).protocol === 'https:'
  } catch {
    return true
  }
}

function formatCookie(
  name: string,
  value: string,
  { maxAge, path, secure }: { maxAge: number; path: string; secure: boolean }
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax'
  ]
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function createSessionCookie(user: AuthenticatedUser, reqUrl: string): string {
  const { sessionSecret } = getOAuthConfig()
  if (sessionSecret.length < 16) {
    throw new ApiError(500, 'Session signing secret is not configured.', 'CONFIG_ERROR')
  }

  const now = Math.floor(Date.now() / 1000)
  const token = signPayload(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      iat: now,
      exp: now + SESSION_TTL_SECONDS
    } satisfies SessionPayload,
    sessionSecret
  )

  return formatCookie(SESSION_COOKIE_NAME, token, {
    maxAge: SESSION_TTL_SECONDS,
    path: '/',
    secure: isHttpsRequest(reqUrl)
  })
}

export function clearSessionCookie(reqUrl: string): string {
  return formatCookie(SESSION_COOKIE_NAME, '', {
    maxAge: 0,
    path: '/',
    secure: isHttpsRequest(reqUrl)
  })
}

export function createOAuthStateCookie(
  { state, codeVerifier }: { state: string; codeVerifier: string },
  reqUrl: string
): string {
  const { sessionSecret } = getOAuthConfig()
  if (sessionSecret.length < 16) {
    throw new ApiError(500, 'Session signing secret is not configured.', 'CONFIG_ERROR')
  }

  const now = Math.floor(Date.now() / 1000)
  const token = signPayload(
    {
      state,
      codeVerifier,
      exp: now + OAUTH_TTL_SECONDS
    } satisfies OAuthStatePayload,
    sessionSecret
  )

  return formatCookie(OAUTH_COOKIE_NAME, token, {
    maxAge: OAUTH_TTL_SECONDS,
    path: '/api/auth',
    secure: isHttpsRequest(reqUrl)
  })
}

export function verifyOAuthStateCookie(req: Request): OAuthStatePayload | null {
  const { sessionSecret } = getOAuthConfig()
  if (sessionSecret.length < 16) return null

  const cookies = parseCookies(req.headers.get('cookie'))
  const raw = cookies[OAUTH_COOKIE_NAME]
  if (!raw) return null

  const payload = verifySignedPayload<OAuthStatePayload>(raw, sessionSecret)
  if (!payload || typeof payload.state !== 'string' || typeof payload.codeVerifier !== 'string') {
    return null
  }
  return payload
}

export function clearOAuthStateCookie(reqUrl: string): string {
  return formatCookie(OAUTH_COOKIE_NAME, '', {
    maxAge: 0,
    path: '/api/auth',
    secure: isHttpsRequest(reqUrl)
  })
}

export function getSessionUser(req: Request): AuthenticatedUser | null {
  const { sessionSecret } = getOAuthConfig()
  if (sessionSecret.length < 16) return null

  const cookies = parseCookies(req.headers.get('cookie'))
  const raw = cookies[SESSION_COOKIE_NAME]
  if (!raw) return null

  const payload = verifySignedPayload<SessionPayload>(raw, sessionSecret)
  if (!payload || typeof payload.id !== 'string' || !payload.id.trim()) {
    return null
  }

  return {
    id: payload.id.trim(),
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : ''
  }
}

export function requireAuth(req: Request): AuthenticatedUser {
  const user = getSessionUser(req)
  if (!user) {
    throw new ApiError(401, 'Authentication required.', 'UNAUTHORIZED')
  }
  return user
}

export function requireSameOrigin(req: Request): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return
  }

  const originHeader = req.headers.get('origin')
  if (!originHeader) {
    throw new ApiError(403, 'Cross-origin request blocked.', 'FORBIDDEN_ORIGIN')
  }

  let expectedOrigin: string
  try {
    expectedOrigin = new URL(req.url).origin
  } catch {
    throw new ApiError(403, 'Cross-origin request blocked.', 'FORBIDDEN_ORIGIN')
  }

  if (originHeader !== expectedOrigin) {
    throw new ApiError(403, 'Cross-origin request blocked.', 'FORBIDDEN_ORIGIN')
  }
}
