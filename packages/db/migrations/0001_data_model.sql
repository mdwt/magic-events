-- pgvector holds the experience embeddings. Written by hand: drizzle-kit does not generate extensions.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('none', 'not_yet', 'open', 'sold_out', 'closed');--> statement-breakpoint
CREATE TYPE "public"."change_kind" AS ENUM('new', 'confirmed', 'rescheduled', 'postponed', 'cancelled', 'removed', 'past', 'changed');--> statement-breakpoint
CREATE TYPE "public"."experience_status" AS ENUM('expected', 'announced', 'confirmed', 'postponed', 'cancelled', 'removed', 'past');--> statement-breakpoint
CREATE TYPE "public"."experience_type" AS ENUM('single', 'run', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."session_origin" AS ENUM('listed', 'generated');--> statement-breakpoint
CREATE TYPE "public"."session_precision" AS ENUM('day', 'month', 'year');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('scheduled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('option', 'text', 'number', 'boolean', 'date');--> statement-breakpoint
CREATE TYPE "public"."undefined_value_kind" AS ENUM('attribute', 'option', 'tag');--> statement-breakpoint
CREATE TYPE "public"."listing_state" AS ENUM('listed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."raw_listing_kind" AS ENUM('listing', 'removed');--> statement-breakpoint
CREATE TYPE "public"."raw_listing_status" AS ENUM('pending', 'processed', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('system_admin', 'client');--> statement-breakpoint
CREATE TYPE "public"."tenant_kind" AS ENUM('travel_agency', 'travel_app');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"description" text,
	"profile" text,
	"type" "experience_type" NOT NULL,
	"status" "experience_status" NOT NULL,
	"booking" "booking_status" NOT NULL,
	"timezone" text NOT NULL,
	"opening_hours" text,
	"venue_name" text,
	"venue_address" text,
	"city" text,
	"latitude" double precision,
	"longitude" double precision,
	"price_min" numeric(12, 2),
	"price_max" numeric(12, 2),
	"currency" text,
	"on_sale_at" timestamp with time zone,
	"booking_closes_at" timestamp with time zone,
	"booking_url" text,
	"image_url" text,
	"recurrence_rule" text,
	"recurrence_start" date,
	"recurrence_end" date,
	"recurrence_start_time" time,
	"recurrence_end_time" time,
	"recurrence_skipped" date[],
	"version" integer DEFAULT 1 NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(description, '') || ' ' || coalesce(profile, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_attribute_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"attribute_key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" "change_kind" NOT NULL,
	"previous" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"precision" "session_precision" DEFAULT 'day' NOT NULL,
	"start_time" time,
	"end_time" time,
	"label" text,
	"status" "session_status" DEFAULT 'scheduled' NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL,
	"origin" "session_origin" DEFAULT 'listed' NOT NULL,
	CONSTRAINT "experience_session_dates_check" CHECK ("experience_session"."end_date" >= "experience_session"."start_date")
);
--> statement-breakpoint
CREATE TABLE "experience_source_link" (
	"experience_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_source_link_experience_id_listing_id_pk" PRIMARY KEY("experience_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "experience_tag" (
	"experience_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "experience_tag_experience_id_tag_pk" PRIMARY KEY("experience_id","tag")
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"timezone" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" "attribute_type" NOT NULL,
	"default_value" jsonb,
	"multiple" boolean DEFAULT false NOT NULL,
	"filterable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	CONSTRAINT "season_period_dates_check" CHECK ("season_period"."end_date" >= "season_period"."start_date")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "undefined_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_listing_id" uuid NOT NULL,
	"kind" "undefined_value_kind" NOT NULL,
	"value" text NOT NULL,
	"extracted_experience" jsonb NOT NULL,
	"model_answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"raw_listing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"experience" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_listing_id" text NOT NULL,
	"url" text,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"state" "listing_state" DEFAULT 'listed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "raw_listing_kind" DEFAULT 'listing' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_type" text,
	"content" text,
	"fingerprint" text,
	"status" "raw_listing_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"listings_found" integer DEFAULT 0 NOT NULL,
	"listings_new_or_changed" integer DEFAULT 0 NOT NULL,
	"listings_unchanged" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_setting" text,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"fetch_interval_hours" integer NOT NULL,
	"missed_runs_before_removal" integer NOT NULL,
	"max_processing_attempts" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"tenant_id" uuid,
	"role" "user_role" DEFAULT 'client' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "tenant_kind" NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "events_id_idx";--> statement-breakpoint
DROP INDEX "events_stream_version_idx";--> statement-breakpoint
DROP INDEX "events_type_idx";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "global_position";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "stream_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "stream_version";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "events" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "experience" ADD CONSTRAINT "experience_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_attribute_value" ADD CONSTRAINT "experience_attribute_value_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_change" ADD CONSTRAINT "experience_change_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_session" ADD CONSTRAINT "experience_session_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_source_link" ADD CONSTRAINT "experience_source_link_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_tag" ADD CONSTRAINT "experience_tag_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_option" ADD CONSTRAINT "attribute_option_attribute_id_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attribute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season" ADD CONSTRAINT "season_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_period" ADD CONSTRAINT "season_period_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "undefined_value" ADD CONSTRAINT "undefined_value_raw_listing_id_raw_listing_id_fk" FOREIGN KEY ("raw_listing_id") REFERENCES "public"."raw_listing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_experience" ADD CONSTRAINT "warehouse_experience_experience_id_experience_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experience"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_experience" ADD CONSTRAINT "warehouse_experience_raw_listing_id_raw_listing_id_fk" FOREIGN KEY ("raw_listing_id") REFERENCES "public"."raw_listing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_first_seen_run_id_run_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_last_seen_run_id_run_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_listing" ADD CONSTRAINT "raw_listing_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_listing" ADD CONSTRAINT "raw_listing_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experience_slug_idx" ON "experience" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "experience_location_idx" ON "experience" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "experience_status_idx" ON "experience" USING btree ("status");--> statement-breakpoint
CREATE INDEX "experience_search_text_idx" ON "experience" USING gin ("search_text");--> statement-breakpoint
CREATE UNIQUE INDEX "experience_attribute_value_idx" ON "experience_attribute_value" USING btree ("experience_id","attribute_key","value");--> statement-breakpoint
CREATE INDEX "experience_attribute_value_lookup_idx" ON "experience_attribute_value" USING btree ("attribute_key","value");--> statement-breakpoint
CREATE UNIQUE INDEX "experience_change_version_idx" ON "experience_change" USING btree ("experience_id","version");--> statement-breakpoint
CREATE INDEX "experience_change_changed_at_idx" ON "experience_change" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "experience_session_experience_idx" ON "experience_session" USING btree ("experience_id");--> statement-breakpoint
CREATE INDEX "experience_session_dates_idx" ON "experience_session" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "experience_source_link_listing_idx" ON "experience_source_link" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "experience_tag_tag_idx" ON "experience_tag" USING btree ("tag");--> statement-breakpoint
CREATE UNIQUE INDEX "location_slug_idx" ON "location" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_key_idx" ON "attribute" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_option_key_idx" ON "attribute_option" USING btree ("attribute_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "season_location_slug_idx" ON "season" USING btree ("location_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "season_period_idx" ON "season_period" USING btree ("season_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_slug_idx" ON "tag" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "undefined_value_raw_listing_idx" ON "undefined_value" USING btree ("raw_listing_id");--> statement-breakpoint
CREATE INDEX "warehouse_experience_experience_idx" ON "warehouse_experience" USING btree ("experience_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_source_listing_idx" ON "listing" USING btree ("source_id","source_listing_id");--> statement-breakpoint
CREATE INDEX "raw_listing_listing_idx" ON "raw_listing" USING btree ("listing_id","fetched_at");--> statement-breakpoint
CREATE INDEX "raw_listing_pending_idx" ON "raw_listing" USING btree ("fetched_at") WHERE "raw_listing"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "run_source_started_idx" ON "run" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_name_location_idx" ON "source" USING btree ("name","location_id");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_config_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_reference_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_tenant_idx" ON "user" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_slug_idx" ON "tenant" USING btree ("slug");