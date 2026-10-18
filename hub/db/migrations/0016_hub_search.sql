-- pg_trgm for typo-tolerant title matching, in Supabase's `extensions` schema. References to it
-- are schema-qualified, so nothing depends on search_path.
CREATE SCHEMA IF NOT EXISTS extensions;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;--> statement-breakpoint
CREATE TABLE "hub"."search_index" (
	"entity_kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, public.search_words(title)), 'A') || setweight(to_tsvector('simple'::regconfig, public.search_words(left(body, 100000))), 'D')) STORED NOT NULL,
	CONSTRAINT "search_index_entity_kind_entity_id_pk" PRIMARY KEY("entity_kind","entity_id")
);
--> statement-breakpoint
ALTER TABLE "hub"."search_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub"."search_index" ADD CONSTRAINT "search_index_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_index_user_updated" ON "hub"."search_index" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "search_index_tsv" ON "hub"."search_index" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_index_title_trgm" ON "hub"."search_index" USING gin ("title" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "search_index_owner_read" ON "hub"."search_index" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);