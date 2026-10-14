CREATE TABLE "split_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "split_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "split" text;--> statement-breakpoint
ALTER TABLE "split_rules" ADD CONSTRAINT "split_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "split_rules_user" ON "split_rules" USING btree ("user_id","position");--> statement-breakpoint
CREATE POLICY "split_rules_owner_read" ON "split_rules" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);