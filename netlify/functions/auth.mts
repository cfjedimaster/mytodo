import type { Config } from '@netlify/functions'
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createOAuthStateCookie,
  createPkceChallenge,
  createSessionCookie,
  generateRandomToken,
  getOAuthConfig,
  getSessionUser,
  requireSameOrigin,
  safeEqual,
  verifyOAuthStateCookie
} from '../lib/auth.ts'
import { ApiError, handleRouteError, jsonResponse } from '../lib/http.ts'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

function redirectToLoginError(origin: string, message: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location: `${origin}/login?error=${encodeURIComponent(message)}`,
    'cache-control': 'no-store, private'
  })
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie)
  }
  return new Response(null, { status: 302, headers })
}

export default async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url)
    const pathname = url.pathname
    const method = req.method.toUpperCase()
    const oauthConfig = getOAuthConfig()

    // GET /api/auth/status — returns whether OAuth is configured and the current signed-in user
    if (method === 'GET' && pathname === '/api/auth/status') {
      const user = getSessionUser(req)
      return jsonResponse({
        configured: oauthConfig.isConfigured,
        user: user
          ? {
              id: user.id,
              email: user.email,
              user_metadata: {
                full_name: user.name
              }
            }
          : null
      })
    }

    // GET /api/auth/google — initiate vanilla Google OAuth 2.0 + PKCE redirect
    if (method === 'GET' && pathname === '/api/auth/google') {
      if (!oauthConfig.isConfigured) {
        return redirectToLoginError(url.origin, 'Sign-in is not configured yet.')
      }

      const state = generateRandomToken(32)
      const codeVerifier = generateRandomToken(32)
      const codeChallenge = createPkceChallenge(codeVerifier)
      const redirectUri = `${url.origin}/api/auth/google/callback`

      const authUrl = new URL(GOOGLE_AUTH_URL)
      authUrl.searchParams.set('client_id', oauthConfig.clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('scope', 'openid email profile')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('prompt', 'select_account')

      const headers = new Headers({
        location: authUrl.toString(),
        'cache-control': 'no-store, private'
      })
      headers.append('set-cookie', createOAuthStateCookie({ state, codeVerifier }, req.url))

      return new Response(null, { status: 302, headers })
    }

    // GET /api/auth/google/callback — verify state, exchange code + PKCE, set HttpOnly session cookie
    if (method === 'GET' && pathname === '/api/auth/google/callback') {
      const clearState = clearOAuthStateCookie(req.url)

      if (!oauthConfig.isConfigured) {
        return redirectToLoginError(url.origin, 'Sign-in is not configured yet.', [clearState])
      }

      const oauthError = url.searchParams.get('error')
      if (oauthError) {
        const message =
          oauthError === 'access_denied'
            ? 'Sign-in was canceled.'
            : 'Unable to complete sign-in. Please try again.'
        return redirectToLoginError(url.origin, message, [clearState])
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const storedState = verifyOAuthStateCookie(req)

      if (!code || !state || !storedState || !safeEqual(state, storedState.state)) {
        return redirectToLoginError(
          url.origin,
          'Sign-in session expired or did not match. Please try again.',
          [clearState]
        )
      }

      const redirectUri = `${url.origin}/api/auth/google/callback`
      const tokenBody = new URLSearchParams({
        code,
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: storedState.codeVerifier
      })

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body: tokenBody.toString()
      })

      if (!tokenRes.ok) {
        console.error('Google token exchange failed:', tokenRes.status)
        return redirectToLoginError(
          url.origin,
          'Unable to complete sign-in. Please try again.',
          [clearState]
        )
      }

      const tokenData = (await tokenRes.json()) as { access_token?: string }
      if (!tokenData.access_token) {
        return redirectToLoginError(
          url.origin,
          'No access token was returned. Please try again.',
          [clearState]
        )
      }

      const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: {
          authorization: `Bearer ${tokenData.access_token}`,
          accept: 'application/json'
        }
      })

      if (!userInfoRes.ok) {
        console.error('Google userinfo request failed:', userInfoRes.status)
        return redirectToLoginError(
          url.origin,
          'Unable to load your Google profile. Please try again.',
          [clearState]
        )
      }

      const profile = (await userInfoRes.json()) as {
        sub?: string
        email?: string
        email_verified?: boolean
        name?: string
      }

      if (!profile.sub || typeof profile.sub !== 'string' || !profile.sub.trim()) {
        return redirectToLoginError(
          url.origin,
          'Unable to verify your Google account.',
          [clearState]
        )
      }

      if (profile.email_verified === false) {
        return redirectToLoginError(
          url.origin,
          'Your Google email address must be verified before signing in.',
          [clearState]
        )
      }

      const sessionCookie = createSessionCookie(
        {
          id: profile.sub.trim(),
          email: typeof profile.email === 'string' ? profile.email : '',
          name: typeof profile.name === 'string' ? profile.name : ''
        },
        req.url
      )

      const headers = new Headers({
        location: `${url.origin}/app`,
        'cache-control': 'no-store, private'
      })
      headers.append('set-cookie', clearState)
      headers.append('set-cookie', sessionCookie)

      return new Response(null, { status: 302, headers })
    }

    // POST /api/auth/logout — clear session cookie
    if (method === 'POST' && pathname === '/api/auth/logout') {
      requireSameOrigin(req)
      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, private'
      })
      headers.append('set-cookie', clearSessionCookie(req.url))

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    }

    throw new ApiError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED')
  } catch (err) {
    return handleRouteError(err)
  }
}

export const config: Config = {
  path: [
    '/api/auth/status',
    '/api/auth/google',
    '/api/auth/google/callback',
    '/api/auth/logout'
  ],
  method: ['GET', 'POST']
}
