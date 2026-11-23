-- Add users table to track user accounts and last_login_at timestamps

CREATE TABLE IF NOT EXISTS public.users (
  id text PRIMARY KEY CHECK (char_length(btrim(id)) > 0),
  email text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_last_login_at_idx
  ON public.users (last_login_at DESC);

DROP TRIGGER IF EXISTS set_users_updated_at ON public.users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Backfill any existing user_ids already present in task tables
INSERT INTO public.users (id, created_at, updated_at, last_login_at)
SELECT
  existing.user_id,
  min(existing.created_at),
  now(),
  max(existing.updated_at)
FROM (
  SELECT user_id, created_at, updated_at FROM public.list_groups
  UNION ALL
  SELECT user_id, created_at, updated_at FROM public.todo_lists
  UNION ALL
  SELECT user_id, created_at, updated_at FROM public.todos
) AS existing
GROUP BY existing.user_id
ON CONFLICT (id) DO NOTHING;
