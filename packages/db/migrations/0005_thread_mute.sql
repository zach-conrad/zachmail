ALTER TABLE "threads" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_muted" ON "threads" USING btree ("account_id") WHERE muted;