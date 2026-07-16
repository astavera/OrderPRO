-- User access changes use optimistic concurrency and normalized email identity.
ALTER TABLE "User"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "User"
ADD CONSTRAINT "User_version_positive" CHECK ("version" > 0);

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (LOWER("email"));

-- Audit history is append-only. Corrections are new audit events.
CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only; create a new audit event';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
BEFORE UPDATE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER audit_event_no_delete
BEFORE DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
