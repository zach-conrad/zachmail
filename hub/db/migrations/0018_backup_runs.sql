CREATE TABLE "backup_runs" (
	"day" date PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"object_key" text,
	"bytes" integer,
	"rows" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "backup_runs" ENABLE ROW LEVEL SECURITY;