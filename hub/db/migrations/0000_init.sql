CREATE TYPE "public"."account_status" AS ENUM('connecting', 'backfilling', 'active', 'needs_reauth', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('gmail', 'graph', 'imap');--> statement-breakpoint
CREATE TABLE "account_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"provider" "provider" NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"short_name" text,
	"color" integer DEFAULT 0 NOT NULL,
	"send_as" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "account_status" DEFAULT 'connecting' NOT NULL,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "allowed_users" (
	"email" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allowed_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"op" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_email" ON "accounts" USING btree ("user_id","provider","email");--> statement-breakpoint
CREATE INDEX "changes_user_seq" ON "changes" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_ready" ON "jobs" USING btree ("run_at") WHERE locked_by is null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe" ON "jobs" USING btree ("dedupe_key") WHERE locked_by is null and dedupe_key is not null;--> statement-breakpoint
CREATE POLICY "accounts_owner_read" ON "accounts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "changes_owner_read" ON "changes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);