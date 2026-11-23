DROP INDEX "experience_session_experience_idx";--> statement-breakpoint
DROP INDEX "experience_session_dates_idx";--> statement-breakpoint
CREATE INDEX "experience_position_idx" ON "experience" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "experience_session_experience_dates_idx" ON "experience_session" USING btree ("experience_id","start_date","end_date","status");--> statement-breakpoint
CREATE INDEX "experience_session_dates_experience_idx" ON "experience_session" USING btree ("end_date","start_date","status","experience_id");