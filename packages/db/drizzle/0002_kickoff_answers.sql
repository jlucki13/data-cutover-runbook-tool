CREATE TYPE "public"."column_data_type" AS ENUM('text', 'number', 'boolean', 'date', 'datetime', 'duration_minutes', 'select', 'user');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'admin' BEFORE 'builder';--> statement-breakpoint
CREATE TABLE "event_column" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"builtin_key" text,
	"label" text NOT NULL,
	"data_type" "column_data_type" DEFAULT 'text' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_column_key_format_chk" CHECK ("event_column"."key" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "default_blocked_recovery_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "expected_unblock_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "event_column" ADD CONSTRAINT "event_column_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_column" ADD CONSTRAINT "event_column_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_column_event_key_uq" ON "event_column" USING btree ("event_id","key");--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_recovery_nonneg_chk" CHECK ("event"."default_blocked_recovery_minutes" >= 0);