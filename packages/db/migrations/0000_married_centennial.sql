CREATE TABLE "events" (
	"global_position" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_global_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"stream_id" text NOT NULL,
	"stream_version" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_id_idx" ON "events" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_stream_version_idx" ON "events" USING btree ("stream_id","stream_version");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");