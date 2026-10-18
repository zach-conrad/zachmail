CREATE SCHEMA "tasks";
--> statement-breakpoint
CREATE TABLE "tasks"."lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"field_hlc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"position" text DEFAULT 'a0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks"."lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"field_hlc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"list_id" uuid,
	"parent_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"due_date" date,
	"due_time" text,
	"alert_at" timestamp with time zone,
	"rrule" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" text DEFAULT 'a0' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks"."tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks"."lists" ADD CONSTRAINT "lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks"."tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lists_user" ON "tasks"."lists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_user_open" ON "tasks"."tasks" USING btree ("user_id","due_date") WHERE "tasks"."tasks"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_alerts" ON "tasks"."tasks" USING btree ("alert_at") WHERE "tasks"."tasks"."completed_at" IS NULL AND "tasks"."tasks"."alert_at" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "lists_owner_read" ON "tasks"."lists" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "tasks_owner_read" ON "tasks"."tasks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);