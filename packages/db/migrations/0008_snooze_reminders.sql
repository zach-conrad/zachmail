CREATE TYPE "public"."reminder_condition" AS ENUM('always', 'if_no_reply');--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid,
	"sent_message_id" text,
	"op_id" uuid NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"condition" "reminder_condition" DEFAULT 'if_no_reply' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_thread" ON "reminders" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "reminders_due" ON "reminders" USING btree ("remind_at");--> statement-breakpoint
CREATE INDEX "reminders_sent_message" ON "reminders" USING btree ("account_id","sent_message_id") WHERE thread_id is null;--> statement-breakpoint
CREATE INDEX "threads_snoozed" ON "threads" USING btree ("snoozed_until") WHERE snoozed_until is not null;--> statement-breakpoint
CREATE POLICY "reminders_owner_read" ON "reminders" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);