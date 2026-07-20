BEGIN;

-- Approval audit rows and immutable approval rows must retain the same instant.
-- The approval guard compares them exactly, so AuditEvent cannot truncate the
-- microseconds produced by CLOCK_TIMESTAMP() to its historical millisecond type.
ALTER TABLE "AuditEvent"
  ALTER COLUMN "occurredAt" TYPE TIMESTAMP(6) WITHOUT TIME ZONE;

COMMIT;
