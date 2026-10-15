ALTER TABLE "threads" ADD COLUMN "ai_category" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "ai_needs_reply" boolean;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "ai_triaged_at" timestamp with time zone;