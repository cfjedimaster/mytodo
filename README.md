# My To Do

A calm, focused daily task manager inspired by Microsoft To Do and styled with the Uninote light & dark palette. Built as an installable web app using Vite, Alpine.js, vanilla CSS/JS, vanilla Google OAuth 2.0 (Authorization Code + PKCE), authenticated Netlify Functions, and Netlify Database (Postgres).

## Features

- **Marketing page & Google sign-in** (`/` and `/login`)
- **My Day**: Automatically surfaces all tasks due today (calendar-date accurate without timezone drift)
- **Default Tasks list**: Always-available main inbox
- **Custom Lists & List Groups**: Create color-coded custom lists and organize them into collapsible sidebar groups
- **Rich Task Details**:
  - Title & free-form Note (debounced cloud autosave)
  - Checkable Steps list (add, edit, check off, delete)
  - Due date (Today / Tomorrow / Next week presets + calendar picker)
  - Reminder date & time (presets + live in-app reminder toast & desktop alerts)
  - Repeat pattern (`Daily`, `Weekly`, `Monthly`, `Yearly` — completing a repeating task atomically creates the next occurrence with unchecked steps)
  - Completion status with a collapsible **Completed** section (collapsed by default)
- **Global Search**: Instant search across all task titles, notes, and steps
- **Light & Dark Mode**: Follows OS preference automatically with a manual toggle
- **Installable PWA & Offline Support**: Web App Manifest, app-shell service worker, and IndexedDB offline cache + outbox sync

---

## Architecture & Security

- **Database**: Managed Postgres via `@netlify/database`. Migrations live in [`netlify/database/migrations/`](./netlify/database/migrations/) and are applied automatically by Netlify on deploy (isolated database branches for Deploy Previews, production DB on publish).
- **Vanilla Google OAuth 2.0**: Handled entirely server-side in [`netlify/functions/auth.mts`](./netlify/functions/auth.mts) using Authorization Code + PKCE (`S256`) + signed `state` cookie (`HttpOnly; SameSite=Lax`) and HMAC-SHA256 signed `HttpOnly` session cookies (`mytodo_session`). No client secrets or auth tokens are exposed to browser JavaScript.
- **Server-Side API**: All data operations run through authenticated v2 Netlify Functions under [`netlify/functions/`](./netlify/functions/) (`/api/workspace`, `/api/groups`, `/api/lists`, `/api/todos`, `/api/steps`). The browser never accesses the database directly.
- **Tenant Isolation (Replacing RLS)**:
  - Every API route verifies the signed `mytodo_session` cookie server-side and rejects unauthenticated requests (`401`).
  - Every mutating request (`POST`, `PATCH`, `DELETE`) enforces same-origin CSRF checks (`Origin` header match, `403` on mismatch).
  - Every SQL query uses auto-parameterized bindings and scopes reads/writes strictly to `user_id = user.id` (Google's immutable `sub`) from the verified session.
  - Postgres composite foreign keys (`(id, user_id)`) enforce cross-tenant isolation at the schema level as defense in depth.
  - All `/api/*` responses return `Cache-Control: no-store, private`.

---

## Setup

### 1. Google Cloud Console OAuth Settings

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID**:

- **Authorized redirect URIs**:
  - `https://mytodo.raymondcamden.com/api/auth/google/callback` (production)
  - `http://localhost:8888/api/auth/google/callback` (optional, for local `netlify dev`)
- Remove the old Supabase callback URI (`https://<project-ref>.supabase.co/auth/v1/callback`).

### 2. Environment Variables

Set these server-side environment variables in **Netlify → Project configuration → Environment variables** (scoped to Functions) and in local `.env` for `netlify dev`:

```dotenv
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
# Generate a strong random value with: openssl rand -hex 32
SESSION_SECRET=your-random-secret
```

Netlify automatically injects `NETLIFY_DB_URL` at runtime.

### 3. Local Development & Migrations

```bash
npm install
netlify dev
# In another terminal while netlify dev is running:
npm run db:migrate
```

Open `http://localhost:8888` — both the local Postgres database and vanilla Google OAuth work locally under `netlify dev`.

---

## Testing & Build

Run database schema, OAuth, API, and cross-tenant security integration tests (uses an ephemeral local Postgres via `@netlify/database-dev`):

```bash
npm test
```

Build for production:

```bash
npm run build
```
