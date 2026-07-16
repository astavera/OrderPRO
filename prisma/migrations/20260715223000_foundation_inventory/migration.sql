-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('WAREHOUSE', 'STORE');

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('OWNER', 'OPERATIONS_ADMIN', 'INVENTORY_CONTROLLER', 'STORE_MANAGER', 'STORE_STAFF', 'WAREHOUSE_MANAGER', 'WAREHOUSE_STAFF', 'AUDITOR');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "ProductIdentifierType" AS ENUM ('UPC', 'SKU', 'GTIN', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ContainerType" AS ENUM ('BOX', 'ACTIVE_PICK_BIN', 'TOTE');

-- CreateEnum
CREATE TYPE "ContainerStatus" AS ENUM ('OPEN', 'MANIFEST_CLOSED', 'SEALED', 'STAGED', 'IN_TRANSIT', 'RECEIVED_PENDING_VERIFICATION', 'RECEIVED', 'PUTAWAY', 'ACTIVE', 'QUARANTINED', 'DAMAGED', 'LOST', 'EMPTY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ManifestStatus" AS ENUM ('DRAFT', 'CLOSED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SealAction" AS ENUM ('APPLIED', 'BROKEN');

-- CreateEnum
CREATE TYPE "InventoryAvailabilityState" AS ENUM ('UNAVAILABLE', 'STAGED', 'IN_TRANSIT', 'RECEIVED_PENDING_ACTIVATION', 'AVAILABLE_ONLINE', 'RESERVED', 'ALLOCATED', 'PICKED', 'SOLD', 'QUARANTINED', 'RETURN_STAGED');

-- CreateEnum
CREATE TYPE "InventoryLedgerEventType" AS ENUM ('OPENING_BALANCE', 'PACK_ACCEPTED', 'PACK_CORRECTED', 'STAGED', 'DISPATCHED', 'RECEIVED', 'QUARANTINED', 'PUTAWAY', 'ACTIVATED', 'DEACTIVATED', 'MOVED', 'RESERVED', 'RESERVATION_RELEASED', 'ALLOCATED', 'PICKED', 'SHORTAGE', 'RETURNED', 'COUNT_GAIN', 'COUNT_LOSS');

-- CreateTable
CREATE TABLE "OperationalLocation" (
    "id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquareLocationMapping" (
    "id" UUID NOT NULL,
    "operationalLocationId" UUID NOT NULL,
    "squareLocationId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "verifiedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquareLocationMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" UUID NOT NULL,
    "role" "RoleCode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "UserLocationGrant" (
    "userId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLocationGrant_pkey" PRIMARY KEY ("userId","locationId")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "lockedUntil" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "rules" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "locationCode" TEXT,
    "correlationId" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "squareVariationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIdentifier" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "type" "ProductIdentifierType" NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" UUID NOT NULL,
    "operationalLocationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pickSequence" INTEGER,
    "maxContainerCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "ownerLocationId" UUID NOT NULL,
    "sourceReference" TEXT,
    "seasonCode" TEXT,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Container" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "type" "ContainerType" NOT NULL,
    "status" "ContainerStatus" NOT NULL DEFAULT 'OPEN',
    "ownerLocationId" UUID NOT NULL,
    "currentLocationId" UUID NOT NULL,
    "storageLocationId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestVersion" (
    "id" UUID NOT NULL,
    "containerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "contentHash" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManifestVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestLine" (
    "id" UUID NOT NULL,
    "manifestVersionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "inventoryLotId" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManifestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SealEvent" (
    "id" UUID NOT NULL,
    "containerId" UUID NOT NULL,
    "sealCode" TEXT NOT NULL,
    "action" "SealAction" NOT NULL,
    "reason" TEXT,
    "actorId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLedgerEntry" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "eventType" "InventoryLedgerEventType" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "inventoryLotId" UUID NOT NULL,
    "containerId" UUID,
    "quantity" DECIMAL(18,3) NOT NULL,
    "fromAvailabilityState" "InventoryAvailabilityState",
    "toAvailabilityState" "InventoryAvailabilityState",
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "fromStorageLocationId" UUID,
    "toStorageLocationId" UUID,
    "businessReferenceType" TEXT NOT NULL,
    "businessReferenceId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContainerContentProjection" (
    "containerId" UUID NOT NULL,
    "inventoryLotId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "ledgerSequence" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContainerContentProjection_pkey" PRIMARY KEY ("containerId","inventoryLotId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalLocation_code_key" ON "OperationalLocation"("code");

-- CreateIndex
CREATE INDEX "SquareLocationMapping_operationalLocationId_effectiveFrom_idx" ON "SquareLocationMapping"("operationalLocationId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "SquareLocationMapping_squareLocationId_effectiveFrom_key" ON "SquareLocationMapping"("squareLocationId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "User_subject_key" ON "User"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_nextAttemptAt_idx" ON "WebhookInbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_provider_externalId_key" ON "WebhookInbox"("provider", "externalId");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_aggregateType_aggregateId_idx" ON "OutboxMessage"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_occurredAt_idx" ON "AuditEvent"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_squareVariationId_key" ON "Product"("squareVariationId");

-- CreateIndex
CREATE INDEX "ProductIdentifier_productId_idx" ON "ProductIdentifier"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductIdentifier_type_normalizedValue_key" ON "ProductIdentifier"("type", "normalizedValue");

-- CreateIndex
CREATE INDEX "StorageLocation_operationalLocationId_active_idx" ON "StorageLocation"("operationalLocationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_operationalLocationId_code_key" ON "StorageLocation"("operationalLocationId", "code");

-- CreateIndex
CREATE INDEX "InventoryLot_productId_ownerLocationId_idx" ON "InventoryLot"("productId", "ownerLocationId");

-- CreateIndex
CREATE INDEX "InventoryLot_ownerLocationId_seasonCode_idx" ON "InventoryLot"("ownerLocationId", "seasonCode");

-- CreateIndex
CREATE UNIQUE INDEX "Container_code_key" ON "Container"("code");

-- CreateIndex
CREATE INDEX "Container_ownerLocationId_status_idx" ON "Container"("ownerLocationId", "status");

-- CreateIndex
CREATE INDEX "Container_currentLocationId_storageLocationId_status_idx" ON "Container"("currentLocationId", "storageLocationId", "status");

-- CreateIndex
CREATE INDEX "ManifestVersion_containerId_status_idx" ON "ManifestVersion"("containerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ManifestVersion_containerId_version_key" ON "ManifestVersion"("containerId", "version");

-- CreateIndex
CREATE INDEX "ManifestLine_productId_idx" ON "ManifestLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ManifestLine_manifestVersionId_inventoryLotId_key" ON "ManifestLine"("manifestVersionId", "inventoryLotId");

-- CreateIndex
CREATE INDEX "SealEvent_containerId_occurredAt_idx" ON "SealEvent"("containerId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SealEvent_sealCode_action_key" ON "SealEvent"("sealCode", "action");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedgerEntry_sequence_key" ON "InventoryLedgerEntry"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedgerEntry_idempotencyKey_key" ON "InventoryLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_inventoryLotId_sequence_idx" ON "InventoryLedgerEntry"("inventoryLotId", "sequence");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_containerId_sequence_idx" ON "InventoryLedgerEntry"("containerId", "sequence");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_businessReferenceType_businessReferenc_idx" ON "InventoryLedgerEntry"("businessReferenceType", "businessReferenceId");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_correlationId_idx" ON "InventoryLedgerEntry"("correlationId");

-- CreateIndex
CREATE INDEX "ContainerContentProjection_productId_idx" ON "ContainerContentProjection"("productId");

-- AddForeignKey
ALTER TABLE "SquareLocationMapping" ADD CONSTRAINT "SquareLocationMapping_operationalLocationId_fkey" FOREIGN KEY ("operationalLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocationGrant" ADD CONSTRAINT "UserLocationGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocationGrant" ADD CONSTRAINT "UserLocationGrant_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "OperationalLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIdentifier" ADD CONSTRAINT "ProductIdentifier_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_operationalLocationId_fkey" FOREIGN KEY ("operationalLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_ownerLocationId_fkey" FOREIGN KEY ("ownerLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_ownerLocationId_fkey" FOREIGN KEY ("ownerLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_storageLocationId_fkey" FOREIGN KEY ("storageLocationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestVersion" ADD CONSTRAINT "ManifestVersion_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_manifestVersionId_fkey" FOREIGN KEY ("manifestVersionId") REFERENCES "ManifestVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_inventoryLotId_fkey" FOREIGN KEY ("inventoryLotId") REFERENCES "InventoryLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SealEvent" ADD CONSTRAINT "SealEvent_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_inventoryLotId_fkey" FOREIGN KEY ("inventoryLotId") REFERENCES "InventoryLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "OperationalLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_fromStorageLocationId_fkey" FOREIGN KEY ("fromStorageLocationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_toStorageLocationId_fkey" FOREIGN KEY ("toStorageLocationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerContentProjection" ADD CONSTRAINT "ContainerContentProjection_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerContentProjection" ADD CONSTRAINT "ContainerContentProjection_inventoryLotId_fkey" FOREIGN KEY ("inventoryLotId") REFERENCES "InventoryLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerContentProjection" ADD CONSTRAINT "ContainerContentProjection_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants not expressible in Prisma's schema language.
ALTER TABLE "Container" ADD CONSTRAINT "Container_version_positive" CHECK ("version" > 0);
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "ContainerContentProjection" ADD CONSTRAINT "ContainerContentProjection_quantity_nonnegative" CHECK ("quantity" >= 0);

-- Ledger history is append-only. Corrections must be compensating entries.
CREATE FUNCTION reject_inventory_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InventoryLedgerEntry is append-only; create a compensating entry';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_ledger_no_update
BEFORE UPDATE ON "InventoryLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();

CREATE TRIGGER inventory_ledger_no_delete
BEFORE DELETE ON "InventoryLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();

-- A box can contain only lots owned by that box's owner location.
CREATE FUNCTION enforce_manifest_line_owner() RETURNS trigger AS $$
DECLARE
  box_owner uuid;
  lot_owner uuid;
BEGIN
  SELECT c."ownerLocationId" INTO box_owner
  FROM "Container" c
  JOIN "ManifestVersion" m ON m."containerId" = c.id
  WHERE m.id = NEW."manifestVersionId";

  SELECT "ownerLocationId" INTO lot_owner
  FROM "InventoryLot"
  WHERE id = NEW."inventoryLotId";

  IF box_owner IS NULL OR lot_owner IS NULL OR box_owner <> lot_owner THEN
    RAISE EXCEPTION 'Container and inventory lot must have the same owner';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manifest_line_owner_check
BEFORE INSERT OR UPDATE ON "ManifestLine"
FOR EACH ROW EXECUTE FUNCTION enforce_manifest_line_owner();

-- Supabase hardening: operational tables are never exposed through the public
-- Data API. Prisma connects from the trusted backend using the database URL.
DO $$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_record.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
  END IF;
END;
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
