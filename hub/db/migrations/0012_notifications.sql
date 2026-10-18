CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"keys" jsonb,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY DEFAULT auth.uid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"splits" text[] DEFAULT '{important}' NOT NULL,
	"vips" text[] DEFAULT '{}' NOT NULL,
	"muted_accounts" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token" ON "devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "devices_user" ON "devices" USING btree ("user_id","kind");--> statement-breakpoint
CREATE POLICY "devices_owner_read" ON "devices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "notification_settings_owner_read" ON "notification_settings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);