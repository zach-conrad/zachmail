CREATE TYPE "public"."folder_kind" AS ENUM('inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'starred', 'important', 'custom');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"message_id" uuid NOT NULL,
	"filename" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"provider_attachment_id" text,
	"content_id" text,
	"inline" boolean DEFAULT false NOT NULL,
	"storage_key" text
);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "folder_kind" DEFAULT 'custom' NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_bodies" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"html" text,
	"text" text,
	"storage_key" text,
	"has_remote_images" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_bodies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"rfc822_message_id" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"from" jsonb,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"provider_labels" text[] DEFAULT '{}' NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"list_unsubscribe" text,
	"size" integer DEFAULT 0 NOT NULL,
	"body_status" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "thread_folders" (
	"thread_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	CONSTRAINT "thread_folders_thread_id_folder_id_pk" PRIMARY KEY("thread_id","folder_id")
);
--> statement-breakpoint
ALTER TABLE "thread_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_thread_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_provider" ON "folders" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_provider" ON "messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_date" ON "messages" USING btree ("thread_id","date");--> statement-breakpoint
CREATE INDEX "thread_folders_folder" ON "thread_folders" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_account_provider" ON "threads" USING btree ("account_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "threads_user_recent" ON "threads" USING btree ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "attachments_owner_read" ON "attachments" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "folders_owner_read" ON "folders" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "message_bodies_owner_read" ON "message_bodies" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "messages_owner_read" ON "messages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "thread_folders_owner_read" ON "thread_folders" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);--> statement-breakpoint
CREATE POLICY "threads_owner_read" ON "threads" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = user_id);