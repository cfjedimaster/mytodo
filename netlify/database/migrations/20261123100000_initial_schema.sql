-- My To Do — Netlify Database (Postgres) Initial Schema
-- Enforces tenant isolation at the database level via composite (id, user_id) foreign keys.

-- 1. Tables

-- Groups that organize custom lists in the sidebar
CREATE TABLE IF NOT EXISTS public.list_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL CHECK (char_length(btrim(user_id)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

-- Custom task lists (default "Tasks" list is represented by todos.list_id IS NULL)
CREATE TABLE IF NOT EXISTS public.todo_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL CHECK (char_length(btrim(user_id)) > 0),
  group_id uuid,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  color text NOT NULL DEFAULT 'purple' CHECK (color IN ('pink', 'purple', 'blue', 'yellow', 'mint')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT todo_lists_group_owner_fkey
    FOREIGN KEY (group_id, user_id)
    REFERENCES public.list_groups (id, user_id)
    ON DELETE SET NULL (group_id)
);

-- To Do items
CREATE TABLE IF NOT EXISTS public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL CHECK (char_length(btrim(user_id)) > 0),
  list_id uuid,
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  note text NOT NULL DEFAULT '',
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  due_date date,
  reminder_at timestamptz,
  repeat_pattern text CHECK (repeat_pattern IN ('daily', 'weekly', 'monthly', 'yearly')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(note, '')), 'B')
  ) STORED,
  UNIQUE (id, user_id),
  CONSTRAINT todos_list_owner_fkey
    FOREIGN KEY (list_id, user_id)
    REFERENCES public.todo_lists (id, user_id)
    ON DELETE CASCADE
);

-- Subtask steps belonging to a To Do item
CREATE TABLE IF NOT EXISTS public.todo_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL CHECK (char_length(btrim(user_id)) > 0),
  todo_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  is_completed boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT todo_steps_todo_owner_fkey
    FOREIGN KEY (todo_id, user_id)
    REFERENCES public.todos (id, user_id)
    ON DELETE CASCADE
);

-- 2. Indexes covering foreign keys, tenant filters, sort orders, and search

CREATE INDEX IF NOT EXISTS list_groups_user_id_position_idx
  ON public.list_groups (user_id, position, created_at);

CREATE INDEX IF NOT EXISTS todo_lists_user_id_position_idx
  ON public.todo_lists (user_id, position, created_at);

CREATE INDEX IF NOT EXISTS todo_lists_group_id_user_id_idx
  ON public.todo_lists (group_id, user_id);

CREATE INDEX IF NOT EXISTS todos_user_id_due_date_idx
  ON public.todos (user_id, due_date);

CREATE INDEX IF NOT EXISTS todos_user_id_list_id_completed_idx
  ON public.todos (user_id, list_id, is_completed, created_at DESC);

CREATE INDEX IF NOT EXISTS todos_list_id_user_id_idx
  ON public.todos (list_id, user_id);

CREATE INDEX IF NOT EXISTS todos_fts_idx
  ON public.todos USING gin (fts);

CREATE INDEX IF NOT EXISTS todo_steps_user_id_todo_id_position_idx
  ON public.todo_steps (user_id, todo_id, position, created_at);

CREATE INDEX IF NOT EXISTS todo_steps_todo_id_user_id_idx
  ON public.todo_steps (todo_id, user_id);

-- 3. Maintain updated_at automatically on edits

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_list_groups_updated_at ON public.list_groups;
CREATE TRIGGER set_list_groups_updated_at
  BEFORE UPDATE ON public.list_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_todo_lists_updated_at ON public.todo_lists;
CREATE TRIGGER set_todo_lists_updated_at
  BEFORE UPDATE ON public.todo_lists
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_todos_updated_at ON public.todos;
CREATE TRIGGER set_todos_updated_at
  BEFORE UPDATE ON public.todos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_todo_steps_updated_at ON public.todo_steps;
CREATE TRIGGER set_todo_steps_updated_at
  BEFORE UPDATE ON public.todo_steps
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
