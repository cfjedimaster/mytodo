export async function getAuthStatus() {
  const response = await fetch('/api/auth/status', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  })

  if (!response.ok) {
    const err = new Error(`Auth check failed (${response.status}).`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  return {
    configured: Boolean(data?.configured),
    user: data?.user?.id ? data.user : null
  }
}

export async function getCurrentUser() {
  const { user } = await getAuthStatus()
  return user
}

export function startGoogleLogin() {
  window.location.assign('/api/auth/google')
}

export async function signOutUser() {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
}
