BEGIN;

-- This migration records a reviewed human decision only. It deliberately does
-- not modify MachineClient, MachineCredential, MachineClientGrant, feature
-- flags, or the three triggers that reject ACTIVE authorization.
CREATE TABLE "MachineAuthorizationApproval" (
  "id" UUID NOT NULL,
  "machineClientId" UUID NOT NULL,
  "environment" "MachineEnvironment" NOT NULL,
  "credentialId" UUID NOT NULL,
  "approvedByUserId" UUID NOT NULL,
  "certificationAuditEventId" UUID NOT NULL,
  "approvalAuditEventId" UUID NOT NULL,
  "certificationCorrelationId" UUID NOT NULL,
  "approvalCorrelationId" UUID NOT NULL,
  "certificationEvidenceDigestSha256" CHAR(64) NOT NULL,
  "clientVersion" INTEGER NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "grantVersions" JSONB NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "decision" VARCHAR(40) NOT NULL,
  "approvalSourceCommitSha" VARCHAR(64) NOT NULL,
  "approvalSourceTreeSha" VARCHAR(64) NOT NULL,
  "approvalDigestSha256" CHAR(64) NOT NULL,
  "approvedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MachineAuthorizationApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MachineAuthorizationApproval_staging_only" CHECK ("environment" = 'STAGING'),
  CONSTRAINT "MachineAuthorizationApproval_decision_check" CHECK (
    "decision" = 'APPROVED_PENDING_ACTIVATION'
  ),
  CONSTRAINT "MachineAuthorizationApproval_versions_positive" CHECK (
    "clientVersion" > 0 AND "credentialVersion" > 0
  ),
  CONSTRAINT "MachineAuthorizationApproval_reason_check" CHECK (
    "reason" = BTRIM("reason")
    AND CHAR_LENGTH("reason") BETWEEN 10 AND 500
    AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~* '(bearer[[:space:]]+|client[_ -]?secret|access[_ -]?token|authorization[[:space:]]*:)'
    AND "reason" !~ '[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'
  ),
  CONSTRAINT "MachineAuthorizationApproval_certification_digest_check" CHECK (
    "certificationEvidenceDigestSha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "MachineAuthorizationApproval_approval_digest_check" CHECK (
    "approvalDigestSha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "MachineAuthorizationApproval_source_commit_check" CHECK (
    "approvalSourceCommitSha" ~ '^[a-f0-9]{40,64}$'
  ),
  CONSTRAINT "MachineAuthorizationApproval_source_tree_check" CHECK (
    "approvalSourceTreeSha" ~ '^[a-f0-9]{40,64}$'
  ),
  CONSTRAINT "MachineAuthorizationApproval_distinct_audits" CHECK (
    "certificationAuditEventId" <> "approvalAuditEventId"
  ),
  CONSTRAINT "MachineAuthorizationApproval_distinct_correlations" CHECK (
    "certificationCorrelationId" <> "approvalCorrelationId"
  )
);

CREATE UNIQUE INDEX "MachineAuthorizationApproval_certification_audit_key"
  ON "MachineAuthorizationApproval"("certificationAuditEventId");
CREATE UNIQUE INDEX "MachineAuthorizationApproval_approval_audit_key"
  ON "MachineAuthorizationApproval"("approvalAuditEventId");
CREATE UNIQUE INDEX "MachineAuthorizationApproval_approval_correlation_key"
  ON "MachineAuthorizationApproval"("approvalCorrelationId");
CREATE UNIQUE INDEX "MachineAuthorizationApproval_digest_key"
  ON "MachineAuthorizationApproval"("approvalDigestSha256");
CREATE INDEX "MachineAuthorizationApproval_client_environment_approved_idx"
  ON "MachineAuthorizationApproval"("machineClientId", "environment", "approvedAt");
CREATE INDEX "MachineAuthorizationApproval_approved_by_idx"
  ON "MachineAuthorizationApproval"("approvedByUserId", "approvedAt");

ALTER TABLE "MachineAuthorizationApproval"
  ADD CONSTRAINT "MachineAuthorizationApproval_client_environment_fkey"
  FOREIGN KEY ("machineClientId", "environment")
  REFERENCES "MachineClient"("id", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationApproval"
  ADD CONSTRAINT "MachineAuthorizationApproval_credential_fkey"
  FOREIGN KEY ("credentialId")
  REFERENCES "MachineCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationApproval"
  ADD CONSTRAINT "MachineAuthorizationApproval_approved_by_fkey"
  FOREIGN KEY ("approvedByUserId")
  REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationApproval"
  ADD CONSTRAINT "MachineAuthorizationApproval_certification_audit_fkey"
  FOREIGN KEY ("certificationAuditEventId")
  REFERENCES "AuditEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAuthorizationApproval"
  ADD CONSTRAINT "MachineAuthorizationApproval_approval_audit_fkey"
  FOREIGN KEY ("approvalAuditEventId")
  REFERENCES "AuditEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_machine_authorization_approval_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MachineAuthorizationApproval is append-only; create a new decision record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_authorization_approval_no_update
BEFORE UPDATE ON "MachineAuthorizationApproval"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_approval_mutation();

CREATE TRIGGER machine_authorization_approval_no_delete
BEFORE DELETE ON "MachineAuthorizationApproval"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_approval_mutation();

CREATE FUNCTION validate_machine_authorization_approval_insert() RETURNS trigger AS $$
DECLARE
  client_row "MachineClient"%ROWTYPE;
  credential_row "MachineCredential"%ROWTYPE;
  approval_audit "AuditEvent"%ROWTYPE;
  certification_audit "AuditEvent"%ROWTYPE;
  certification_after JSONB;
  current_grants JSONB;
  credential_count INTEGER;
  total_grant_count INTEGER;
  pending_grant_count INTEGER;
  certification_count INTEGER;
  active_owner BOOLEAN;
  owner_role_locked BOOLEAN;
  expected_certification_before JSONB;
  expected_certification_after JSONB;
  expected_approval_before JSONB;
  expected_approval_after JSONB;
  recomputed_approval_digest TEXT;
BEGIN
  IF NEW."id" IS DISTINCT FROM NEW."approvalAuditEventId" THEN
    RAISE EXCEPTION 'Machine authorization approval requires the guarded serializable command';
  END IF;

  SELECT * INTO client_row
  FROM "MachineClient"
  WHERE "id" = NEW."machineClientId"
    AND "environment" = NEW."environment"
  FOR UPDATE;

  SELECT user_row."active" INTO active_owner
  FROM "User" user_row
  WHERE user_row."id" = NEW."approvedByUserId"
  FOR SHARE;
  SELECT TRUE INTO owner_role_locked
  FROM "UserRole" role_row
  WHERE role_row."userId" = NEW."approvedByUserId"
    AND role_row."role" = 'OWNER'
  FOR SHARE;

  SELECT COUNT(*)::INTEGER INTO credential_count
  FROM "MachineCredential" counted_credential
  WHERE counted_credential."machineClientId" = NEW."machineClientId"
    AND counted_credential."environment" = NEW."environment";

  SELECT * INTO credential_row
  FROM "MachineCredential"
  WHERE "id" = NEW."credentialId"
    AND "machineClientId" = NEW."machineClientId"
    AND "environment" = NEW."environment"
  FOR UPDATE;

  PERFORM grant_row."scope"
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = NEW."machineClientId"
    AND grant_row."environment" = NEW."environment"
  ORDER BY grant_row."scope"
  FOR UPDATE;

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
         )::INTEGER,
         JSONB_AGG(
           JSONB_BUILD_OBJECT('scope', grant_row."scope", 'version', grant_row."version")
           ORDER BY grant_row."scope"
         ) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
         )
  INTO total_grant_count, pending_grant_count, current_grants
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = NEW."machineClientId"
    AND grant_row."environment" = NEW."environment";

  SELECT * INTO certification_audit
  FROM "AuditEvent"
  WHERE "id" = NEW."certificationAuditEventId";
  certification_after := certification_audit."after";

  SELECT COUNT(*)::INTEGER INTO certification_count
  FROM "AuditEvent"
  WHERE "action" = 'm2m.client.token_certified'
    AND "entityType" = 'MachineClient'
    AND "entityId" = NEW."machineClientId"::TEXT;

  SELECT * INTO approval_audit
  FROM "AuditEvent"
  WHERE "id" = NEW."approvalAuditEventId";

  IF certification_after->>'sourceCommitSha' IS NULL
     OR certification_after->>'sourceCommitSha' !~ '^[a-f0-9]{40,64}$'
     OR certification_after->>'sourceTreeSha' IS NULL
     OR certification_after->>'sourceTreeSha' !~ '^[a-f0-9]{40,64}$'
     OR certification_after->>'verifierDigestSha256' IS NULL
     OR certification_after->>'verifierDigestSha256' !~ '^[a-f0-9]{64}$'
     OR certification_after->>'certifiedAt' IS NULL THEN
    RAISE EXCEPTION 'Machine authorization certification evidence is malformed';
  END IF;

  expected_certification_before := JSONB_BUILD_OBJECT(
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', NEW."clientVersion",
    'credentialStatus', 'PENDING_VERIFICATION',
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', current_grants,
    'credentialVersion', NEW."credentialVersion" - 1,
    'verifiedAt', NULL
  );
  expected_certification_after := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-token-certification.v1',
    'certificationOutcome', 'VERIFIED_PENDING_APPROVAL',
    'runtimeRegistryOutcome', 'UNAUTHORIZED_PENDING',
    'clientKey', 'storefront-staging',
    'machineClientId', NEW."machineClientId"::TEXT,
    'credentialId', NEW."credentialId"::TEXT,
    'environment', 'STAGING',
    'provider', 'AUTH0',
    'issuer', credential_row."issuer",
    'audience', 'https://api.orderpro.internal/local-delivery/staging',
    'allowedAlgorithm', 'RS256',
    'tokenProfile', 'RFC9068',
    'tokenLifetimeSeconds', 3600,
    'scopes', '["local-delivery:holds", "local-delivery:quote"]'::JSONB,
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', NEW."clientVersion",
    'credentialStatus', 'PENDING_VERIFICATION',
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', current_grants,
    'previousCredentialVersion', NEW."credentialVersion" - 1,
    'certifiedCredentialVersion', NEW."credentialVersion",
    'sourceCommitSha', certification_after->>'sourceCommitSha',
    'sourceTreeSha', certification_after->>'sourceTreeSha',
    'verifierDigestSha256', certification_after->>'verifierDigestSha256',
    'certifiedAt', certification_after->>'certifiedAt',
    'correlationId', NEW."certificationCorrelationId"::TEXT,
    'evidenceDigestSha256', NEW."certificationEvidenceDigestSha256"
  );

  recomputed_approval_digest := ENCODE(SHA256(CONVERT_TO(
    CONCAT_WS(E'\n',
      'orderpro.m2m-authorization-approval.v1',
      NEW."machineClientId"::TEXT,
      NEW."credentialId"::TEXT,
      NEW."approvedByUserId"::TEXT,
      NEW."certificationAuditEventId"::TEXT,
      NEW."certificationEvidenceDigestSha256",
      NEW."certificationCorrelationId"::TEXT,
      NEW."approvalAuditEventId"::TEXT,
      NEW."approvalCorrelationId"::TEXT,
      NEW."clientVersion"::TEXT,
      NEW."credentialVersion"::TEXT,
      NEW."grantVersions"::TEXT,
      NEW."reason",
      NEW."approvalSourceCommitSha",
      NEW."approvalSourceTreeSha",
      NEW."approvedAt"::TEXT
    ), 'UTF8')), 'hex');

  expected_approval_before := JSONB_BUILD_OBJECT(
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', NEW."clientVersion",
    'credentialStatus', 'PENDING_VERIFICATION',
    'credentialVersion', NEW."credentialVersion",
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', NEW."grantVersions",
    'ownerUserId', NULL,
    'certificationAuditEventId', NEW."certificationAuditEventId",
    'certificationEvidenceDigestSha256', NEW."certificationEvidenceDigestSha256"
  );
  expected_approval_after := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-approval.v1',
    'decision', 'APPROVED_PENDING_ACTIVATION',
    'authorizationStatus', 'PENDING_VERIFICATION',
    'approvalId', NEW."id",
    'machineClientId', NEW."machineClientId",
    'credentialId', NEW."credentialId",
    'approvedByUserId', NEW."approvedByUserId",
    'certificationAuditEventId', NEW."certificationAuditEventId",
    'certificationCorrelationId', NEW."certificationCorrelationId",
    'certificationEvidenceDigestSha256', NEW."certificationEvidenceDigestSha256",
    'approvalCorrelationId', NEW."approvalCorrelationId",
    'clientVersion', NEW."clientVersion",
    'credentialVersion', NEW."credentialVersion",
    'grantVersions', NEW."grantVersions",
    'approvalSourceCommitSha', NEW."approvalSourceCommitSha",
    'approvalSourceTreeSha', NEW."approvalSourceTreeSha",
    'approvalDigestSha256', NEW."approvalDigestSha256",
    'approvedAt', NEW."approvedAt"
  );

  IF active_owner IS DISTINCT FROM TRUE
     OR owner_role_locked IS DISTINCT FROM TRUE
     OR client_row."id" IS NULL
     OR client_row."key" <> 'storefront-staging'
     OR client_row."displayName" <> 'OrderPro Storefront STAGING'
     OR client_row."environment" <> 'STAGING'
     OR client_row."status" <> 'PENDING_VERIFICATION'
     OR client_row."ownerUserId" IS NOT NULL
     OR client_row."version" <> NEW."clientVersion"
     OR client_row."activatedAt" IS NOT NULL
     OR client_row."suspendedAt" IS NOT NULL
     OR client_row."revokedAt" IS NOT NULL
     OR credential_count <> 1
     OR credential_row."id" IS NULL
     OR credential_row."provider" <> 'AUTH0'
     OR credential_row."issuer" IS DISTINCT FROM certification_after->>'issuer'
     OR credential_row."status" <> 'PENDING_VERIFICATION'
     OR credential_row."version" <> NEW."credentialVersion"
     OR credential_row."verifiedAt" IS NULL
     OR credential_row."verifiedAt" IS DISTINCT FROM
          (certification_after->>'certifiedAt')::TIMESTAMPTZ
     OR credential_row."activatedAt" IS NOT NULL
     OR credential_row."suspendedAt" IS NOT NULL
     OR credential_row."revokedAt" IS NOT NULL
     OR total_grant_count <> 2
     OR pending_grant_count <> 2
     OR current_grants IS DISTINCT FROM NEW."grantVersions"
     OR current_grants->0->>'scope' IS DISTINCT FROM 'local-delivery:holds'
     OR current_grants->1->>'scope' IS DISTINCT FROM 'local-delivery:quote'
     OR certification_count <> 1
     OR approval_audit."id" IS NULL
     OR certification_audit."id" IS NULL
     OR approval_audit."action" <> 'm2m.client.authorization_approved'
     OR approval_audit."actorId" IS DISTINCT FROM NEW."approvedByUserId"
     OR approval_audit."entityType" <> 'MachineClient'
     OR approval_audit."entityId" IS DISTINCT FROM NEW."machineClientId"::TEXT
     OR approval_audit."correlationId" IS DISTINCT FROM NEW."approvalCorrelationId"::TEXT
     OR approval_audit."reason" IS DISTINCT FROM NEW."reason"
     OR approval_audit."locationCode" IS NOT NULL
     OR approval_audit."occurredAt" IS DISTINCT FROM NEW."approvedAt"
     OR approval_audit."before" IS DISTINCT FROM expected_approval_before
     OR approval_audit."after" IS DISTINCT FROM expected_approval_after
     OR recomputed_approval_digest IS DISTINCT FROM NEW."approvalDigestSha256"
     OR certification_audit."action" <> 'm2m.client.token_certified'
     OR certification_audit."actorId" IS NOT NULL
     OR certification_audit."entityType" <> 'MachineClient'
     OR certification_audit."entityId" IS DISTINCT FROM NEW."machineClientId"::TEXT
     OR certification_audit."correlationId" IS DISTINCT FROM NEW."certificationCorrelationId"::TEXT
     OR certification_audit."before" IS DISTINCT FROM expected_certification_before
     OR certification_audit."after" IS DISTINCT FROM expected_certification_after THEN
    RAISE EXCEPTION 'Machine authorization approval snapshot is invalid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_authorization_approval_validate_insert
BEFORE INSERT ON "MachineAuthorizationApproval"
FOR EACH ROW EXECUTE FUNCTION validate_machine_authorization_approval_insert();

CREATE FUNCTION record_staging_machine_authorization_approval(
  p_client_key TEXT,
  p_actor_user_id UUID,
  p_reason TEXT,
  p_certification_audit_event_id UUID,
  p_certification_evidence_digest_sha256 TEXT,
  p_approval_source_commit_sha TEXT,
  p_approval_source_tree_sha TEXT,
  p_certification_correlation_id UUID,
  p_approval_audit_event_id UUID,
  p_approval_correlation_id UUID
) RETURNS TABLE (
  "approvalId" UUID,
  "clientKey" TEXT,
  "environment" TEXT,
  "decision" TEXT,
  "authorizationStatus" TEXT,
  "approvalAuditEventId" UUID,
  "approvalCorrelationId" UUID,
  "approvalDigestSha256" TEXT
) AS $$
DECLARE
  client_row "MachineClient"%ROWTYPE;
  credential_row "MachineCredential"%ROWTYPE;
  certification_audit "AuditEvent"%ROWTYPE;
  certification_after JSONB;
  certification_before JSONB;
  current_grants JSONB;
  credential_count INTEGER;
  grant_count INTEGER;
  pending_grant_count INTEGER;
  certification_count INTEGER;
  active_owner BOOLEAN;
  owner_role_locked BOOLEAN;
  approval_time TIMESTAMPTZ;
  approval_digest TEXT;
  approval_before JSONB;
  approval_after JSONB;
BEGIN
  IF p_client_key IS DISTINCT FROM 'storefront-staging'
     OR p_reason IS NULL
     OR p_reason IS DISTINCT FROM BTRIM(p_reason)
     OR CHAR_LENGTH(p_reason) NOT BETWEEN 10 AND 500
     OR p_reason ~ '[[:cntrl:]]'
     OR p_reason ~* '(bearer[[:space:]]+|client[_ -]?secret|access[_ -]?token|authorization[[:space:]]*:)'
     OR p_reason ~ '[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'
     OR p_certification_evidence_digest_sha256 !~ '^[a-f0-9]{64}$'
     OR p_approval_source_commit_sha !~ '^[a-f0-9]{40,64}$'
     OR p_approval_source_tree_sha !~ '^[a-f0-9]{40,64}$'
     OR p_certification_audit_event_id = p_approval_audit_event_id
     OR p_certification_correlation_id = p_approval_correlation_id THEN
    RAISE EXCEPTION 'Machine authorization approval input is invalid';
  END IF;

  SELECT * INTO client_row
  FROM "MachineClient"
  WHERE "key" = p_client_key
  FOR UPDATE;

  IF client_row."id" IS NULL
     OR client_row."displayName" <> 'OrderPro Storefront STAGING'
     OR client_row."environment" <> 'STAGING'
     OR client_row."status" <> 'PENDING_VERIFICATION'
     OR client_row."ownerUserId" IS NOT NULL
     OR client_row."version" < 1
     OR client_row."activatedAt" IS NOT NULL
     OR client_row."suspendedAt" IS NOT NULL
     OR client_row."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Machine authorization approval snapshot is not pending';
  END IF;

  -- Lock first and validate the locked rows. This remains race-safe even when
  -- the function is invoked outside the CLI's SERIALIZABLE transaction.
  SELECT user_row."active" INTO active_owner
  FROM "User" user_row
  WHERE user_row."id" = p_actor_user_id
  FOR SHARE;
  IF active_owner IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Machine authorization approval requires an active Owner';
  END IF;

  SELECT TRUE INTO owner_role_locked
  FROM "UserRole" role_row
  WHERE role_row."userId" = p_actor_user_id
    AND role_row."role" = 'OWNER'
  FOR SHARE;
  IF owner_role_locked IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Machine authorization approval requires an active Owner';
  END IF;

  SELECT * INTO certification_audit
  FROM "AuditEvent"
  WHERE "id" = p_certification_audit_event_id;
  certification_after := certification_audit."after";
  certification_before := certification_audit."before";

  IF certification_audit."id" IS NULL
     OR certification_audit."action" <> 'm2m.client.token_certified'
     OR certification_audit."entityType" <> 'MachineClient'
     OR certification_audit."entityId" IS DISTINCT FROM client_row."id"::TEXT
     OR certification_audit."actorId" IS NOT NULL
     OR certification_audit."correlationId" IS DISTINCT FROM p_certification_correlation_id::TEXT
     OR certification_after IS NULL
     OR certification_before IS NULL
     OR certification_after->>'schemaVersion'
          IS DISTINCT FROM 'orderpro.m2m-token-certification.v1'
     OR certification_after->>'certificationOutcome'
          IS DISTINCT FROM 'VERIFIED_PENDING_APPROVAL'
     OR certification_after->>'runtimeRegistryOutcome'
          IS DISTINCT FROM 'UNAUTHORIZED_PENDING'
     OR certification_after->>'clientKey' IS DISTINCT FROM p_client_key
     OR certification_after->>'machineClientId' IS DISTINCT FROM client_row."id"::TEXT
     OR certification_after->>'environment' IS DISTINCT FROM 'STAGING'
     OR certification_after->>'provider' IS DISTINCT FROM 'AUTH0'
     OR certification_after->>'audience'
          IS DISTINCT FROM 'https://api.orderpro.internal/local-delivery/staging'
     OR certification_after->>'allowedAlgorithm' IS DISTINCT FROM 'RS256'
     OR certification_after->>'tokenProfile' IS DISTINCT FROM 'RFC9068'
     OR certification_after->>'tokenLifetimeSeconds' IS DISTINCT FROM '3600'
     OR certification_after->'scopes'
          IS DISTINCT FROM '["local-delivery:holds", "local-delivery:quote"]'::JSONB
     OR certification_after->>'clientStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_after->>'credentialStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_after->>'grantStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_after->>'correlationId'
          IS DISTINCT FROM p_certification_correlation_id::TEXT
     OR certification_after->>'evidenceDigestSha256'
          IS DISTINCT FROM p_certification_evidence_digest_sha256
     OR certification_before->>'clientStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_before->>'credentialStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_before->>'grantStatus' IS DISTINCT FROM 'PENDING_VERIFICATION'
     OR certification_before->'verifiedAt' IS DISTINCT FROM 'null'::JSONB THEN
    RAISE EXCEPTION 'Machine authorization certification evidence is invalid';
  END IF;

  IF certification_after->>'credentialId' IS NULL
     OR certification_after->>'credentialId' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR certification_after->>'clientVersion' IS NULL
     OR certification_after->>'clientVersion' !~ '^[1-9][0-9]*$'
     OR certification_after->>'certifiedCredentialVersion' IS NULL
     OR certification_after->>'certifiedCredentialVersion' !~ '^[1-9][0-9]*$'
     OR certification_after->>'previousCredentialVersion' IS NULL
     OR certification_after->>'previousCredentialVersion' !~ '^[1-9][0-9]*$'
     OR certification_before->>'clientVersion' IS NULL
     OR certification_before->>'clientVersion' !~ '^[1-9][0-9]*$'
     OR certification_before->>'credentialVersion' IS NULL
     OR certification_before->>'credentialVersion' !~ '^[1-9][0-9]*$'
     OR certification_after->>'sourceCommitSha' IS NULL
     OR certification_after->>'sourceCommitSha' !~ '^[a-f0-9]{40,64}$'
     OR certification_after->>'sourceTreeSha' IS NULL
     OR certification_after->>'sourceTreeSha' !~ '^[a-f0-9]{40,64}$'
     OR certification_after->>'verifierDigestSha256' IS NULL
     OR certification_after->>'verifierDigestSha256' !~ '^[a-f0-9]{64}$'
     OR certification_after->>'certifiedAt' IS NULL THEN
    RAISE EXCEPTION 'Machine authorization certification snapshot is malformed';
  END IF;

  SELECT COUNT(*)::INTEGER INTO credential_count
  FROM "MachineCredential" counted_credential
  WHERE counted_credential."machineClientId" = client_row."id"
    AND counted_credential."environment" = 'STAGING';

  SELECT * INTO credential_row
  FROM "MachineCredential" selected_credential
  WHERE selected_credential."id" = (certification_after->>'credentialId')::UUID
    AND selected_credential."machineClientId" = client_row."id"
    AND selected_credential."environment" = 'STAGING'
  FOR UPDATE;

  -- Lock every current grant in deterministic order so the approved snapshot
  -- cannot change between validation, audit insertion and approval insertion.
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
           JSONB_BUILD_OBJECT('scope', grant_row."scope", 'version', grant_row."version")
           ORDER BY grant_row."scope"
         ) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
         )
  INTO grant_count, pending_grant_count, current_grants
  FROM "MachineClientGrant" grant_row
  WHERE grant_row."machineClientId" = client_row."id"
    AND grant_row."environment" = 'STAGING';

  SELECT COUNT(*)::INTEGER INTO certification_count
  FROM "AuditEvent"
  WHERE "action" = 'm2m.client.token_certified'
    AND "entityType" = 'MachineClient'
    AND "entityId" = client_row."id"::TEXT;

  IF credential_count <> 1
     OR credential_row."id" IS NULL
     OR credential_row."provider" <> 'AUTH0'
     OR credential_row."issuer" IS DISTINCT FROM certification_after->>'issuer'
     OR credential_row."status" <> 'PENDING_VERIFICATION'
     OR credential_row."version" <> (certification_after->>'certifiedCredentialVersion')::INTEGER
     OR credential_row."verifiedAt" IS NULL
     OR credential_row."verifiedAt" IS DISTINCT FROM (certification_after->>'certifiedAt')::TIMESTAMPTZ
     OR credential_row."activatedAt" IS NOT NULL
     OR credential_row."suspendedAt" IS NOT NULL
     OR credential_row."revokedAt" IS NOT NULL
     OR client_row."version" <> (certification_after->>'clientVersion')::INTEGER
     OR (certification_before->>'clientVersion')::INTEGER <> client_row."version"
     OR (certification_before->>'credentialVersion')::INTEGER
          <> (certification_after->>'previousCredentialVersion')::INTEGER
     OR (certification_after->>'certifiedCredentialVersion')::INTEGER
          <> (certification_after->>'previousCredentialVersion')::INTEGER + 1
     OR grant_count <> 2
     OR pending_grant_count <> 2
     OR current_grants IS DISTINCT FROM certification_after->'grantVersions'
     OR current_grants IS DISTINCT FROM certification_before->'grantVersions'
     OR certification_count <> 1 THEN
    RAISE EXCEPTION 'Machine authorization approval snapshot changed after certification';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MachineAuthorizationApproval"
    WHERE "certificationAuditEventId" = p_certification_audit_event_id
  ) THEN
    RAISE EXCEPTION 'Machine authorization certification is already approved';
  END IF;

  approval_time := CLOCK_TIMESTAMP();
  approval_digest := ENCODE(SHA256(CONVERT_TO(
    CONCAT_WS(E'\n',
      'orderpro.m2m-authorization-approval.v1',
      client_row."id"::TEXT,
      credential_row."id"::TEXT,
      p_actor_user_id::TEXT,
      p_certification_audit_event_id::TEXT,
      p_certification_evidence_digest_sha256,
      p_certification_correlation_id::TEXT,
      p_approval_audit_event_id::TEXT,
      p_approval_correlation_id::TEXT,
      client_row."version"::TEXT,
      credential_row."version"::TEXT,
      current_grants::TEXT,
      p_reason,
      p_approval_source_commit_sha,
      p_approval_source_tree_sha,
      approval_time::TEXT
    ), 'UTF8')), 'hex');

  approval_before := JSONB_BUILD_OBJECT(
    'clientStatus', 'PENDING_VERIFICATION',
    'clientVersion', client_row."version",
    'credentialStatus', 'PENDING_VERIFICATION',
    'credentialVersion', credential_row."version",
    'grantStatus', 'PENDING_VERIFICATION',
    'grantVersions', current_grants,
    'ownerUserId', NULL,
    'certificationAuditEventId', p_certification_audit_event_id,
    'certificationEvidenceDigestSha256', p_certification_evidence_digest_sha256
  );
  approval_after := JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.m2m-authorization-approval.v1',
    'decision', 'APPROVED_PENDING_ACTIVATION',
    'authorizationStatus', 'PENDING_VERIFICATION',
    'approvalId', p_approval_audit_event_id,
    'machineClientId', client_row."id",
    'credentialId', credential_row."id",
    'approvedByUserId', p_actor_user_id,
    'certificationAuditEventId', p_certification_audit_event_id,
    'certificationCorrelationId', p_certification_correlation_id,
    'certificationEvidenceDigestSha256', p_certification_evidence_digest_sha256,
    'approvalCorrelationId', p_approval_correlation_id,
    'clientVersion', client_row."version",
    'credentialVersion', credential_row."version",
    'grantVersions', current_grants,
    'approvalSourceCommitSha', p_approval_source_commit_sha,
    'approvalSourceTreeSha', p_approval_source_tree_sha,
    'approvalDigestSha256', approval_digest,
    'approvedAt', approval_time
  );

  INSERT INTO "AuditEvent" (
    "id", "actorId", "action", "entityType", "entityId",
    "correlationId", "reason", "before", "after", "occurredAt"
  ) VALUES (
    p_approval_audit_event_id, p_actor_user_id,
    'm2m.client.authorization_approved', 'MachineClient', client_row."id"::TEXT,
    p_approval_correlation_id::TEXT, p_reason, approval_before, approval_after,
    approval_time
  );

  INSERT INTO "MachineAuthorizationApproval" (
    "id", "machineClientId", "environment", "credentialId", "approvedByUserId",
    "certificationAuditEventId", "approvalAuditEventId",
    "certificationCorrelationId", "approvalCorrelationId",
    "certificationEvidenceDigestSha256", "clientVersion", "credentialVersion",
    "grantVersions", "reason", "decision", "approvalSourceCommitSha",
    "approvalSourceTreeSha", "approvalDigestSha256", "approvedAt"
  ) VALUES (
    p_approval_audit_event_id, client_row."id", 'STAGING', credential_row."id",
    p_actor_user_id, p_certification_audit_event_id, p_approval_audit_event_id,
    p_certification_correlation_id, p_approval_correlation_id,
    p_certification_evidence_digest_sha256, client_row."version",
    credential_row."version", current_grants, p_reason,
    'APPROVED_PENDING_ACTIVATION', p_approval_source_commit_sha,
    p_approval_source_tree_sha, approval_digest, approval_time
  );

  RETURN QUERY SELECT
    p_approval_audit_event_id,
    client_row."key"::TEXT,
    client_row."environment"::TEXT,
    'APPROVED_PENDING_ACTIVATION'::TEXT,
    client_row."status"::TEXT,
    p_approval_audit_event_id,
    p_approval_correlation_id,
    approval_digest;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION record_staging_machine_authorization_approval(
  TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID, UUID
) FROM PUBLIC;

ALTER TABLE "MachineAuthorizationApproval" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "MachineAuthorizationApproval" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "MachineAuthorizationApproval" FROM anon;
    REVOKE ALL ON FUNCTION record_staging_machine_authorization_approval(
      TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID, UUID
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "MachineAuthorizationApproval" FROM authenticated;
    REVOKE ALL ON FUNCTION record_staging_machine_authorization_approval(
      TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, UUID, UUID
    ) FROM authenticated;
  END IF;
END;
$$;

COMMIT;
