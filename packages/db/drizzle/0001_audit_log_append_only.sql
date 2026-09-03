-- audit_log_entry is append-only (PRD §6.1). Block UPDATE/DELETE at the database
-- level so no application bug or ad-hoc SQL can rewrite history.
CREATE OR REPLACE FUNCTION audit_log_entry_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entry is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_entry_no_update
  BEFORE UPDATE ON "audit_log_entry"
  FOR EACH ROW EXECUTE FUNCTION audit_log_entry_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_entry_no_delete
  BEFORE DELETE ON "audit_log_entry"
  FOR EACH ROW EXECUTE FUNCTION audit_log_entry_immutable();
--> statement-breakpoint
-- Also block TRUNCATE (row triggers don't fire on it).
CREATE OR REPLACE FUNCTION audit_log_entry_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entry is append-only: TRUNCATE is not permitted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_entry_no_truncate
  BEFORE TRUNCATE ON "audit_log_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_entry_no_truncate();
