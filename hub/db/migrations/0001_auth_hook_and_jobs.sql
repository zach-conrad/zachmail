-- Allowlist: Supabase "Before User Created" auth hook. Enable it in
-- Dashboard → Authentication → Hooks → Before User Created → Postgres → public.hook_before_user_created.
CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.allowed_users
    WHERE lower(email) = lower(event->'user'->>'email')
  ) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'This ZachMail is private.')
  );
END;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) FROM authenticated, anon, public;--> statement-breakpoint
GRANT SELECT ON public.allowed_users TO supabase_auth_admin;--> statement-breakpoint

-- Wake the worker immediately when a job is enqueued (it also polls as a fallback).
CREATE OR REPLACE FUNCTION public.notify_job_enqueued()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('jobs', NEW.kind);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER jobs_notify AFTER INSERT ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.notify_job_enqueued();--> statement-breakpoint

-- Atomically claim up to n ready jobs for a worker.
CREATE OR REPLACE FUNCTION public.claim_jobs(worker text, n int DEFAULT 10)
RETURNS SETOF public.jobs
LANGUAGE sql
AS $$
  UPDATE public.jobs j
  SET locked_by = worker, locked_at = now(), attempts = j.attempts + 1
  WHERE j.id IN (
    SELECT id FROM public.jobs
    WHERE locked_by IS NULL AND run_at <= now()
    ORDER BY run_at
    LIMIT n
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_jobs(text, int) FROM authenticated, anon, public;--> statement-breakpoint

-- Release jobs whose worker died mid-run (locked for more than 10 minutes).
CREATE OR REPLACE FUNCTION public.reap_stale_jobs()
RETURNS int
LANGUAGE sql
AS $$
  WITH r AS (
    UPDATE public.jobs SET locked_by = NULL, locked_at = NULL
    WHERE locked_by IS NOT NULL AND locked_at < now() - interval '10 minutes'
    RETURNING 1
  )
  SELECT count(*)::int FROM r;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reap_stale_jobs() FROM authenticated, anon, public;
