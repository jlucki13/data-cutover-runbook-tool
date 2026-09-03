DROP INDEX "import_candidate_dependency_batch_idx";--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ALTER COLUMN "diff_kind" SET DEFAULT 'add';--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ALTER COLUMN "diff_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "worksheets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD COLUMN "resolution" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD COLUMN "edits" jsonb;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD COLUMN "source_line" integer;--> statement-breakpoint
ALTER TABLE "import_candidate_dependency" ADD COLUMN "worksheet" text;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "diff_kind" text DEFAULT 'add' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "edits" jsonb;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "source_line" integer;--> statement-breakpoint
ALTER TABLE "import_candidate_task" ADD COLUMN "worksheet" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "owner_hint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "import_candidate_dependency_batch_edge_uq" ON "import_candidate_dependency" USING btree ("batch_id","predecessor_ref","successor_ref");