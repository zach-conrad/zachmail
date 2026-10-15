-- Full-text search over the mirror (architecture §7). Text is lowercased and split on anything
-- but letters and digits, the same rule as core's `tokenize`, so every client query compiles to
-- the same tokens. Weights: A subject, B sender, C recipients, D snippet + body.

CREATE FUNCTION public.search_words(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT pg_catalog.regexp_replace(pg_catalog.lower(COALESCE(t, '')), '[^[:alnum:]]+', ' ', 'g')
$$;--> statement-breakpoint

-- Names and addresses of one address object or an array of them.
CREATE FUNCTION public.search_addresses(a jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT COALESCE(pg_catalog.string_agg(COALESCE(x ->> 'name', '') || ' ' || COALESCE(x ->> 'email', ''), ' '), '')
  FROM pg_catalog.jsonb_array_elements(
    CASE pg_catalog.jsonb_typeof(a) WHEN 'array' THEN a WHEN 'object' THEN pg_catalog.jsonb_build_array(a)
    ELSE '[]'::jsonb END) AS x
$$;--> statement-breakpoint

CREATE FUNCTION public.message_search_doc(subject text, sender jsonb, recipients jsonb, snippet text, body text)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.search_words(subject)), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.search_words(public.search_addresses(sender))), 'B')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.search_words(public.search_addresses(recipients))), 'C')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple',
         public.search_words(COALESCE(snippet, '') || ' ' || pg_catalog.left(COALESCE(body, ''), 100000))), 'D')
$$;--> statement-breakpoint

-- Plain text of a cached body: the text part, else the sanitized HTML without tags.
CREATE FUNCTION public.body_search_text(b public.message_bodies) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(b.text, pg_catalog.regexp_replace(COALESCE(b.html, ''), '<[^>]*>', ' ', 'g'))
$$;--> statement-breakpoint

CREATE FUNCTION public.messages_search_trigger() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.search := public.message_search_doc(NEW.subject, NEW."from", NEW."to" || NEW.cc || NEW.bcc, NEW.snippet,
    (SELECT public.body_search_text(b) FROM public.message_bodies b WHERE b.message_id = NEW.id));
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER messages_search BEFORE INSERT OR UPDATE OF subject, "from", "to", cc, bcc, snippet
ON public.messages FOR EACH ROW EXECUTE FUNCTION public.messages_search_trigger();--> statement-breakpoint

-- A body landing in the cache makes its text searchable.
CREATE FUNCTION public.message_bodies_search_trigger() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  UPDATE public.messages m SET search = public.message_search_doc(m.subject, m."from", m."to" || m.cc || m.bcc,
    m.snippet, public.body_search_text(NEW))
  WHERE m.id = NEW.message_id;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER message_bodies_search AFTER INSERT OR UPDATE OF text, html
ON public.message_bodies FOR EACH ROW EXECUTE FUNCTION public.message_bodies_search_trigger();--> statement-breakpoint

UPDATE public.messages m SET search = public.message_search_doc(m.subject, m."from", m."to" || m.cc || m.bcc,
  m.snippet, (SELECT public.body_search_text(b) FROM public.message_bodies b WHERE b.message_id = m.id));--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.messages_search_trigger() FROM authenticated, anon, public;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.message_bodies_search_trigger() FROM authenticated, anon, public;
