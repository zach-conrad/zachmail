-- Clients subscribe to the private broadcast channel "user:<uid>" and pull /api/sync when it fires.
CREATE POLICY "user_channel_read" ON realtime.messages
FOR SELECT TO authenticated
USING (realtime.topic() = 'user:' || (SELECT auth.uid())::text AND extension = 'broadcast');--> statement-breakpoint

-- Called by server code after it writes `changes`; tells that user's clients the latest seq.
CREATE OR REPLACE FUNCTION public.nudge_user(uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  latest bigint;
BEGIN
  SELECT max(seq) INTO latest FROM public.changes WHERE user_id = uid;
  PERFORM realtime.send(jsonb_build_object('seq', latest), 'changed', 'user:' || uid::text, true);
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.nudge_user(uuid) FROM authenticated, anon, public;
