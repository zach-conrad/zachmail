CREATE SCHEMA "hub";
--> statement-breakpoint
CREATE TABLE "hub"."links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"field_hlc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub"."links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub"."tombstones" (
	"kind" text NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"hlc" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tombstones_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
ALTER TABLE "hub"."tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub"."links" ADD CONSTRAINT "links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub"."tombstones" ADD CONSTRAINT "tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "links_from" ON "hub"."links" USING btree ("user_id","from_kind","from_id");--> statement-breakpoint
CREATE INDEX "links_to" ON "hub"."links" USING btree ("user_id","to_kind","to_id");--> statement-breakpoint
CREATE POLICY "links_owner_read" ON "hub"."links" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "tombstones_owner_read" ON "hub"."tombstones" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);