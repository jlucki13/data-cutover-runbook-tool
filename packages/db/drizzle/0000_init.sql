CREATE TYPE "public"."dependency_type" AS ENUM('FS', 'SS', 'FF', 'SF');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('planning', 'live', 'closed');--> statement-breakpoint
CREATE TYPE "public"."gate_decision" AS ENUM('pending', 'go', 'no_go');--> statement-breakpoint
CREATE TYPE "public"."gate_task_role" AS ENUM('entry', 'gated');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'parsing', 'review', 'committed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('proposed', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."schedule_run_kind" AS ENUM('baseline', 'live', 'scenario');--> statement-breakpoint
CREATE TYPE "public"."source_format" AS ENUM('manual', 'csv', 'gantt_csv', 'ms_project_xml', 'prose_llm');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('not_started', 'in_progress', 'blocked', 'complete', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('builder', 'task_owner', 'command_center', 'auditor');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'task_owner' NOT NULL,
	"slack_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_id" uuid,
	"schedule_run_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"predecessor_task_id" uuid NOT NULL,
	"successor_task_id" uuid NOT NULL,
	"type" "dependency_type" DEFAULT 'FS' NOT NULL,
	"lag_minutes" integer DEFAULT 0 NOT NULL,
	"source" "source_format" DEFAULT 'manual' NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_no_self_loop_chk" CHECK ("dependency"."predecessor_task_id" <> "dependency"."successor_task_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'planning' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_window_chk" CHECK ("event"."window_end" > "event"."window_start")
);
--> statement-breakpoint
CREATE TABLE "gate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"approver_id" uuid,
	"target_decision_at" timestamp with time zone,
	"is_point_of_no_return" boolean DEFAULT false NOT NULL,
	"decision" "gate_decision" DEFAULT 'pending' NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_decision_consistency_chk" CHECK (("gate"."decision" = 'pending' AND "gate"."decided_at" IS NULL) OR ("gate"."decision" <> 'pending' AND "gate"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gate_task" (
	"gate_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"role" "gate_task_role" NOT NULL,
	CONSTRAINT "gate_task_gate_id_task_id_role_pk" PRIMARY KEY("gate_id","task_id","role")
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"format" "source_format" NOT NULL,
	"filename" text,
	"raw_content" text,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"parser_version" text,
	"parser_model" text,
	"created_by_id" uuid,
	"committed_by_id" uuid,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_candidate_dependency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"predecessor_ref" text NOT NULL,
	"successor_ref" text NOT NULL,
	"type" "dependency_type" DEFAULT 'FS' NOT NULL,
	"lag_minutes" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(3, 2),
	"evidence" text,
	"diff_kind" text,
	"review_state" "review_state" DEFAULT 'proposed' NOT NULL,
	"reviewer_note" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "import_candidate_dependency_no_self_loop_chk" CHECK ("import_candidate_dependency"."predecessor_ref" <> "import_candidate_dependency"."successor_ref")
);
--> statement-breakpoint
CREATE TABLE "import_candidate_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"workstream_name" text,
	"owner_name" text,
	"planned_start" timestamp with time zone,
	"planned_duration_minutes" integer,
	"window_deadline" timestamp with time zone,
	"matched_task_id" uuid,
	"review_state" "review_state" DEFAULT 'proposed' NOT NULL,
	"evidence" text
);
--> statement-breakpoint
CREATE TABLE "schedule_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "schedule_run_kind" NOT NULL,
	"based_on_run_id" uuid,
	"as_of" timestamp with time zone NOT NULL,
	"trigger" jsonb NOT NULL,
	"impact" jsonb,
	"engine_version" text NOT NULL,
	"created_by_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_task_result" (
	"run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"early_start" timestamp with time zone,
	"early_finish" timestamp with time zone,
	"late_start" timestamp with time zone,
	"late_finish" timestamp with time zone,
	"total_float_minutes" integer,
	"is_critical" boolean DEFAULT false NOT NULL,
	"deadline_breach_minutes" integer,
	"held_reason" text,
	CONSTRAINT "schedule_task_result_run_id_task_id_pk" PRIMARY KEY("run_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"workstream_id" uuid,
	"owner_id" uuid,
	"planned_start" timestamp with time zone,
	"planned_duration_minutes" integer DEFAULT 0 NOT NULL,
	"window_deadline" timestamp with time zone,
	"status" "task_status" DEFAULT 'not_started' NOT NULL,
	"status_note" text,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"remaining_duration_minutes" integer,
	"source" "source_format" DEFAULT 'manual' NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_duration_nonneg_chk" CHECK ("task"."planned_duration_minutes" >= 0),
	CONSTRAINT "task_remaining_nonneg_chk" CHECK ("task"."remaining_duration_minutes" IS NULL OR "task"."remaining_duration_minutes" >= 0),
	CONSTRAINT "task_actual_order_chk" CHECK ("task"."actual_end" IS NULL OR "task"."actual_start" IS NULL OR "task"."actual_end" >= "task"."actual_start")
);
--> statement-breakpoint
CREATE TABLE "workstream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_schedule_run_id_schedule_run_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency" ADD CONSTRAINT "dependency_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency" ADD CONSTRAINT "dependency_predecessor_task_id_task_id_fk" FOREIGN KEY ("predecessor_task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency" ADD CONSTRAINT "dependency_successor_task_id_task_id_fk" FOREIGN KEY ("successor_task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency" ADD CONSTRAINT "dependency_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_approver_id_app_user_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_decided_by_id_app_user_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_task" ADD CONSTRAINT "gate_task_gate_id_gate_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_task" ADD CONSTRAINT "gate_task_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_committed_by_id_app_user_id_fk" FOREIGN KEY ("committed_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD CONSTRAINT "import_candidate_dependency_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD CONSTRAINT "import_candidate_dependency_reviewed_by_id_app_user_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD CONSTRAINT "import_candidate_task_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD CONSTRAINT "import_candidate_task_matched_task_id_task_id_fk" FOREIGN KEY ("matched_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_based_on_run_id_schedule_run_id_fk" FOREIGN KEY ("based_on_run_id") REFERENCES "public"."schedule_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_task_result" ADD CONSTRAINT "schedule_task_result_run_id_schedule_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."schedule_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_task_result" ADD CONSTRAINT "schedule_task_result_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_workstream_id_workstream_id_fk" FOREIGN KEY ("workstream_id") REFERENCES "public"."workstream"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstream" ADD CONSTRAINT "workstream_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstream" ADD CONSTRAINT "workstream_lead_id_app_user_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_uq" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "audit_log_event_time_idx" ON "audit_log_entry" USING btree ("event_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log_entry" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_edge_uq" ON "dependency" USING btree ("predecessor_task_id","successor_task_id");--> statement-breakpoint
CREATE INDEX "dependency_successor_idx" ON "dependency" USING btree ("successor_task_id");--> statement-breakpoint
CREATE INDEX "dependency_event_idx" ON "dependency" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_event_name_uq" ON "gate" USING btree ("event_id","name");--> statement-breakpoint
CREATE INDEX "gate_task_task_idx" ON "gate_task" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "import_batch_event_idx" ON "import_batch" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "import_candidate_dependency_batch_idx" ON "import_candidate_dependency" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_candidate_task_batch_ref_uq" ON "import_candidate_task" USING btree ("batch_id","ref");--> statement-breakpoint
CREATE INDEX "schedule_run_event_kind_idx" ON "schedule_run" USING btree ("event_id","kind","computed_at");--> statement-breakpoint
CREATE INDEX "schedule_task_result_task_idx" ON "schedule_task_result" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_event_ref_uq" ON "task" USING btree ("event_id","ref");--> statement-breakpoint
CREATE INDEX "task_event_status_idx" ON "task" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "task_owner_idx" ON "task" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "task_workstream_idx" ON "task" USING btree ("workstream_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workstream_event_name_uq" ON "workstream" USING btree ("event_id","name");