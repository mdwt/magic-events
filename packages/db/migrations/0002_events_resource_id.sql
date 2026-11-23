ALTER TABLE "events" ADD COLUMN "resource_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "events_resource_idx" ON "events" USING btree ("resource_id","recorded_at");