BEGIN;

-- Activation is a separate, immutable decision that consumes exactly one
-- reviewed approval. The row is inserted before the registry transition in the
-- same transaction so the three registry triggers can verify its evidence.
CREATE TABLE "MachineAuthorizationActivation" (
  "id" UUID NOT NULL,
  "approvalId" UUID NOT NULL,
  "machineClientId" UUID NOT NULL,
  "environment" "MachineEnvironment" NOT NULL,
  "credentialId" UUID NOT NULL,
  "activatedByUserId" UUID NOT NULL,
  "activationAuditEventId" UUID NOT NULL,
  "activationCorrelationId" UUID NOT NULL,
  "approvalDigestSha256" CHAR(64) NOT NULL,
  "clientVersionBefore" INTEGER NOT NULL,
  "credentialVersionBefore" INTEGER NOT NULL,
  "grantVersionsBefore" JSONB NOT NULL,
  "clientVersionAfter" INTEGER NOT NULL,
  "credentialVersionAfter" INTEGER NOT NULL,
  "grantVersionsAfter" JSONB NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "activationSourceCommitSha" VARCHAR(64) NOT NULL,
  "activationSourceTreeSha" VARCHAR(64) NOT NULL,
  "activationDigestSha256" CHAR(64) NOT NULL,
  "activatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MachineAuthorizationActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MachineAuthorizationActivation_staging_only" CHECK (
    "environment" = 'STAGING'
  ),
  CONSTRAINT "MachineAuthorizationActivation_id_is_audit" CHECK (
    "id" = "activationAuditEventId"
  ),
  CONSTRAINT "MachineAuthorizationActivation_versions" CHECK (
    "clientVersionBefore" > 0
    AND "credentialVersionBefore" > 0
    AND "clientVersionAfter" = "clientVersionBefore" + 1
    AND "credentialVersionAfter" = "credentialVersionBefore" + 1
  ),
  CONSTRAINT "MachineAuthorizationActivation_grant_snapshots" CHECK (
    JSONB_TYPEOF("grantVersionsBefore") = 'array'
    AND JSONB_ARRAY_LENGTH("grantVersionsBefore") = 2
    AND JSONB_TYPEOF("grantVersionsAfter") = 'array'
    AND JSONB_ARRAY_LENGTH("grantVersionsAfter") = 2
  ),
  CONSTRAINT "MachineAuthorizationActivation_reason" CHECK (
    "reason" = BTRIM("reason")
    AND CHAR_LENGTH("reason") BETWEEN 10 AND 500
    AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~* '(bearer[[:space:]]+|client[_ -]?secret|access[_ -]?token|authorization[[:space:]]*:)'
    AND "reason" !~ '[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'
  ),
  CONSTRAINT "MachineAuthorizationActivation_approval_digest" CHECK (
    "approvalDigestSha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "MachineAuthorizationActivation_activation_digest" CHECK (
    "activationDigestSha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "MachineAuthorizationActivation_source_commit" CHECK (
    "activationSourceCommitSha" ~ '^[a-f0-9]{40,64}$'
  ),
  CONSTRAINT "MachineAuthorizationActivation_source_tree" CHECK (
    "activationSourceTreeSha" ~ '^[a-f0-9]{40,64}$'
  )
);

CREATE UNIQUE INDEX "MachineAuthorizationActivation_approval_key"
  ON "MachineAuthorizationActivation"("approvalId");
CREATE UNIQUE INDEX "MachineAuthorizationActivation_audit_key"
  ON "MachineAuthorizationActivation"("activationAuditEventId");
CREATE UNIQUE INDEX "MachineAuthorizationActivation_correlation_key"
  ON "MachineAuthorizationActivation"("activationCorrelationId");
CREATE UNIQUE INDEX "MachineAuthorizationActivation_digest_key"
  ON "MachineAuthorizationActivation"("activationDigestSha256");
CREATE INDEX "MachineAuthorizationActivation_client_environment_activated_idx"
  ON "MachineAuthorizationActivation"("machineClientId", "environment", "activatedAt");
CREATE INDEX "MachineAuthorizationActivation_activated_by_idx"
  ON "MachineAuthorizationActivation"("activatedByUserId", "activatedAt");

ALTER TABLE "MachineAuthorizationActivation"
  ADD CONSTRAINT "MachineAuthorizationActivation_approval_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "MachineAuthorizationApproval"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationActivation"
  ADD CONSTRAINT "MachineAuthorizationActivation_client_environment_fkey"
  FOREIGN KEY ("machineClientId", "environment")
  REFERENCES "MachineClient"("id", "environment")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationActivation"
  ADD CONSTRAINT "MachineAuthorizationActivation_credential_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "MachineCredential"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationActivation"
  ADD CONSTRAINT "MachineAuthorizationActivation_activated_by_fkey"
  FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationActivation"
  ADD CONSTRAINT "MachineAuthorizationActivation_audit_fkey"
  FOREIGN KEY ("activationAuditEventId") REFERENCES "AuditEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_machine_authorization_activation_record_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MachineAuthorizationActivation is append-only; create a new activation decision';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_authorization_activation_no_update
BEFORE UPDATE ON "MachineAuthorizationActivation"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_activation_record_mutation();

CREATE TRIGGER machine_authorization_activation_no_delete
BEFORE DELETE ON "MachineAuthorizationActivation"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_activation_record_mutation();

-- Retain the original three trigger names, but turn them into transition guards.
-- An ACTIVE insert is always rejected. A PENDING_VERIFICATION -> ACTIVE update is
-- accepted only while the audited SECURITY DEFINER command exposes the matching
-- immutable activation id in a transaction-local setting.
DROP TRIGGER machine_client_no_activation ON "MachineClient";
DROP TRIGGER machine_credential_no_activation ON "MachineCredential";
DROP TRIGGER machine_grant_no_activation ON "MachineClientGrant";
DROP FUNCTION reject_machine_authorization_activation();

CREATE FUNCTION guard_staging_machine_authorization_activation()
RETURNS trigger AS $$
DECLARE
  activation_row "MachineAuthorizationActivation"%ROWTYPE;
  activation_marker TEXT;
  grant_transition_matches BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'ACTIVE' THEN
      RAISE EXCEPTION 'Machine authorization activation requires a reviewed migration';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."activatedAt" IS NOT NULL
     AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
    RAISE EXCEPTION 'Machine authorization activation timestamp is immutable';
  END IF;

  IF NEW."status" <> 'ACTIVE' OR OLD."status" = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  activation_marker := NULLIF(
    CURRENT_SETTING('orderpro.machine_authorization_activation_id', TRUE),
    ''
  );

  SELECT activation.* INTO activation_row
  FROM "MachineAuthorizationActivation" activation
  WHERE activation."id"::TEXT = activation_marker;

  IF activation_row."id" IS NULL THEN
    RAISE EXCEPTION 'Machine authorization activation requires a reviewed migration';
  END IF;

  IF TG_TABLE_NAME = 'MachineClient' THEN
    IF OLD."status" <> 'PENDING_VERIFICATION'
       OR OLD."id" IS DISTINCT FROM activation_row."machineClientId"
       OR OLD."environment" IS DISTINCT FROM activation_row."environment"
       OR OLD."ownerUserId" IS NOT NULL
       OR NEW."ownerUserId" IS NOT NULL
       OR OLD."version" <> activation_row."clientVersionBefore"
       OR NEW."version" <> activation_row."clientVersionAfter"
       OR OLD."activatedAt" IS NOT NULL
       OR NEW."activatedAt" IS DISTINCT FROM activation_row."activatedAt"
       OR NEW."suspendedAt" IS NOT NULL
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."displayName" IS DISTINCT FROM OLD."displayName"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."updatedAt" IS DISTINCT FROM activation_row."activatedAt" THEN
      RAISE EXCEPTION 'Machine client activation does not match the audited activation record';
    END IF;
  ELSIF TG_TABLE_NAME = 'MachineCredential' THEN
    IF OLD."status" <> 'PENDING_VERIFICATION'
       OR OLD."id" IS DISTINCT FROM activation_row."credentialId"
       OR OLD."machineClientId" IS DISTINCT FROM activation_row."machineClientId"
       OR OLD."environment" IS DISTINCT FROM activation_row."environment"
       OR OLD."version" <> activation_row."credentialVersionBefore"
       OR NEW."version" <> activation_row."credentialVersionAfter"
       OR OLD."verifiedAt" IS NULL
       OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
       OR OLD."activatedAt" IS NOT NULL
       OR NEW."activatedAt" IS DISTINCT FROM activation_row."activatedAt"
       OR NEW."suspendedAt" IS NOT NULL
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."lastUsedAt" IS DISTINCT FROM OLD."lastUsedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."updatedAt" IS DISTINCT FROM activation_row."activatedAt" THEN
      RAISE EXCEPTION 'Machine credential activation does not match the audited activation record';
    END IF;
  ELSIF TG_TABLE_NAME = 'MachineClientGrant' THEN
    SELECT EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(activation_row."grantVersionsBefore") before_grant
      JOIN JSONB_ARRAY_ELEMENTS(activation_row."grantVersionsAfter") after_grant
        ON after_grant->>'scope' = before_grant->>'scope'
      WHERE before_grant->>'scope' = OLD."scope"
        AND (before_grant->>'version')::INTEGER = OLD."version"
        AND (after_grant->>'version')::INTEGER = NEW."version"
    ) INTO grant_transition_matches;

    IF OLD."status" <> 'PENDING_VERIFICATION'
       OR OLD."machineClientId" IS DISTINCT FROM activation_row."machineClientId"
       OR OLD."environment" IS DISTINCT FROM activation_row."environment"
       OR grant_transition_matches IS DISTINCT FROM TRUE
       OR OLD."activatedAt" IS NOT NULL
       OR NEW."activatedAt" IS DISTINCT FROM activation_row."activatedAt"
       OR NEW."suspendedAt" IS NOT NULL
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."updatedAt" IS DISTINCT FROM activation_row."activatedAt" THEN
      RAISE EXCEPTION 'Machine grant activation does not match the audited activation record';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported machine authorization activation target';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public
   SET timezone = 'UTC';

CREATE TRIGGER machine_client_no_activation
BEFORE INSERT OR UPDATE ON "MachineClient"
FOR EACH ROW EXECUTE FUNCTION guard_staging_machine_authorization_activation();

CREATE TRIGGER machine_credential_no_activation
BEFORE INSERT OR UPDATE ON "MachineCredential"
FOR EACH ROW EXECUTE FUNCTION guard_staging_machine_authorization_activation();

CREATE TRIGGER machine_grant_no_activation
BEFORE INSERT OR UPDATE ON "MachineClientGrant"
FOR EACH ROW EXECUTE FUNCTION guard_staging_machine_authorization_activation();

CREATE FUNCTION validate_machine_authorization_activation_insert()
RETURNS trigger AS $$
DECLARE
  approval_row "MachineAuthorizationApproval"%ROWTYPE;
  client_row "MachineClient"%ROWTYPE;
  credential_row "MachineCredential"%ROWTYPE;
  activation_audit "AuditEvent"%ROWTYPE;
  approval_audit "AuditEvent"%ROWTYPE;
  active_owner BOOLEAN;
  owner_role_locked BOOLEAN;
  credential_count INTEGER;
  total_grant_count INTEGER;
  pending_grant_count INTEGER;
  current_grants JSONB;
  next_grants JSONB;
  expected_before JSONB;
  expected_after JSONB;
  recomputed_digest TEXT;
  activation_marker TEXT;
BEGIN
  activation_marker := NULLIF(
    CURRENT_SETTING('orderpro.machine_authorization_activation_id', TRUE),
    ''
  );

  IF NEW."id" IS DISTINCT FROM NEW."activationAuditEventId"
     OR NEW."id"::TEXT IS DISTINCT FROM activation_marker THEN
    RAISE EXCEPTION 'Machine authorization activation requires the guarded command';
  END IF;

  SELECT approval.* INTO approval_row
  FROM "MachineAuthorizationApproval" approval
  WHERE approval."id" = NEW."approvalId";

  SELECT client.* INTO client_row
  FROM "MachineClient" client
  WHERE client."id" = NEW."machineClientId"
    AND client."environment" = NEW."environment"
  FOR UPDATE;

  SELECT credential.* INTO credential_row
  FROM "MachineCredential" credential
  WHERE credential."id" = NEW."credentialId"
    AND credential."machineClientId" = NEW."machineClientId"
    AND credential."environment" = NEW."environment"
  FOR UPDATE;

  SELECT user_row."active" INTO active_owner
  FROM "User" user_row
  WHERE user_row."id" = NEW."activatedByUserId"
  FOR SHARE;

  SELECT TRUE INTO owner_role_locked
  FROM "UserRole" role_row
  WHERE role_row."userId" = NEW."activatedByUserId"
    AND role_row."role" = 'OWNER'
  FOR SHARE;

  PERFORM grant_row."scope"
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = NEW."machineClientId"
    AND grant_row."environment" = NEW."environment"
  ORDER BY grant_row."scope"
  FOR UPDATE;

  SELECT COUNT(*)::INTEGER INTO credential_count
  FROM "MachineCredential" counted_credential
  WHERE counted_credential."machineClientId" = NEW."machineClientId"
    AND counted_credential."environment" = NEW."environment";

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
         )::INTEGER,
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'scope', grant_row."scope",
             'version', grant_row."version"
           ) ORDER BY grant_row."scope"
         ),
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'scope', grant_row."scope",
             'version', grant_row."version" + 1
           ) ORDER BY grant_row."scope"
         )
  INTO total_grant_count, pending_grant_count, current_grants, next_grants
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = NEW."machineClientId"
    AND grant_row."environment" = NEW."environment";

  SELECT audit.* INTO approval_audit
  FROM "AuditEvent" audit
  WHERE audit."id" = approval_row."approvalAuditEventId";

  SELECT audit.* INTO activation_audit
  FROM "AuditEvent" audit
  WHERE audit."id" = NEW."activationAuditEventId";

  recomputed_digest := ENCODE(SHA256(CONVERT_TO(
    CONCAT_WS(E'\n',
      'orderpro.m2m-authorization-activation.v1',
      NEW."approvalId"::TEXT,
      NEW."approvalDigestSha256",
      NEW."machineClientId"::TEXT,
      NEW."credentialId"::TEXT,
      NEW."activatedByUserId"::TEXT,
      NEW."activationAuditEventId"::TEXT,
      NEW."activationCorrelationId"::TEXT,
      NEW."clientVersionBefore"::TEXT,
      NEW."credentialVersionBefore"::TEXT,
      NEW."grantVersionsBefore"::TEXT,
      NEW."clientVersionAfter"::TEXT,
      NEW."credentialVersionAfter"::TEXT,
      NEW."grantVersionsAfter"::TEXT,
      NEW."reason",
      NEW."activationSourceCommitSha",
      NEW."activationSourceTreeSha",
      NEW."activatedAt"::TEXT
    ), 'UTF8')), 'hex');

  expected_before := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-activation.v1',
    'approvalId', NEW."approvalId",
    'approvalDecision', 'APPROVED_PENDING_ACTIVATION',
    'approvalDigestSha256', NEW."approvalDigestSha256",
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', NEW."clientVersionBefore",
    'credentialStatus', 'PENDING_VERIFICATION',
    'credentialVersion', NEW."credentialVersionBefore",
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', NEW."grantVersionsBefore",
    'ownerUserId', NULL
  );
  expected_after := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-activation.v1',
    'activationOutcome', 'ACTIVATED',
    'authorizationStatus', 'ACTIVE',
    'activationId', NEW."id",
    'approvalId', NEW."approvalId",
    'machineClientId', NEW."machineClientId",
    'credentialId', NEW."credentialId",
    'activatedByUserId', NEW."activatedByUserId",
    'activationCorrelationId', NEW."activationCorrelationId",
    'approvalDigestSha256', NEW."approvalDigestSha256",
    'clientStatus', 'ACTIVE',
    'clientVersion', NEW."clientVersionAfter",
    'credentialStatus', 'ACTIVE',
    'credentialVersion', NEW."credentialVersionAfter",
    'grantStatus', 'ACTIVE',
    'grantVersions', NEW."grantVersionsAfter",
    'ownerUserId', NULL,
    'activationSourceCommitSha', NEW."activationSourceCommitSha",
    'activationSourceTreeSha', NEW."activationSourceTreeSha",
    'activationDigestSha256', NEW."activationDigestSha256",
    'activatedAt', NEW."activatedAt"
  );

  IF approval_row."id" IS NULL
     OR approval_row."machineClientId" IS DISTINCT FROM NEW."machineClientId"
     OR approval_row."environment" IS DISTINCT FROM NEW."environment"
     OR approval_row."credentialId" IS DISTINCT FROM NEW."credentialId"
     OR approval_row."decision" <> 'APPROVED_PENDING_ACTIVATION'
     OR approval_row."approvalDigestSha256" IS DISTINCT FROM NEW."approvalDigestSha256"
     OR approval_row."clientVersion" <> NEW."clientVersionBefore"
     OR approval_row."credentialVersion" <> NEW."credentialVersionBefore"
     OR approval_row."grantVersions" IS DISTINCT FROM NEW."grantVersionsBefore"
     OR approval_audit."id" IS NULL
     OR approval_audit."action" <> 'm2m.client.authorization_approved'
     OR approval_audit."entityType" <> 'MachineClient'
     OR approval_audit."entityId" IS DISTINCT FROM NEW."machineClientId"::TEXT
     OR approval_audit."after"->>'decision' IS DISTINCT FROM 'APPROVED_PENDING_ACTIVATION'
     OR approval_audit."after"->>'approvalDigestSha256'
          IS DISTINCT FROM NEW."approvalDigestSha256"
     OR active_owner IS DISTINCT FROM TRUE
     OR owner_role_locked IS DISTINCT FROM TRUE
     OR client_row."id" IS NULL
     OR client_row."key" <> 'storefront-staging'
     OR client_row."displayName" <> 'OrderPro Storefront STAGING'
     OR client_row."status" <> 'PENDING_VERIFICATION'
     OR client_row."ownerUserId" IS NOT NULL
     OR client_row."version" <> NEW."clientVersionBefore"
     OR client_row."activatedAt" IS NOT NULL
     OR client_row."suspendedAt" IS NOT NULL
     OR client_row."revokedAt" IS NOT NULL
     OR credential_count <> 1
     OR credential_row."id" IS NULL
     OR credential_row."provider" <> 'AUTH0'
     OR credential_row."status" <> 'PENDING_VERIFICATION'
     OR credential_row."version" <> NEW."credentialVersionBefore"
     OR credential_row."verifiedAt" IS NULL
     OR credential_row."activatedAt" IS NOT NULL
     OR credential_row."suspendedAt" IS NOT NULL
     OR credential_row."revokedAt" IS NOT NULL
     OR total_grant_count <> 2
     OR pending_grant_count <> 2
     OR current_grants IS DISTINCT FROM NEW."grantVersionsBefore"
     OR next_grants IS DISTINCT FROM NEW."grantVersionsAfter"
     OR current_grants->0->>'scope' IS DISTINCT FROM 'local-delivery:holds'
     OR current_grants->1->>'scope' IS DISTINCT FROM 'local-delivery:quote'
     OR NEW."clientVersionAfter" <> NEW."clientVersionBefore" + 1
     OR NEW."credentialVersionAfter" <> NEW."credentialVersionBefore" + 1
     OR recomputed_digest IS DISTINCT FROM NEW."activationDigestSha256"
     OR activation_audit."id" IS NULL
     OR activation_audit."actorId" IS DISTINCT FROM NEW."activatedByUserId"
     OR activation_audit."action" <> 'm2m.client.authorization_activated'
     OR activation_audit."entityType" <> 'MachineClient'
     OR activation_audit."entityId" IS DISTINCT FROM NEW."machineClientId"::TEXT
     OR activation_audit."locationCode" IS NOT NULL
     OR activation_audit."correlationId" IS DISTINCT FROM NEW."activationCorrelationId"::TEXT
     OR activation_audit."reason" IS DISTINCT FROM NEW."reason"
     OR activation_audit."occurredAt" AT TIME ZONE 'UTC'
          IS DISTINCT FROM NEW."activatedAt"
     OR activation_audit."before" IS DISTINCT FROM expected_before
     OR activation_audit."after" IS DISTINCT FROM expected_after THEN
    RAISE EXCEPTION 'Machine authorization activation snapshot is invalid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public
   SET timezone = 'UTC';

CREATE TRIGGER machine_authorization_activation_validate_insert
BEFORE INSERT ON "MachineAuthorizationActivation"
FOR EACH ROW EXECUTE FUNCTION validate_machine_authorization_activation_insert();

CREATE FUNCTION record_staging_machine_authorization_activation(
  p_client_key TEXT,
  p_actor_user_id UUID,
  p_reason TEXT,
  p_approval_id UUID,
  p_approval_digest_sha256 TEXT,
  p_activation_source_commit_sha TEXT,
  p_activation_source_tree_sha TEXT,
  p_activation_audit_event_id UUID,
  p_activation_correlation_id UUID
) RETURNS TABLE (
  "activationId" UUID,
  "approvalId" UUID,
  "clientKey" TEXT,
  "environment" TEXT,
  "result" TEXT,
  "authorizationStatus" TEXT,
  "activationAuditEventId" UUID,
  "activationCorrelationId" UUID,
  "activationDigestSha256" TEXT,
  "activatedAt" TIMESTAMPTZ
) AS $$
DECLARE
  client_row "MachineClient"%ROWTYPE;
  credential_row "MachineCredential"%ROWTYPE;
  approval_row "MachineAuthorizationApproval"%ROWTYPE;
  existing_activation "MachineAuthorizationActivation"%ROWTYPE;
  activation_audit "AuditEvent"%ROWTYPE;
  approval_audit "AuditEvent"%ROWTYPE;
  active_owner BOOLEAN;
  owner_role_locked BOOLEAN;
  credential_count INTEGER;
  total_grant_count INTEGER;
  pending_grant_count INTEGER;
  active_grant_count INTEGER;
  affected_count INTEGER;
  current_grants JSONB;
  next_grants JSONB;
  active_grants JSONB;
  activation_time TIMESTAMPTZ;
  activation_digest TEXT;
  activation_before JSONB;
  activation_after JSONB;
BEGIN
  IF p_client_key IS DISTINCT FROM 'storefront-staging'
     OR p_reason IS NULL
     OR p_reason IS DISTINCT FROM BTRIM(p_reason)
     OR CHAR_LENGTH(p_reason) NOT BETWEEN 10 AND 500
     OR p_reason ~ '[[:cntrl:]]'
     OR p_reason ~* '(bearer[[:space:]]+|client[_ -]?secret|access[_ -]?token|authorization[[:space:]]*:)'
     OR p_reason ~ '[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'
     OR p_approval_digest_sha256 !~ '^[a-f0-9]{64}$'
     OR p_activation_source_commit_sha !~ '^[a-f0-9]{40,64}$'
     OR p_activation_source_tree_sha !~ '^[a-f0-9]{40,64}$'
     OR p_activation_audit_event_id = p_approval_id THEN
    RAISE EXCEPTION 'Machine authorization activation input is invalid';
  END IF;

  -- The client lock is the serialization point for both first execution and
  -- concurrent identical retries.
  SELECT client.* INTO client_row
  FROM "MachineClient" client
  WHERE client."key" = p_client_key
  FOR UPDATE;

  IF client_row."id" IS NULL THEN
    RAISE EXCEPTION 'Machine authorization activation client is unavailable';
  END IF;

  SELECT activation.* INTO existing_activation
  FROM "MachineAuthorizationActivation" activation
  WHERE activation."approvalId" = p_approval_id;

  IF existing_activation."id" IS NOT NULL THEN
    SELECT credential.* INTO credential_row
    FROM "MachineCredential" credential
    WHERE credential."id" = existing_activation."credentialId"
    FOR UPDATE;

    PERFORM grant_row."scope"
    FROM "MachineClientGrant" grant_row
    WHERE grant_row."machineClientId" = existing_activation."machineClientId"
      AND grant_row."environment" = existing_activation."environment"
    ORDER BY grant_row."scope"
    FOR UPDATE;

    SELECT COUNT(*)::INTEGER,
           COUNT(*) FILTER (WHERE grant_row."status" = 'ACTIVE')::INTEGER,
           JSONB_AGG(
             JSONB_BUILD_OBJECT(
               'scope', grant_row."scope",
               'version', grant_row."version"
             ) ORDER BY grant_row."scope"
           )
    INTO total_grant_count, active_grant_count, active_grants
    FROM "MachineClientGrant" grant_row
    WHERE grant_row."machineClientId" = existing_activation."machineClientId"
      AND grant_row."environment" = existing_activation."environment";

    SELECT audit.* INTO activation_audit
    FROM "AuditEvent" audit
    WHERE audit."id" = existing_activation."activationAuditEventId";

    IF existing_activation."machineClientId" IS DISTINCT FROM client_row."id"
       OR existing_activation."environment" <> 'STAGING'
       OR existing_activation."activatedByUserId" IS DISTINCT FROM p_actor_user_id
       OR existing_activation."activationAuditEventId"
            IS DISTINCT FROM p_activation_audit_event_id
       OR existing_activation."activationCorrelationId"
            IS DISTINCT FROM p_activation_correlation_id
       OR existing_activation."approvalDigestSha256"
            IS DISTINCT FROM p_approval_digest_sha256
       OR existing_activation."reason" IS DISTINCT FROM p_reason
       OR existing_activation."activationSourceCommitSha"
            IS DISTINCT FROM p_activation_source_commit_sha
       OR existing_activation."activationSourceTreeSha"
            IS DISTINCT FROM p_activation_source_tree_sha
       OR client_row."status" <> 'ACTIVE'
       OR client_row."ownerUserId" IS NOT NULL
       OR client_row."version" <> existing_activation."clientVersionAfter"
       OR client_row."activatedAt" IS DISTINCT FROM existing_activation."activatedAt"
       OR credential_row."id" IS NULL
       OR credential_row."status" <> 'ACTIVE'
       OR credential_row."version" <> existing_activation."credentialVersionAfter"
       OR credential_row."activatedAt" IS DISTINCT FROM existing_activation."activatedAt"
       OR total_grant_count <> 2
       OR active_grant_count <> 2
       OR active_grants IS DISTINCT FROM existing_activation."grantVersionsAfter"
       OR activation_audit."id" IS NULL
       OR activation_audit."actorId" IS DISTINCT FROM existing_activation."activatedByUserId"
       OR activation_audit."action" <> 'm2m.client.authorization_activated'
       OR activation_audit."entityType" <> 'MachineClient'
       OR activation_audit."entityId" IS DISTINCT FROM client_row."id"::TEXT
       OR activation_audit."correlationId"
            IS DISTINCT FROM existing_activation."activationCorrelationId"::TEXT
       OR activation_audit."after"->>'activationDigestSha256'
            IS DISTINCT FROM existing_activation."activationDigestSha256" THEN
      RAISE EXCEPTION 'Machine authorization activation idempotency conflict';
    END IF;

    RETURN QUERY SELECT
      existing_activation."id",
      existing_activation."approvalId",
      client_row."key"::TEXT,
      existing_activation."environment"::TEXT,
      'ACTIVATED'::TEXT,
      'ACTIVE'::TEXT,
      existing_activation."activationAuditEventId",
      existing_activation."activationCorrelationId",
      existing_activation."activationDigestSha256"::TEXT,
      existing_activation."activatedAt";
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MachineAuthorizationActivation" conflicting_activation
    WHERE conflicting_activation."activationAuditEventId" = p_activation_audit_event_id
       OR conflicting_activation."activationCorrelationId" = p_activation_correlation_id
  ) THEN
    RAISE EXCEPTION 'Machine authorization activation idempotency conflict';
  END IF;

  SELECT approval.* INTO approval_row
  FROM "MachineAuthorizationApproval" approval
  WHERE approval."id" = p_approval_id;

  SELECT user_row."active" INTO active_owner
  FROM "User" user_row
  WHERE user_row."id" = p_actor_user_id
  FOR SHARE;

  SELECT TRUE INTO owner_role_locked
  FROM "UserRole" role_row
  WHERE role_row."userId" = p_actor_user_id
    AND role_row."role" = 'OWNER'
  FOR SHARE;

  IF active_owner IS DISTINCT FROM TRUE
     OR owner_role_locked IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Machine authorization activation requires an active Owner';
  END IF;

  SELECT COUNT(*)::INTEGER INTO credential_count
  FROM "MachineCredential" counted_credential
  WHERE counted_credential."machineClientId" = client_row."id"
    AND counted_credential."environment" = 'STAGING';

  SELECT credential.* INTO credential_row
  FROM "MachineCredential" credential
  WHERE credential."id" = approval_row."credentialId"
    AND credential."machineClientId" = client_row."id"
    AND credential."environment" = 'STAGING'
  FOR UPDATE;

  PERFORM grant_row."scope"
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = client_row."id"
    AND grant_row."environment" = 'STAGING'
  ORDER BY grant_row."scope"
  FOR UPDATE;

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
         )::INTEGER,
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'scope', grant_row."scope",
             'version', grant_row."version"
           ) ORDER BY grant_row."scope"
         ),
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'scope', grant_row."scope",
             'version', grant_row."version" + 1
           ) ORDER BY grant_row."scope"
         )
  INTO total_grant_count, pending_grant_count, current_grants, next_grants
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = client_row."id"
    AND grant_row."environment" = 'STAGING';

  SELECT audit.* INTO approval_audit
  FROM "AuditEvent" audit
  WHERE audit."id" = approval_row."approvalAuditEventId";

  IF approval_row."id" IS NULL
     OR approval_row."machineClientId" IS DISTINCT FROM client_row."id"
     OR approval_row."environment" <> 'STAGING'
     OR approval_row."decision" <> 'APPROVED_PENDING_ACTIVATION'
     OR approval_row."approvalDigestSha256" IS DISTINCT FROM p_approval_digest_sha256
     OR approval_row."approvalAuditEventId" IS DISTINCT FROM approval_row."id"
     OR p_activation_audit_event_id = approval_row."certificationAuditEventId"
     OR p_activation_correlation_id = approval_row."approvalCorrelationId"
     OR p_activation_correlation_id = approval_row."certificationCorrelationId"
     OR approval_audit."id" IS NULL
     OR approval_audit."action" <> 'm2m.client.authorization_approved'
     OR approval_audit."actorId" IS DISTINCT FROM approval_row."approvedByUserId"
     OR approval_audit."entityType" <> 'MachineClient'
     OR approval_audit."entityId" IS DISTINCT FROM client_row."id"::TEXT
     OR approval_audit."correlationId" IS DISTINCT FROM approval_row."approvalCorrelationId"::TEXT
     OR approval_audit."after"->>'approvalDigestSha256'
          IS DISTINCT FROM approval_row."approvalDigestSha256"
     OR client_row."displayName" <> 'OrderPro Storefront STAGING'
     OR client_row."environment" <> 'STAGING'
     OR client_row."status" <> 'PENDING_VERIFICATION'
     OR client_row."ownerUserId" IS NOT NULL
     OR client_row."version" <> approval_row."clientVersion"
     OR client_row."activatedAt" IS NOT NULL
     OR client_row."suspendedAt" IS NOT NULL
     OR client_row."revokedAt" IS NOT NULL
     OR credential_count <> 1
     OR credential_row."id" IS NULL
     OR credential_row."provider" <> 'AUTH0'
     OR credential_row."status" <> 'PENDING_VERIFICATION'
     OR credential_row."version" <> approval_row."credentialVersion"
     OR credential_row."verifiedAt" IS NULL
     OR credential_row."activatedAt" IS NOT NULL
     OR credential_row."suspendedAt" IS NOT NULL
     OR credential_row."revokedAt" IS NOT NULL
     OR total_grant_count <> 2
     OR pending_grant_count <> 2
     OR current_grants IS DISTINCT FROM approval_row."grantVersions"
     OR current_grants->0->>'scope' IS DISTINCT FROM 'local-delivery:holds'
     OR current_grants->1->>'scope' IS DISTINCT FROM 'local-delivery:quote' THEN
    RAISE EXCEPTION 'Machine authorization activation snapshot is invalid';
  END IF;

  activation_time := CLOCK_TIMESTAMP();
  activation_digest := ENCODE(SHA256(CONVERT_TO(
    CONCAT_WS(E'\n',
      'orderpro.m2m-authorization-activation.v1',
      approval_row."id"::TEXT,
      approval_row."approvalDigestSha256",
      client_row."id"::TEXT,
      credential_row."id"::TEXT,
      p_actor_user_id::TEXT,
      p_activation_audit_event_id::TEXT,
      p_activation_correlation_id::TEXT,
      client_row."version"::TEXT,
      credential_row."version"::TEXT,
      current_grants::TEXT,
      (client_row."version" + 1)::TEXT,
      (credential_row."version" + 1)::TEXT,
      next_grants::TEXT,
      p_reason,
      p_activation_source_commit_sha,
      p_activation_source_tree_sha,
      activation_time::TEXT
    ), 'UTF8')), 'hex');

  activation_before := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-activation.v1',
    'approvalId', approval_row."id",
    'approvalDecision', 'APPROVED_PENDING_ACTIVATION',
    'approvalDigestSha256', approval_row."approvalDigestSha256",
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', client_row."version",
    'credentialStatus', 'PENDING_VERIFICATION',
    'credentialVersion', credential_row."version",
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', current_grants,
    'ownerUserId', NULL
  );
  activation_after := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-activation.v1',
    'activationOutcome', 'ACTIVATED',
    'authorizationStatus', 'ACTIVE',
    'activationId', p_activation_audit_event_id,
    'approvalId', approval_row."id",
    'machineClientId', client_row."id",
    'credentialId', credential_row."id",
    'activatedByUserId', p_actor_user_id,
    'activationCorrelationId', p_activation_correlation_id,
    'approvalDigestSha256', approval_row."approvalDigestSha256",
    'clientStatus', 'ACTIVE',
    'clientVersion', client_row."version" + 1,
    'credentialStatus', 'ACTIVE',
    'credentialVersion', credential_row."version" + 1,
    'grantStatus', 'ACTIVE',
    'grantVersions', next_grants,
    'ownerUserId', NULL,
    'activationSourceCommitSha', p_activation_source_commit_sha,
    'activationSourceTreeSha', p_activation_source_tree_sha,
    'activationDigestSha256', activation_digest,
    'activatedAt', activation_time
  );

  PERFORM SET_CONFIG(
    'orderpro.machine_authorization_activation_id',
    p_activation_audit_event_id::TEXT,
    TRUE
  );

  INSERT INTO "AuditEvent" (
    "id", "actorId", "action", "entityType", "entityId",
    "correlationId", "reason", "before", "after", "occurredAt"
  ) VALUES (
    p_activation_audit_event_id, p_actor_user_id,
    'm2m.client.authorization_activated', 'MachineClient', client_row."id"::TEXT,
    p_activation_correlation_id::TEXT, p_reason, activation_before,
    activation_after, activation_time AT TIME ZONE 'UTC'
  );

  INSERT INTO "MachineAuthorizationActivation" (
    "id", "approvalId", "machineClientId", "environment", "credentialId",
    "activatedByUserId", "activationAuditEventId", "activationCorrelationId",
    "approvalDigestSha256", "clientVersionBefore", "credentialVersionBefore",
    "grantVersionsBefore", "clientVersionAfter", "credentialVersionAfter",
    "grantVersionsAfter", "reason", "activationSourceCommitSha",
    "activationSourceTreeSha", "activationDigestSha256", "activatedAt"
  ) VALUES (
    p_activation_audit_event_id, approval_row."id", client_row."id", 'STAGING',
    credential_row."id", p_actor_user_id, p_activation_audit_event_id,
    p_activation_correlation_id, approval_row."approvalDigestSha256",
    client_row."version", credential_row."version", current_grants,
    client_row."version" + 1, credential_row."version" + 1, next_grants,
    p_reason, p_activation_source_commit_sha, p_activation_source_tree_sha,
    activation_digest, activation_time
  );

  UPDATE "MachineClient" AS activating_client
  SET "status" = 'ACTIVE',
      "version" = client_row."version" + 1,
      "activatedAt" = activation_time,
      "updatedAt" = activation_time
  WHERE activating_client."id" = client_row."id"
    AND activating_client."environment" = 'STAGING'
    AND activating_client."status" = 'PENDING_VERIFICATION'
    AND activating_client."version" = client_row."version";
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Machine client activation lost its locked snapshot';
  END IF;

  UPDATE "MachineCredential" AS activating_credential
  SET "status" = 'ACTIVE',
      "version" = credential_row."version" + 1,
      "activatedAt" = activation_time,
      "updatedAt" = activation_time
  WHERE activating_credential."id" = credential_row."id"
    AND activating_credential."environment" = 'STAGING'
    AND activating_credential."status" = 'PENDING_VERIFICATION'
    AND activating_credential."version" = credential_row."version";
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Machine credential activation lost its locked snapshot';
  END IF;

  UPDATE "MachineClientGrant" AS activating_grant
  SET "status" = 'ACTIVE',
      "version" = activating_grant."version" + 1,
      "activatedAt" = activation_time,
      "updatedAt" = activation_time
  WHERE activating_grant."machineClientId" = client_row."id"
    AND activating_grant."environment" = 'STAGING'
    AND activating_grant."status" = 'PENDING_VERIFICATION';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 2 THEN
    RAISE EXCEPTION 'Machine grant activation lost its locked snapshot';
  END IF;

  PERFORM SET_CONFIG('orderpro.machine_authorization_activation_id', '', TRUE);

  RETURN QUERY SELECT
    p_activation_audit_event_id,
    approval_row."id",
    client_row."key"::TEXT,
    'STAGING'::TEXT,
    'ACTIVATED'::TEXT,
    'ACTIVE'::TEXT,
    p_activation_audit_event_id,
    p_activation_correlation_id,
    activation_digest,
    activation_time;
EXCEPTION WHEN OTHERS THEN
  PERFORM SET_CONFIG('orderpro.machine_authorization_activation_id', '', TRUE);
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public
   SET timezone = 'UTC';

REVOKE ALL ON FUNCTION record_staging_machine_authorization_activation(
  TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID
) FROM PUBLIC;

ALTER TABLE "MachineAuthorizationActivation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "MachineAuthorizationActivation" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "MachineAuthorizationActivation" FROM anon;
    REVOKE ALL ON FUNCTION record_staging_machine_authorization_activation(
      TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "MachineAuthorizationActivation" FROM authenticated;
    REVOKE ALL ON FUNCTION record_staging_machine_authorization_activation(
      TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID
    ) FROM authenticated;
  END IF;
END;
$$;

COMMIT;
