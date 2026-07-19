-- Durable machine identities are separate from human Supabase users. External
-- Auth0 credentials map to stable OrderPro client keys used by idempotency and
-- ownership. This migration intentionally creates no client records.
CREATE TYPE "MachineEnvironment" AS ENUM ('STAGING', 'PRODUCTION');
CREATE TYPE "MachineAuthorizationStatus" AS ENUM (
  'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REVOKED'
);
CREATE TYPE "MachineCredentialProvider" AS ENUM ('AUTH0');

CREATE TABLE "MachineClient" (
  "id" UUID NOT NULL,
  "key" VARCHAR(120) NOT NULL,
  "displayName" VARCHAR(160) NOT NULL,
  "environment" "MachineEnvironment" NOT NULL,
  "status" "MachineAuthorizationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "ownerUserId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "activatedAt" TIMESTAMPTZ,
  "suspendedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "MachineClient_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MachineClient_key_format" CHECK (
    "key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  CONSTRAINT "MachineClient_version_positive" CHECK ("version" > 0),
  CONSTRAINT "MachineClient_status_timestamps" CHECK (
    ("status" = 'PENDING_VERIFICATION' AND "activatedAt" IS NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'SUSPENDED' AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "MachineCredential" (
  "id" UUID NOT NULL,
  "machineClientId" UUID NOT NULL,
  "environment" "MachineEnvironment" NOT NULL,
  "provider" "MachineCredentialProvider" NOT NULL,
  "issuer" VARCHAR(255) NOT NULL,
  "externalClientId" VARCHAR(120) NOT NULL,
  "status" "MachineAuthorizationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "version" INTEGER NOT NULL DEFAULT 1,
  "verifiedAt" TIMESTAMPTZ,
  "activatedAt" TIMESTAMPTZ,
  "suspendedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "lastUsedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "MachineCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MachineCredential_issuer_auth0_https" CHECK (
    "provider" <> 'AUTH0'
    OR "issuer" ~ '^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.auth0\.com/$'
  ),
  CONSTRAINT "MachineCredential_external_client_format" CHECK (
    "externalClientId" ~ '^[A-Za-z0-9_-]{8,120}$'
  ),
  CONSTRAINT "MachineCredential_version_positive" CHECK ("version" > 0),
  CONSTRAINT "MachineCredential_status_timestamps" CHECK (
    ("status" = 'PENDING_VERIFICATION' AND "activatedAt" IS NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "verifiedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'SUSPENDED' AND "verifiedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "MachineClientGrant" (
  "machineClientId" UUID NOT NULL,
  "environment" "MachineEnvironment" NOT NULL,
  "scope" VARCHAR(100) NOT NULL,
  "status" "MachineAuthorizationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "version" INTEGER NOT NULL DEFAULT 1,
  "activatedAt" TIMESTAMPTZ,
  "suspendedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "MachineClientGrant_pkey" PRIMARY KEY ("machineClientId", "environment", "scope"),
  CONSTRAINT "MachineClientGrant_scope_format" CHECK (
    "scope" ~ '^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$'
  ),
  CONSTRAINT "MachineClientGrant_version_positive" CHECK ("version" > 0),
  CONSTRAINT "MachineClientGrant_status_timestamps" CHECK (
    ("status" = 'PENDING_VERIFICATION' AND "activatedAt" IS NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'SUSPENDED' AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MachineClient_key_key" ON "MachineClient"("key");
CREATE UNIQUE INDEX "MachineClient_id_environment_key" ON "MachineClient"("id", "environment");
CREATE INDEX "MachineClient_environment_status_idx" ON "MachineClient"("environment", "status");
CREATE INDEX "MachineClient_owner_idx" ON "MachineClient"("ownerUserId");
CREATE UNIQUE INDEX "MachineCredential_provider_issuer_external_key"
  ON "MachineCredential"("provider", "issuer", "externalClientId");
CREATE INDEX "MachineCredential_client_environment_status_idx"
  ON "MachineCredential"("machineClientId", "environment", "status");
CREATE INDEX "MachineClientGrant_environment_status_scope_idx"
  ON "MachineClientGrant"("environment", "status", "scope");

ALTER TABLE "MachineClient"
  ADD CONSTRAINT "MachineClient_owner_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineCredential"
  ADD CONSTRAINT "MachineCredential_client_environment_fkey"
  FOREIGN KEY ("machineClientId", "environment")
  REFERENCES "MachineClient"("id", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineClientGrant"
  ADD CONSTRAINT "MachineClientGrant_client_environment_fkey"
  FOREIGN KEY ("machineClientId", "environment")
  REFERENCES "MachineClient"("id", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Credential identity, internal ownership keys and grant identity are immutable.
-- Rotation creates another credential; it never rewrites historical identity.
CREATE FUNCTION protect_machine_client_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."key" IS DISTINCT FROM NEW."key"
     OR OLD."environment" IS DISTINCT FROM NEW."environment" THEN
    RAISE EXCEPTION 'Machine client identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_machine_credential_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."machineClientId" IS DISTINCT FROM NEW."machineClientId"
     OR OLD."environment" IS DISTINCT FROM NEW."environment"
     OR OLD."provider" IS DISTINCT FROM NEW."provider"
     OR OLD."issuer" IS DISTINCT FROM NEW."issuer"
     OR OLD."externalClientId" IS DISTINCT FROM NEW."externalClientId" THEN
    RAISE EXCEPTION 'Machine credential identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_machine_grant_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."machineClientId" IS DISTINCT FROM NEW."machineClientId"
     OR OLD."environment" IS DISTINCT FROM NEW."environment"
     OR OLD."scope" IS DISTINCT FROM NEW."scope" THEN
    RAISE EXCEPTION 'Machine client grant identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_client_identity_immutable
BEFORE UPDATE ON "MachineClient"
FOR EACH ROW EXECUTE FUNCTION protect_machine_client_identity();

CREATE TRIGGER machine_credential_identity_immutable
BEFORE UPDATE ON "MachineCredential"
FOR EACH ROW EXECUTE FUNCTION protect_machine_credential_identity();

CREATE TRIGGER machine_grant_identity_immutable
BEFORE UPDATE ON "MachineClientGrant"
FOR EACH ROW EXECUTE FUNCTION protect_machine_grant_identity();

-- This phase can onboard PENDING_VERIFICATION rows but cannot activate them.
-- A future reviewed migration must remove these triggers during audited approval.
CREATE FUNCTION reject_machine_authorization_activation() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' THEN
    RAISE EXCEPTION 'Machine authorization activation requires a reviewed migration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_client_no_activation
BEFORE INSERT OR UPDATE ON "MachineClient"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_activation();

CREATE TRIGGER machine_credential_no_activation
BEFORE INSERT OR UPDATE ON "MachineCredential"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_activation();

CREATE TRIGGER machine_grant_no_activation
BEFORE INSERT OR UPDATE ON "MachineClientGrant"
FOR EACH ROW EXECUTE FUNCTION reject_machine_authorization_activation();

-- Authorization history is revoked/suspended rather than hard-deleted.
CREATE FUNCTION reject_machine_registry_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Machine authorization records are retained; revoke instead of deleting';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_client_no_delete
BEFORE DELETE ON "MachineClient"
FOR EACH ROW EXECUTE FUNCTION reject_machine_registry_delete();

CREATE TRIGGER machine_credential_no_delete
BEFORE DELETE ON "MachineCredential"
FOR EACH ROW EXECUTE FUNCTION reject_machine_registry_delete();

CREATE TRIGGER machine_grant_no_delete
BEFORE DELETE ON "MachineClientGrant"
FOR EACH ROW EXECUTE FUNCTION reject_machine_registry_delete();

ALTER TABLE "MachineClient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineClientGrant" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "MachineClient", "MachineCredential", "MachineClientGrant" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "MachineClient", "MachineCredential", "MachineClientGrant" FROM authenticated;
  END IF;
END;
$$;
