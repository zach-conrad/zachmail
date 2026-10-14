ALTER TABLE "messages" ADD COLUMN "search" "tsvector";--> statement-breakpoint
CREATE INDEX "messages_search" ON "messages" USING gin ("search");