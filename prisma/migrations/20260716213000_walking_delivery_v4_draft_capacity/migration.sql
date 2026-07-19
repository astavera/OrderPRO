-- Local Walking Delivery v4: additive audit, capacity, and inventory reservation foundation.
-- Existing policy/zone versions and store public IDs remain untouched. This migration
-- seeds DRAFT/STAGING configuration only; it creates no publication or live hold.

BEGIN;

CREATE TYPE "WalkingQuoteReasonCodeV4" AS ENUM (
  'INVALID_INPUT', 'INVALID_ADDRESS', 'GEOCODING_FAILED', 'AMBIGUOUS_ADDRESS',
  'OUTSIDE_WALKING_ZONE', 'NO_ACTIVE_ZONE', 'SERVICE_DAY_UNAVAILABLE',
  'INVALID_ZONE_CONFIGURATION', 'STORE_NOT_AVAILABLE', 'ROUTE_METRICS_REQUIRED',
  'DISTANCE_EXCEEDED', 'ROUTE_TIME_EXCEEDED', 'MINIMUM_ORDER_NOT_MET',
  'FEE_POLICY_INCOMPLETE', 'SLOT_POLICY_INCOMPLETE', 'NO_AVAILABLE_SLOTS',
  'ELIGIBLE', 'MANAGER_REVIEW', 'ADDRESS_NOT_IN_MANHATTAN',
  'OUTSIDE_WALKING_AREA', 'DISTANCE_UNAVAILABLE', 'ROUTING_PROVIDER_UNAVAILABLE',
  'NO_SLOTS_FOR_SELECTED_LOCATION', 'INVENTORY_NOT_READY', 'TRANSFER_REQUIRED',
  'QUOTE_EXPIRED', 'CAPACITY_HOLD_FAILED', 'POLICY_VERSION_UNAVAILABLE',
  'CONTACT_STORE'
);

ALTER TABLE "WalkingDeliveryQuote"
  DROP CONSTRAINT "WalkingDeliveryQuote_fee_outcome_guard",
  DROP CONSTRAINT "WalkingDeliveryQuote_nonpricing_outcome_guard",
  DROP CONSTRAINT "WalkingDeliveryQuote_preroute_outcome_guard",
  DROP CONSTRAINT "WalkingDeliveryQuote_preselection_outcome_guard",
  DROP CONSTRAINT "WalkingDeliveryQuote_eligible_complete",
  DROP CONSTRAINT "WalkingDeliveryQuote_no_slots_complete",
  DROP CONSTRAINT "WalkingDeliveryQuote_manager_review_complete",
  ALTER COLUMN "reasonCode" TYPE "WalkingQuoteReasonCodeV4"
    USING "reasonCode"::TEXT::"WalkingQuoteReasonCodeV4";

CREATE TYPE "WalkingQuoteAssignmentRule" AS ENUM (
  'FIXED_POSTAL_ZONE',
  'NEAREST_WALKING_ROUTE'
);

CREATE TYPE "WalkingDistanceBasis" AS ENUM ('ONE_WAY_FROM_SELECTED_STORE');

CREATE TYPE "WalkingInventoryReadinessStatus" AS ENUM (
  'NOT_EVALUATED',
  'READY',
  'TRANSFER_REQUIRED',
  'NOT_READY',
  'UNAVAILABLE'
);

CREATE TYPE "InventoryTransferStatus" AS ENUM (
  'NOT_REQUIRED',
  'TRANSFER_REQUIRED',
  'REQUESTED',
  'IN_TRANSIT',
  'RECEIVED',
  'READY',
  'CANCELLED',
  'FAILED'
);

CREATE TYPE "WalkingCapacitySlotStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
CREATE TYPE "WalkingCapacityHoldStatus" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED');
CREATE TYPE "WalkingCapacityHoldReleaseReason" AS ENUM (
  'QUOTE_EXPIRED',
  'ORDER_CANCELLED',
  'PAYMENT_FAILED',
  'INVENTORY_UNAVAILABLE',
  'MANUAL'
);
CREATE TYPE "WalkingInventoryReservationStatus" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED');
CREATE TYPE "WalkingInventoryReservationReleaseReason" AS ENUM (
  'QUOTE_EXPIRED',
  'ORDER_CANCELLED',
  'PAYMENT_FAILED',
  'CAPACITY_UNAVAILABLE',
  'MANUAL'
);

ALTER TABLE "FeeCalculationPolicy"
  ADD COLUMN "externalPolicyId" VARCHAR(120);

ALTER TABLE "FeeCalculationPolicyVersion"
  ADD COLUMN "externalVersionId" VARCHAR(120),
  ADD COLUMN "distanceBasis" "WalkingDistanceBasis" NOT NULL
    DEFAULT 'ONE_WAY_FROM_SELECTED_STORE',
  ADD COLUMN "quoteTtlSeconds" INTEGER,
  ADD COLUMN "holdTtlSeconds" INTEGER,
  ADD COLUMN "preparationBufferSeconds" INTEGER,
  ADD COLUMN "handoffBufferSeconds" INTEGER,
  ADD CONSTRAINT "FeeCalculationVersion_ttl_buffer_guard"
    CHECK (
      ("quoteTtlSeconds" IS NULL OR "quoteTtlSeconds" > 0) AND
      ("holdTtlSeconds" IS NULL OR "holdTtlSeconds" > 0) AND
      ("quoteTtlSeconds" IS NULL OR "holdTtlSeconds" IS NULL OR
        "holdTtlSeconds" <= "quoteTtlSeconds") AND
      ("preparationBufferSeconds" IS NULL OR "preparationBufferSeconds" >= 0) AND
      ("handoffBufferSeconds" IS NULL OR "handoffBufferSeconds" >= 0)
    );

ALTER TABLE "FeeCalculationPolicyVersion"
  DROP CONSTRAINT "FeeCalculationVersion_key_format",
  ADD CONSTRAINT "FeeCalculationVersion_key_format"
    CHECK ("versionKey" ~ '^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$');

ALTER TABLE "FeeCalculationTier"
  DROP CONSTRAINT "FeeCalculationTier_key_format",
  ADD CONSTRAINT "FeeCalculationTier_key_format"
    CHECK ("tierKey" ~ '^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$');

CREATE UNIQUE INDEX "FeeCalculationPolicy_external_id_key"
  ON "FeeCalculationPolicy" ("externalPolicyId");
CREATE UNIQUE INDEX "FeeCalculationVersion_external_id_key"
  ON "FeeCalculationPolicyVersion" ("externalVersionId");

CREATE TABLE "WalkingZoneSetVersion" (
  "id" UUID NOT NULL,
  "externalVersionId" VARCHAR(120) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "WalkingZoneVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "environment" "FeePolicyEnvironment" NOT NULL DEFAULT 'STAGING',
  "snapshot" JSONB,
  "digest" VARCHAR(80),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "createdById" UUID,
  "publishedById" UUID,
  "validatedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingZoneSetVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingZoneSetVersion_external_id_format"
    CHECK ("externalVersionId" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "WalkingZoneSetVersion_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "WalkingZoneSetVersion_snapshot_shape"
    CHECK ("snapshot" IS NULL OR JSONB_TYPEOF("snapshot") = 'object'),
  CONSTRAINT "WalkingZoneSetVersion_digest_format"
    CHECK ("digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "WalkingZoneSetVersion_effective_range"
    CHECK (
      "effectiveTo" IS NULL OR
      ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
    ),
  CONSTRAINT "WalkingZoneSetVersion_validated_complete"
    CHECK (
      "status" NOT IN ('VALIDATED', 'PUBLISHED', 'ARCHIVED') OR
      ("snapshot" IS NOT NULL AND "digest" IS NOT NULL AND "validatedAt" IS NOT NULL)
    ),
  CONSTRAINT "WalkingZoneSetVersion_published_complete"
    CHECK (
      "status" NOT IN ('PUBLISHED', 'ARCHIVED') OR
      ("effectiveFrom" IS NOT NULL AND "publishedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "WalkingZoneSetVersion_external_id_key"
  ON "WalkingZoneSetVersion" ("externalVersionId");
CREATE INDEX "WalkingZoneSetVersion_status_environment_idx"
  ON "WalkingZoneSetVersion" ("status", "environment", "effectiveFrom");
CREATE INDEX "WalkingZoneSetVersion_digest_idx"
  ON "WalkingZoneSetVersion" ("digest");

ALTER TABLE "WalkingZoneSetVersion"
  ADD CONSTRAINT "WalkingZoneSetVersion_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneSetVersion_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalkingZoneVersion"
  ADD COLUMN "zoneSetVersionId" UUID,
  ADD CONSTRAINT "WalkingZoneVersion_zone_set_fkey"
    FOREIGN KEY ("zoneSetVersionId") REFERENCES "WalkingZoneSetVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "WalkingZoneVersion_zone_set_status_idx"
  ON "WalkingZoneVersion" ("zoneSetVersionId", "status");

ALTER TABLE "WalkingPublication"
  ADD COLUMN "zoneSetVersionId" UUID,
  ADD CONSTRAINT "WalkingPublication_zone_set_version_fkey"
    FOREIGN KEY ("zoneSetVersionId") REFERENCES "WalkingZoneSetVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "WalkingPublication_zone_set_status_idx"
  ON "WalkingPublication" ("zoneSetVersionId", "status");

CREATE TABLE "LocalDeliveryLocationIdentity" (
  "id" UUID NOT NULL,
  "operationalLocationId" UUID NOT NULL,
  "externalLocationId" VARCHAR(64) NOT NULL,
  "displayName" TEXT NOT NULL,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "city" TEXT NOT NULL,
  "regionCode" CHAR(2) NOT NULL,
  "postalCode" VARCHAR(10) NOT NULL,
  "countryCode" CHAR(2) NOT NULL,
  "latitude" DECIMAL(15, 12) NOT NULL,
  "longitude" DECIMAL(15, 12) NOT NULL,
  "locationPriority" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LocalDeliveryLocationIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LocalDeliveryLocationIdentity_external_format"
    CHECK ("externalLocationId" ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  CONSTRAINT "LocalDeliveryLocationIdentity_name_nonempty"
    CHECK (BTRIM("displayName") <> ''),
  CONSTRAINT "LocalDeliveryLocationIdentity_address_nonempty"
    CHECK (BTRIM("addressLine1") <> '' AND BTRIM("city") <> ''),
  CONSTRAINT "LocalDeliveryLocationIdentity_region_guard"
    CHECK ("regionCode" = 'NY' AND "countryCode" = 'US'),
  CONSTRAINT "LocalDeliveryLocationIdentity_postal_format"
    CHECK ("postalCode" ~ '^[0-9]{5}$'),
  CONSTRAINT "LocalDeliveryLocationIdentity_latitude_range"
    CHECK ("latitude" BETWEEN -90 AND 90),
  CONSTRAINT "LocalDeliveryLocationIdentity_longitude_range"
    CHECK ("longitude" BETWEEN -180 AND 180),
  CONSTRAINT "LocalDeliveryLocationIdentity_priority_positive"
    CHECK ("locationPriority" IS NULL OR "locationPriority" > 0)
);

CREATE UNIQUE INDEX "LocalDeliveryLocationIdentity_location_key"
  ON "LocalDeliveryLocationIdentity" ("operationalLocationId");
CREATE UNIQUE INDEX "LocalDeliveryLocationIdentity_external_key"
  ON "LocalDeliveryLocationIdentity" ("externalLocationId");
CREATE INDEX "LocalDeliveryLocationIdentity_active_idx"
  ON "LocalDeliveryLocationIdentity" ("active", "externalLocationId");
ALTER TABLE "LocalDeliveryLocationIdentity"
  ADD CONSTRAINT "LocalDeliveryLocationIdentity_location_fkey"
    FOREIGN KEY ("operationalLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION protect_local_delivery_location_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Local-delivery external identities cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."operationalLocationId" IS DISTINCT FROM OLD."operationalLocationId" OR
     NEW."externalLocationId" IS DISTINCT FROM OLD."externalLocationId" THEN
    RAISE EXCEPTION 'Local-delivery identity keys are immutable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "WalkingZoneSetVersion" s
    WHERE s."status" IN ('VALIDATED', 'PUBLISHED', 'ARCHIVED')
  ) OR EXISTS (
    SELECT 1 FROM "WalkingDeliveryQuoteCandidateRoute" r
    WHERE r."localDeliveryLocationId" = OLD."id"
  ) THEN
    IF (TO_JSONB(NEW) - 'updatedAt') IS DISTINCT FROM (TO_JSONB(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'Used local-delivery identity configuration is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER local_delivery_location_identity_immutable
BEFORE UPDATE OR DELETE ON "LocalDeliveryLocationIdentity"
FOR EACH ROW EXECUTE FUNCTION protect_local_delivery_location_identity();

ALTER TABLE "WalkingDeliveryQuote"
  ADD COLUMN "normalizedAddressStructured" JSONB,
  ADD COLUMN "externalSelectedLocationId" VARCHAR(64),
  ADD COLUMN "selectedLocalDeliveryLocationId" UUID,
  ADD COLUMN "zoneSetVersionId" UUID,
  ADD COLUMN "externalZoneVersionId" VARCHAR(120),
  ADD COLUMN "externalFeePolicyVersionId" VARCHAR(120),
  ADD COLUMN "assignmentRule" "WalkingQuoteAssignmentRule",
  ADD COLUMN "distanceBasis" "WalkingDistanceBasis",
  ADD COLUMN "roundTripDistanceFeet" DECIMAL(12, 2),
  ADD COLUMN "estimatedRoundTripDurationSeconds" INTEGER,
  ADD COLUMN "preparationBufferSeconds" INTEGER DEFAULT 0,
  ADD COLUMN "handoffBufferSeconds" INTEGER DEFAULT 0,
  ADD COLUMN "capacityRequiredSeconds" INTEGER,
  ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "bookable" BOOLEAN,
  ADD COLUMN "routeCalculatedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "inventoryReadinessStatus" "WalkingInventoryReadinessStatus"
    NOT NULL DEFAULT 'NOT_EVALUATED',
  ADD COLUMN "inventoryReadyAt" TIMESTAMP(3),
  ADD CONSTRAINT "WalkingDeliveryQuote_local_delivery_location_fkey"
    FOREIGN KEY ("selectedLocalDeliveryLocationId") REFERENCES "LocalDeliveryLocationIdentity" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_zone_set_version_fkey"
    FOREIGN KEY ("zoneSetVersionId") REFERENCES "WalkingZoneSetVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "WalkingDeliveryQuote_external_zone_version_idx"
  ON "WalkingDeliveryQuote" ("externalZoneVersionId", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_external_fee_version_idx"
  ON "WalkingDeliveryQuote" ("externalFeePolicyVersionId", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_expiry_idx"
  ON "WalkingDeliveryQuote" ("expiresAt");

CREATE TABLE "WalkingDeliveryQuoteCandidateRoute" (
  "id" UUID NOT NULL,
  "quoteId" UUID NOT NULL,
  "localDeliveryLocationId" UUID NOT NULL,
  "operationalLocationId" UUID NOT NULL,
  "externalLocationId" VARCHAR(64) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "locationPriority" INTEGER,
  "walkingDistanceFeet" DECIMAL(12, 2) NOT NULL,
  "walkingDurationSeconds" INTEGER NOT NULL,
  "routingProvider" VARCHAR(80) NOT NULL,
  "routingProfile" VARCHAR(32) NOT NULL DEFAULT 'walking',
  "routeCalculatedAt" TIMESTAMP(3) NOT NULL,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingDeliveryQuoteCandidateRoute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingQuoteCandidateRoute_external_format"
    CHECK ("externalLocationId" ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  CONSTRAINT "WalkingQuoteCandidateRoute_sequence_positive" CHECK ("sequence" > 0),
  CONSTRAINT "WalkingQuoteCandidateRoute_priority_positive"
    CHECK ("locationPriority" IS NULL OR "locationPriority" > 0),
  CONSTRAINT "WalkingQuoteCandidateRoute_distance_nonnegative"
    CHECK ("walkingDistanceFeet" >= 0),
  CONSTRAINT "WalkingQuoteCandidateRoute_duration_nonnegative"
    CHECK ("walkingDurationSeconds" >= 0),
  CONSTRAINT "WalkingQuoteCandidateRoute_provider_nonempty"
    CHECK (BTRIM("routingProvider") <> ''),
  CONSTRAINT "WalkingQuoteCandidateRoute_profile_guard"
    CHECK ("routingProfile" = 'walking')
);

CREATE UNIQUE INDEX "WalkingQuoteCandidateRoute_quote_location_key"
  ON "WalkingDeliveryQuoteCandidateRoute" ("quoteId", "operationalLocationId");
CREATE UNIQUE INDEX "WalkingQuoteCandidateRoute_quote_sequence_key"
  ON "WalkingDeliveryQuoteCandidateRoute" ("quoteId", "sequence");
CREATE INDEX "WalkingQuoteCandidateRoute_quote_selected_idx"
  ON "WalkingDeliveryQuoteCandidateRoute" ("quoteId", "selected");

ALTER TABLE "WalkingDeliveryQuoteCandidateRoute"
  ADD CONSTRAINT "WalkingQuoteCandidateRoute_quote_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "WalkingDeliveryQuote" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteCandidateRoute_local_identity_fkey"
    FOREIGN KEY ("localDeliveryLocationId") REFERENCES "LocalDeliveryLocationIdentity" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteCandidateRoute_location_fkey"
    FOREIGN KEY ("operationalLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WalkingDeliveryQuoteInventoryLine" (
  "id" UUID NOT NULL,
  "quoteId" UUID NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "variantId" VARCHAR(160) NOT NULL,
  "productId" UUID,
  "quantity" INTEGER NOT NULL,
  "readinessStatus" "WalkingInventoryReadinessStatus" NOT NULL,
  "inventoryOwnerLocationId" UUID,
  "inventoryNodeId" UUID,
  "containerId" UUID,
  "storageLocationId" UUID,
  "inventoryReservationId" VARCHAR(160),
  "transferStatus" "InventoryTransferStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "earliestReadyAt" TIMESTAMP(3),
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingDeliveryQuoteInventoryLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingQuoteInventoryLine_number_positive" CHECK ("lineNumber" > 0),
  CONSTRAINT "WalkingQuoteInventoryLine_variant_nonempty" CHECK (BTRIM("variantId") <> ''),
  CONSTRAINT "WalkingQuoteInventoryLine_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "WalkingQuoteInventoryLine_snapshot_shape"
    CHECK ("snapshot" IS NULL OR JSONB_TYPEOF("snapshot") = 'object'),
  CONSTRAINT "WalkingQuoteInventoryLine_physical_pair"
    CHECK ("storageLocationId" IS NULL OR "inventoryNodeId" IS NOT NULL),
  CONSTRAINT "WalkingQuoteInventoryLine_transfer_consistent"
    CHECK (
      ("readinessStatus" = 'TRANSFER_REQUIRED' AND "transferStatus" <> 'NOT_REQUIRED') OR
      ("readinessStatus" <> 'TRANSFER_REQUIRED')
    )
);

CREATE UNIQUE INDEX "WalkingQuoteInventoryLine_quote_line_key"
  ON "WalkingDeliveryQuoteInventoryLine" ("quoteId", "lineNumber");
CREATE INDEX "WalkingQuoteInventoryLine_readiness_idx"
  ON "WalkingDeliveryQuoteInventoryLine" ("quoteId", "readinessStatus");
CREATE INDEX "WalkingQuoteInventoryLine_reservation_idx"
  ON "WalkingDeliveryQuoteInventoryLine" ("inventoryReservationId");

ALTER TABLE "WalkingDeliveryQuoteInventoryLine"
  ADD CONSTRAINT "WalkingQuoteInventoryLine_quote_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "WalkingDeliveryQuote" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteInventoryLine_product_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteInventoryLine_owner_location_fkey"
    FOREIGN KEY ("inventoryOwnerLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteInventoryLine_node_location_fkey"
    FOREIGN KEY ("inventoryNodeId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteInventoryLine_container_fkey"
    FOREIGN KEY ("containerId") REFERENCES "Container" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingQuoteInventoryLine_storage_location_fkey"
    FOREIGN KEY ("storageLocationId") REFERENCES "StorageLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WalkingCapacitySlot" (
  "id" UUID NOT NULL,
  "slotPolicyId" UUID NOT NULL,
  "operationalLocationId" UUID NOT NULL,
  "slotKey" VARCHAR(160) NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "capacitySeconds" INTEGER NOT NULL,
  "status" "WalkingCapacitySlotStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingCapacitySlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingCapacitySlot_key_nonempty" CHECK (BTRIM("slotKey") <> ''),
  CONSTRAINT "WalkingCapacitySlot_time_range" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "WalkingCapacitySlot_capacity_positive" CHECK ("capacitySeconds" > 0),
  CONSTRAINT "WalkingCapacitySlot_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "WalkingCapacitySlot_policy_key"
  ON "WalkingCapacitySlot" ("slotPolicyId", "slotKey");
CREATE INDEX "WalkingCapacitySlot_location_start_idx"
  ON "WalkingCapacitySlot" ("operationalLocationId", "startsAt", "status");

ALTER TABLE "WalkingCapacitySlot"
  ADD CONSTRAINT "WalkingCapacitySlot_policy_fkey"
    FOREIGN KEY ("slotPolicyId") REFERENCES "SlotPolicy" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingCapacitySlot_location_fkey"
    FOREIGN KEY ("operationalLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WalkingCapacityHold" (
  "id" UUID NOT NULL,
  "quoteId" UUID NOT NULL,
  "capacitySlotId" UUID NOT NULL,
  "clientId" VARCHAR(120) NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "requestHash" VARCHAR(80) NOT NULL,
  "correlationId" VARCHAR(120) NOT NULL,
  "status" "WalkingCapacityHoldStatus" NOT NULL DEFAULT 'HELD',
  "reservedCapacitySeconds" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedOrderId" VARCHAR(160),
  "confirmedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" "WalkingCapacityHoldReleaseReason",
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingCapacityHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingCapacityHold_client_nonempty" CHECK (BTRIM("clientId") <> ''),
  CONSTRAINT "WalkingCapacityHold_idempotency_nonempty" CHECK (BTRIM("idempotencyKey") <> ''),
  CONSTRAINT "WalkingCapacityHold_request_hash_format"
    CHECK ("requestHash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "WalkingCapacityHold_correlation_nonempty" CHECK (BTRIM("correlationId") <> ''),
  CONSTRAINT "WalkingCapacityHold_capacity_positive" CHECK ("reservedCapacitySeconds" > 0),
  CONSTRAINT "WalkingCapacityHold_version_positive" CHECK ("version" > 0),
  CONSTRAINT "WalkingCapacityHold_confirmed_shape"
    CHECK (
      ("confirmedOrderId" IS NULL) = ("confirmedAt" IS NULL) AND
      ("status" <> 'CONFIRMED' OR "confirmedOrderId" IS NOT NULL) AND
      ("status" <> 'HELD' OR "confirmedOrderId" IS NULL)
    ),
  CONSTRAINT "WalkingCapacityHold_released_shape"
    CHECK (
      ("status" IN ('RELEASED', 'EXPIRED') AND "releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL) OR
      ("status" NOT IN ('RELEASED', 'EXPIRED') AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
    )
);

CREATE UNIQUE INDEX "WalkingCapacityHold_client_idempotency_key"
  ON "WalkingCapacityHold" ("clientId", "idempotencyKey");
CREATE UNIQUE INDEX "WalkingCapacityHold_one_active_quote_idx"
  ON "WalkingCapacityHold" ("quoteId") WHERE "status" IN ('HELD', 'CONFIRMED');
CREATE INDEX "WalkingCapacityHold_slot_status_expiry_idx"
  ON "WalkingCapacityHold" ("capacitySlotId", "status", "expiresAt");
CREATE INDEX "WalkingCapacityHold_quote_status_idx"
  ON "WalkingCapacityHold" ("quoteId", "status");
CREATE INDEX "WalkingCapacityHold_expiry_status_idx"
  ON "WalkingCapacityHold" ("expiresAt", "status");

ALTER TABLE "WalkingCapacityHold"
  ADD CONSTRAINT "WalkingCapacityHold_quote_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "WalkingDeliveryQuote" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingCapacityHold_slot_fkey"
    FOREIGN KEY ("capacitySlotId") REFERENCES "WalkingCapacitySlot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WalkingInventoryReservation" (
  "id" UUID NOT NULL,
  "quoteId" UUID NOT NULL,
  "capacityHoldId" UUID NOT NULL,
  "clientId" VARCHAR(120) NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "requestHash" VARCHAR(80) NOT NULL,
  "correlationId" VARCHAR(120) NOT NULL,
  "status" "WalkingInventoryReservationStatus" NOT NULL DEFAULT 'HELD',
  "orderLocationId" UUID NOT NULL,
  "deliveryLocationId" UUID NOT NULL,
  "orderLocationExternalId" VARCHAR(64) NOT NULL,
  "deliveryLocationExternalId" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedOrderId" VARCHAR(160),
  "confirmedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" "WalkingInventoryReservationReleaseReason",
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingInventoryReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingInventoryReservation_client_nonempty" CHECK (BTRIM("clientId") <> ''),
  CONSTRAINT "WalkingInventoryReservation_idempotency_nonempty" CHECK (BTRIM("idempotencyKey") <> ''),
  CONSTRAINT "WalkingInventoryReservation_request_hash_format"
    CHECK ("requestHash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "WalkingInventoryReservation_correlation_nonempty"
    CHECK (BTRIM("correlationId") <> ''),
  CONSTRAINT "WalkingInventoryReservation_external_ids_nonempty"
    CHECK (
      BTRIM("orderLocationExternalId") <> '' AND
      BTRIM("deliveryLocationExternalId") <> ''
    ),
  CONSTRAINT "WalkingInventoryReservation_version_positive" CHECK ("version" > 0),
  CONSTRAINT "WalkingInventoryReservation_confirmed_shape"
    CHECK (
      ("confirmedOrderId" IS NULL) = ("confirmedAt" IS NULL) AND
      ("status" <> 'CONFIRMED' OR "confirmedOrderId" IS NOT NULL) AND
      ("status" <> 'HELD' OR "confirmedOrderId" IS NULL)
    ),
  CONSTRAINT "WalkingInventoryReservation_released_shape"
    CHECK (
      ("status" IN ('RELEASED', 'EXPIRED') AND "releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL) OR
      ("status" NOT IN ('RELEASED', 'EXPIRED') AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
    )
);

CREATE UNIQUE INDEX "WalkingInventoryReservation_client_idempotency_key"
  ON "WalkingInventoryReservation" ("clientId", "idempotencyKey");
CREATE UNIQUE INDEX "WalkingInventoryReservation_one_active_quote_idx"
  ON "WalkingInventoryReservation" ("quoteId") WHERE "status" IN ('HELD', 'CONFIRMED');
CREATE INDEX "WalkingInventoryReservation_quote_status_idx"
  ON "WalkingInventoryReservation" ("quoteId", "status");
CREATE UNIQUE INDEX "WalkingInventoryReservation_capacity_hold_key"
  ON "WalkingInventoryReservation" ("capacityHoldId");
CREATE INDEX "WalkingInventoryReservation_expiry_status_idx"
  ON "WalkingInventoryReservation" ("expiresAt", "status");

ALTER TABLE "WalkingInventoryReservation"
  ADD CONSTRAINT "WalkingInventoryReservation_quote_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "WalkingDeliveryQuote" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservation_capacity_hold_fkey"
    FOREIGN KEY ("capacityHoldId") REFERENCES "WalkingCapacityHold" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservation_order_location_fkey"
    FOREIGN KEY ("orderLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservation_delivery_location_fkey"
    FOREIGN KEY ("deliveryLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InventoryNodeBalance" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "inventoryLotId" UUID NOT NULL,
  "inventoryOwnerLocationId" UUID NOT NULL,
  "inventoryNodeId" UUID NOT NULL,
  "containerId" UUID,
  "storageLocationId" UUID,
  "onHand" DECIMAL(18, 3) NOT NULL,
  "available" DECIMAL(18, 3) NOT NULL,
  "reserved" DECIMAL(18, 3) NOT NULL,
  "damaged" DECIMAL(18, 3) NOT NULL,
  "ledgerSequence" BIGINT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InventoryNodeBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryNodeBalance_physical_locator"
    CHECK ("containerId" IS NOT NULL OR "storageLocationId" IS NOT NULL),
  CONSTRAINT "InventoryNodeBalance_quantities_nonnegative"
    CHECK (
      "onHand" >= 0 AND "available" >= 0 AND "reserved" >= 0 AND "damaged" >= 0
    ),
  CONSTRAINT "InventoryNodeBalance_quantities_partition"
    CHECK ("onHand" = "available" + "reserved" + "damaged"),
  CONSTRAINT "InventoryNodeBalance_ledger_nonnegative" CHECK ("ledgerSequence" >= 0),
  CONSTRAINT "InventoryNodeBalance_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "InventoryNodeBalance_container_lot_key"
  ON "InventoryNodeBalance" ("containerId", "inventoryLotId")
  WHERE "containerId" IS NOT NULL;
CREATE UNIQUE INDEX "InventoryNodeBalance_storage_lot_key"
  ON "InventoryNodeBalance" ("storageLocationId", "inventoryLotId")
  WHERE "containerId" IS NULL AND "storageLocationId" IS NOT NULL;
CREATE INDEX "InventoryNodeBalance_node_product_available_idx"
  ON "InventoryNodeBalance" ("inventoryNodeId", "productId", "available");
CREATE INDEX "InventoryNodeBalance_owner_product_idx"
  ON "InventoryNodeBalance" ("inventoryOwnerLocationId", "productId");

ALTER TABLE "InventoryNodeBalance"
  ADD CONSTRAINT "InventoryNodeBalance_product_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryNodeBalance_lot_fkey"
    FOREIGN KEY ("inventoryLotId") REFERENCES "InventoryLot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryNodeBalance_owner_location_fkey"
    FOREIGN KEY ("inventoryOwnerLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryNodeBalance_node_location_fkey"
    FOREIGN KEY ("inventoryNodeId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryNodeBalance_container_fkey"
    FOREIGN KEY ("containerId") REFERENCES "Container" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryNodeBalance_storage_location_fkey"
    FOREIGN KEY ("storageLocationId") REFERENCES "StorageLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WalkingInventoryReservationLine" (
  "id" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "inventoryNodeBalanceId" UUID NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "variantId" VARCHAR(160) NOT NULL,
  "productId" UUID NOT NULL,
  "inventoryLotId" UUID NOT NULL,
  "quantity" DECIMAL(18, 3) NOT NULL,
  "inventoryOwnerLocationId" UUID NOT NULL,
  "inventoryNodeId" UUID NOT NULL,
  "containerId" UUID,
  "storageLocationId" UUID,
  "warehouseBoxId" VARCHAR(64),
  "binId" VARCHAR(64),
  "transferStatus" "InventoryTransferStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingInventoryReservationLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingInventoryReservationLine_number_positive" CHECK ("lineNumber" > 0),
  CONSTRAINT "WalkingInventoryReservationLine_variant_nonempty" CHECK (BTRIM("variantId") <> ''),
  CONSTRAINT "WalkingInventoryReservationLine_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "WalkingInventoryReservationLine_physical_evidence"
    CHECK (
      ("containerId" IS NULL) = ("warehouseBoxId" IS NULL) AND
      ("storageLocationId" IS NULL) = ("binId" IS NULL) AND
      ("containerId" IS NOT NULL OR "storageLocationId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "WalkingInventoryReservationLine_reservation_line_key"
  ON "WalkingInventoryReservationLine" ("reservationId", "lineNumber");
CREATE INDEX "WalkingInventoryReservationLine_balance_idx"
  ON "WalkingInventoryReservationLine" ("inventoryNodeBalanceId");
CREATE INDEX "WalkingInventoryReservationLine_container_lot_idx"
  ON "WalkingInventoryReservationLine" ("containerId", "inventoryLotId");
CREATE INDEX "WalkingInventoryReservationLine_node_product_idx"
  ON "WalkingInventoryReservationLine" ("inventoryNodeId", "productId");

ALTER TABLE "WalkingInventoryReservationLine"
  ADD CONSTRAINT "WalkingInventoryReservationLine_reservation_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "WalkingInventoryReservation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_balance_fkey"
    FOREIGN KEY ("inventoryNodeBalanceId") REFERENCES "InventoryNodeBalance" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_product_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_lot_fkey"
    FOREIGN KEY ("inventoryLotId") REFERENCES "InventoryLot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_owner_location_fkey"
    FOREIGN KEY ("inventoryOwnerLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_node_location_fkey"
    FOREIGN KEY ("inventoryNodeId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_container_fkey"
    FOREIGN KEY ("containerId") REFERENCES "Container" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingInventoryReservationLine_storage_location_fkey"
    FOREIGN KEY ("storageLocationId") REFERENCES "StorageLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

-- The legacy v1 matrix ends in manager review; v4 is intentionally fully
-- automatic and open-ended. Both are valid contiguous partitions.
CREATE OR REPLACE FUNCTION validate_fee_calculation_tier_partition() RETURNS trigger AS $$
DECLARE
  version_id UUID;
  tier_count INTEGER;
  violation_count INTEGER;
BEGIN
  version_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD."feePolicyVersionId" ELSE NEW."feePolicyVersionId" END;

  WITH ordered AS (
    SELECT
      "sequence",
      "lowerExclusiveFeet",
      "upperInclusiveFeet",
      "automatic",
      "reasonCode",
      ROW_NUMBER() OVER (ORDER BY "sequence") AS position,
      COUNT(*) OVER () AS total,
      LAG("upperInclusiveFeet") OVER (ORDER BY "sequence") AS previous_upper
    FROM "FeeCalculationTier"
    WHERE "feePolicyVersionId" = version_id
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE "sequence" <> position
         OR (position = 1 AND "lowerExclusiveFeet" IS NOT NULL)
         OR (position > 1 AND "lowerExclusiveFeet" IS DISTINCT FROM previous_upper)
         OR (position < total AND "upperInclusiveFeet" IS NULL)
         OR (position = total AND "upperInclusiveFeet" IS NOT NULL)
         OR (position < total AND "automatic" = false)
         OR (
           position = total AND NOT (
             ("automatic" = true AND "reasonCode" = 'ELIGIBLE') OR
             ("automatic" = false AND "reasonCode" = 'MANAGER_REVIEW')
           )
         )
    )
  INTO tier_count, violation_count
  FROM ordered;

  IF tier_count = 0 OR violation_count > 0 THEN
    RAISE EXCEPTION
      'Fee-calculation tiers must be contiguous and end in one open resolution tier';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Validation remains exact per immutable policy identity. The v1 branch
-- preserves its historical four-tier contract; the v4 branch validates the
-- ten approved automatic tiers and the exact external IDs.
CREATE OR REPLACE FUNCTION validate_fee_calculation_version_state() RETURNS trigger AS $$
DECLARE
  tier_count INTEGER;
  open_tier_count INTEGER;
  mismatch_count INTEGER;
  parent_policy_code VARCHAR(80);
  parent_external_policy_id VARCHAR(120);
  canonical_snapshot JSONB;
  expected_digest TEXT;
BEGIN
  IF NEW."status" = 'ARCHIVED' THEN
    IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'A fee-calculation version can archive only from PUBLISHED';
    END IF;
  END IF;

  IF NEW."status" NOT IN ('VALIDATED', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE "upperInclusiveFeet" IS NULL)
  INTO tier_count, open_tier_count
  FROM "FeeCalculationTier"
  WHERE "feePolicyVersionId" = NEW."id";

  IF tier_count = 0 OR open_tier_count <> 1 THEN
    RAISE EXCEPTION 'Validated fee-calculation versions require one complete open tier partition';
  END IF;

  SELECT p."code", p."externalPolicyId"
  INTO parent_policy_code, parent_external_policy_id
  FROM "FeeCalculationPolicy" p
  WHERE p."id" = NEW."feeCalculationPolicyId";

  IF parent_policy_code = 'WALKING_ROUTE_DISTANCE_STANDARD' THEN
    SELECT COUNT(*) INTO mismatch_count
    FROM "FeeCalculationTier" t
    WHERE t."feePolicyVersionId" = NEW."id"
      AND NOT (
        (t."sequence" = 1 AND t."tierKey" = 'UP_TO_1200_FT' AND
          t."lowerExclusiveFeet" IS NULL AND t."upperInclusiveFeet" = 1200.00 AND
          t."feeCents" = 0 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE') OR
        (t."sequence" = 2 AND t."tierKey" = 'UP_TO_2300_FT' AND
          t."lowerExclusiveFeet" = 1200.00 AND t."upperInclusiveFeet" = 2300.00 AND
          t."feeCents" = 1000 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE') OR
        (t."sequence" = 3 AND t."tierKey" = 'UP_TO_3250_FT' AND
          t."lowerExclusiveFeet" = 2300.00 AND t."upperInclusiveFeet" = 3250.00 AND
          t."feeCents" = 1500 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE') OR
        (t."sequence" = 4 AND t."tierKey" = 'OVER_3250_FT_MANAGER_REVIEW' AND
          t."lowerExclusiveFeet" = 3250.00 AND t."upperInclusiveFeet" IS NULL AND
          t."feeCents" IS NULL AND t."automatic" = false AND t."reasonCode" = 'MANAGER_REVIEW')
      );

    IF tier_count <> 4 OR mismatch_count <> 0 THEN
      RAISE EXCEPTION 'WALKING_ROUTE_DISTANCE_STANDARD tiers do not match its immutable matrix';
    END IF;

    SELECT JSONB_BUILD_OBJECT(
      'schemaVersion', 'orderpro.walking-route-distance-fee.v1',
      'policyId', NEW."feeCalculationPolicyId",
      'policyCode', parent_policy_code,
      'versionId', NEW."id",
      'versionKey', NEW."versionKey",
      'versionNumber', NEW."versionNumber",
      'revision', NEW."revision",
      'environment', NEW."environment",
      'strategy', NEW."strategy",
      'currency', NEW."currency",
      'routingProfile', NEW."routingProfile",
      'tiers', COALESCE((
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'id', t."id", 'tierKey', t."tierKey", 'sequence', t."sequence",
          'lowerExclusiveFeet', t."lowerExclusiveFeet",
          'upperInclusiveFeet', t."upperInclusiveFeet",
          'feeCents', t."feeCents", 'automatic', t."automatic",
          'reasonCode', t."reasonCode"
        ) ORDER BY t."sequence")
        FROM "FeeCalculationTier" t WHERE t."feePolicyVersionId" = NEW."id"
      ), '[]'::JSONB)
    ) INTO canonical_snapshot;
  ELSIF parent_policy_code = 'WALKING_ROUTE_DISTANCE_V4_BASE_10' THEN
    IF parent_external_policy_id IS DISTINCT FROM 'walking-route-distance-v4-base-10' OR
       NEW."externalVersionId" IS DISTINCT FROM 'walking-route-distance-v4-base-10-2026-07-16' OR
       NEW."versionKey" IS DISTINCT FROM 'walking-route-distance-v4-base-10-2026-07-16' OR
       NEW."currency" IS DISTINCT FROM 'USD' OR
       NEW."routingProfile" IS DISTINCT FROM 'walking' OR
       NEW."distanceBasis" IS DISTINCT FROM 'ONE_WAY_FROM_SELECTED_STORE' OR
       NEW."quoteTtlSeconds" IS NULL OR NEW."holdTtlSeconds" IS NULL OR
       NEW."preparationBufferSeconds" IS NULL OR NEW."handoffBufferSeconds" IS NULL THEN
      RAISE EXCEPTION 'Walking fee v4 external identity or route basis is invalid';
    END IF;

    SELECT COUNT(*) INTO mismatch_count
    FROM "FeeCalculationTier" t
    WHERE t."feePolicyVersionId" = NEW."id"
      AND NOT (
        (t."sequence" = 1 AND t."tierKey" = 'free-local' AND t."lowerExclusiveFeet" IS NULL AND t."upperInclusiveFeet" = 1200.00 AND t."feeCents" = 0) OR
        (t."sequence" = 2 AND t."tierKey" = 'base-delivery' AND t."lowerExclusiveFeet" = 1200.00 AND t."upperInclusiveFeet" = 2200.00 AND t."feeCents" = 1000) OR
        (t."sequence" = 3 AND t."tierKey" = 'extended-12' AND t."lowerExclusiveFeet" = 2200.00 AND t."upperInclusiveFeet" = 2700.00 AND t."feeCents" = 1200) OR
        (t."sequence" = 4 AND t."tierKey" = 'extended-14' AND t."lowerExclusiveFeet" = 2700.00 AND t."upperInclusiveFeet" = 2950.00 AND t."feeCents" = 1400) OR
        (t."sequence" = 5 AND t."tierKey" = 'extended-15' AND t."lowerExclusiveFeet" = 2950.00 AND t."upperInclusiveFeet" = 3250.00 AND t."feeCents" = 1500) OR
        (t."sequence" = 6 AND t."tierKey" = 'extended-17' AND t."lowerExclusiveFeet" = 3250.00 AND t."upperInclusiveFeet" = 3500.00 AND t."feeCents" = 1700) OR
        (t."sequence" = 7 AND t."tierKey" = 'extended-19' AND t."lowerExclusiveFeet" = 3500.00 AND t."upperInclusiveFeet" = 3750.00 AND t."feeCents" = 1900) OR
        (t."sequence" = 8 AND t."tierKey" = 'extended-21' AND t."lowerExclusiveFeet" = 3750.00 AND t."upperInclusiveFeet" = 4000.00 AND t."feeCents" = 2100) OR
        (t."sequence" = 9 AND t."tierKey" = 'extended-23' AND t."lowerExclusiveFeet" = 4000.00 AND t."upperInclusiveFeet" = 4250.00 AND t."feeCents" = 2300) OR
        (t."sequence" = 10 AND t."tierKey" = 'whole-zone-25' AND t."lowerExclusiveFeet" = 4250.00 AND t."upperInclusiveFeet" IS NULL AND t."feeCents" = 2500)
      )
      OR t."automatic" IS DISTINCT FROM true
      OR t."reasonCode" IS DISTINCT FROM 'ELIGIBLE';

    IF tier_count <> 10 OR mismatch_count <> 0 THEN
      RAISE EXCEPTION 'Walking fee v4 tiers do not match the approved matrix';
    END IF;

    SELECT JSONB_BUILD_OBJECT(
      'schemaVersion', 'orderpro.walking-route-distance-fee.v2',
      'policyId', parent_external_policy_id,
      'internalPolicyId', NEW."feeCalculationPolicyId",
      'versionId', NEW."externalVersionId",
      'internalVersionId', NEW."id",
      'versionNumber', NEW."versionNumber",
      'revision', NEW."revision",
      'environment', NEW."environment",
      'strategy', NEW."strategy",
      'distanceBasis', NEW."distanceBasis",
      'quoteTtlSeconds', NEW."quoteTtlSeconds",
      'holdTtlSeconds', NEW."holdTtlSeconds",
      'preparationBufferSeconds', NEW."preparationBufferSeconds",
      'handoffBufferSeconds', NEW."handoffBufferSeconds",
      'currency', NEW."currency",
      'routingProfile', NEW."routingProfile",
      'tiers', COALESCE((
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'id', t."tierKey", 'sequence', t."sequence",
          'lowerExclusiveFeet', t."lowerExclusiveFeet",
          'upperInclusiveFeet', t."upperInclusiveFeet",
          'feeCents', t."feeCents", 'automatic', t."automatic",
          'reasonCode', t."reasonCode"
        ) ORDER BY t."sequence")
        FROM "FeeCalculationTier" t WHERE t."feePolicyVersionId" = NEW."id"
      ), '[]'::JSONB)
    ) INTO canonical_snapshot;
  ELSE
    RAISE EXCEPTION 'Validated walking fee policy identity is not supported';
  END IF;

  IF NEW."snapshot" IS DISTINCT FROM canonical_snapshot THEN
    RAISE EXCEPTION 'Fee-calculation snapshot does not match its exact version and tiers';
  END IF;

  expected_digest := 'sha256:' || ENCODE(
    SHA256(CONVERT_TO(canonical_fee_policy_json(NEW."snapshot"), 'UTF8')),
    'hex'
  );
  IF NEW."digest" IS DISTINCT FROM expected_digest THEN
    RAISE EXCEPTION 'Fee-calculation digest does not match its canonical snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_v4_external_policy_identity() RETURNS trigger AS $$
BEGIN
  IF NEW."externalPolicyId" IS DISTINCT FROM OLD."externalPolicyId" THEN
    RAISE EXCEPTION 'External fee-policy identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_policy_external_id_immutable
BEFORE UPDATE OF "externalPolicyId" ON "FeeCalculationPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_v4_external_policy_identity();

CREATE FUNCTION protect_v4_external_version_identity() RETURNS trigger AS $$
BEGIN
  IF NEW."externalVersionId" IS DISTINCT FROM OLD."externalVersionId" OR
     NEW."distanceBasis" IS DISTINCT FROM OLD."distanceBasis" OR
     NEW."quoteTtlSeconds" IS DISTINCT FROM OLD."quoteTtlSeconds" OR
     NEW."holdTtlSeconds" IS DISTINCT FROM OLD."holdTtlSeconds" OR
     NEW."preparationBufferSeconds" IS DISTINCT FROM OLD."preparationBufferSeconds" OR
     NEW."handoffBufferSeconds" IS DISTINCT FROM OLD."handoffBufferSeconds" THEN
    IF OLD."status" IN ('VALIDATED', 'PUBLISHED', 'ARCHIVED') OR EXISTS (
      SELECT 1 FROM "WalkingDeliveryQuote" q
      WHERE q."feePolicyVersionId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'Used or validated external fee-version identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_version_external_id_immutable
BEFORE UPDATE OF "externalVersionId", "distanceBasis", "quoteTtlSeconds", "holdTtlSeconds", "preparationBufferSeconds", "handoffBufferSeconds" ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION protect_v4_external_version_identity();

CREATE FUNCTION require_v4_fee_publish_flag() RETURNS trigger AS $$
DECLARE
  external_policy_id VARCHAR(120);
  publish_enabled BOOLEAN;
BEGIN
  IF NEW."status" <> 'PUBLISHED' OR
     (TG_OP = 'UPDATE' AND OLD."status" = 'PUBLISHED') THEN
    RETURN NEW;
  END IF;
  SELECT p."externalPolicyId" INTO external_policy_id
  FROM "FeeCalculationPolicy" p WHERE p."id" = NEW."feeCalculationPolicyId";
  IF external_policy_id = 'walking-route-distance-v4-base-10' THEN
    SELECT "enabled" INTO publish_enabled FROM "FeatureFlag"
    WHERE "key" = 'local_delivery_v4.publish';
    IF publish_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Local Walking Delivery v4 fee publication is disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fee_calculation_version_v4_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION require_v4_fee_publish_flag();

CREATE FUNCTION validate_walking_zone_set_version_state() RETURNS trigger AS $$
DECLARE
  member_count INTEGER;
  postal_count INTEGER;
  invalid_count INTEGER;
  identity_count INTEGER;
  priority_count INTEGER;
  publish_enabled BOOLEAN;
  v4_publish_enabled BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND
     NEW."externalVersionId" IS DISTINCT FROM OLD."externalVersionId" THEN
    RAISE EXCEPTION 'External walking-zone set identity is immutable';
  END IF;

  IF NEW."status" = 'ARCHIVED' AND
     (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'PUBLISHED') THEN
    RAISE EXCEPTION 'A walking-zone set can archive only from PUBLISHED';
  END IF;

  IF NEW."status" NOT IN ('VALIDATED', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT postal_code),
    COUNT(*) FILTER (
      WHERE v."geometry" IS NULL
         OR CARDINALITY(v."activeDays") = 0
         OR v."status" NOT IN ('VALIDATED', 'PUBLISHED')
    )
  INTO member_count, postal_count, invalid_count
  FROM "WalkingZoneVersion" v
  CROSS JOIN LATERAL UNNEST(v."postalCodes") postal_code
  WHERE v."zoneSetVersionId" = NEW."id";

  IF member_count <> 5 OR postal_count <> 5 OR invalid_count <> 0 OR EXISTS (
    SELECT 1
    FROM (VALUES ('10021'), ('10028'), ('10065'), ('10075'), ('10128')) expected(postal_code)
    WHERE NOT EXISTS (
      SELECT 1 FROM "WalkingZoneVersion" v
      WHERE v."zoneSetVersionId" = NEW."id"
        AND v."postalCodes" = ARRAY[expected.postal_code]::TEXT[]
    )
  ) THEN
    RAISE EXCEPTION 'Walking-zone set requires the five complete exact postal polygons';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT "locationPriority")
  INTO identity_count, priority_count
  FROM "LocalDeliveryLocationIdentity"
  WHERE "externalLocationId" IN ('third_avenue', 'east_86th_street')
    AND "active" = true AND "locationPriority" IS NOT NULL;
  IF identity_count <> 2 OR priority_count <> 2 THEN
    RAISE EXCEPTION 'Walking-zone set requires two distinct auditable location priorities';
  END IF;

  IF NEW."status" = 'PUBLISHED' THEN
    SELECT "enabled" INTO publish_enabled FROM "FeatureFlag"
    WHERE "key" = 'walking_delivery.publish';
    SELECT "enabled" INTO v4_publish_enabled FROM "FeatureFlag"
    WHERE "key" = 'local_delivery_v4.publish';
    IF publish_enabled IS DISTINCT FROM true OR v4_publish_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Walking-zone v4 publication is disabled by feature flags';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_zone_set_version_state_check
BEFORE INSERT OR UPDATE ON "WalkingZoneSetVersion"
FOR EACH ROW EXECUTE FUNCTION validate_walking_zone_set_version_state();

CREATE FUNCTION protect_walking_zone_set_version() RETURNS trigger AS $$
DECLARE
  old_payload JSONB;
  new_payload JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Walking-zone set versions are never deleted';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Archived walking-zone set versions are immutable';
  END IF;
  IF OLD."status" IN ('VALIDATED', 'PUBLISHED') THEN
    old_payload := TO_JSONB(OLD) - ARRAY['status', 'effectiveTo', 'publishedById', 'publishedAt', 'updatedAt'];
    new_payload := TO_JSONB(NEW) - ARRAY['status', 'effectiveTo', 'publishedById', 'publishedAt', 'updatedAt'];
    IF old_payload IS DISTINCT FROM new_payload THEN
      RAISE EXCEPTION 'Validated walking-zone set content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_zone_set_version_immutable
BEFORE UPDATE OR DELETE ON "WalkingZoneSetVersion"
FOR EACH ROW EXECUTE FUNCTION protect_walking_zone_set_version();

ALTER TABLE "WalkingDeliveryQuote"
  DROP CONSTRAINT "WalkingDeliveryQuote_location_id_format",
  ADD CONSTRAINT "WalkingDeliveryQuote_location_id_format"
    CHECK (
      "selectedLocationId" IS NULL OR
      "selectedLocationId" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_external_location_id_format"
    CHECK (
      "externalSelectedLocationId" IS NULL OR
      "externalSelectedLocationId" ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_fee_outcome_guard"
    CHECK (
      "reasonCode" IN (
        'ELIGIBLE', 'NO_AVAILABLE_SLOTS', 'NO_SLOTS_FOR_SELECTED_LOCATION',
        'INVENTORY_NOT_READY', 'TRANSFER_REQUIRED'
      ) OR "feeCents" IS NULL
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_nonpricing_outcome_guard"
    CHECK (
      "reasonCode" IN (
        'ELIGIBLE', 'NO_AVAILABLE_SLOTS', 'NO_SLOTS_FOR_SELECTED_LOCATION',
        'INVENTORY_NOT_READY', 'TRANSFER_REQUIRED', 'MANAGER_REVIEW'
      ) OR (
        "tierId" IS NULL AND "tierSnapshot" IS NULL AND "feeCents" IS NULL AND
        "slotPolicyId" IS NULL AND "slotSnapshot" IS NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_preroute_outcome_guard"
    CHECK (
      "reasonCode" NOT IN (
        'INVALID_INPUT', 'INVALID_ADDRESS', 'GEOCODING_FAILED', 'AMBIGUOUS_ADDRESS',
        'ADDRESS_NOT_IN_MANHATTAN', 'OUTSIDE_WALKING_ZONE', 'OUTSIDE_WALKING_AREA',
        'NO_ACTIVE_ZONE', 'SERVICE_DAY_UNAVAILABLE', 'INVALID_ZONE_CONFIGURATION',
        'ROUTE_METRICS_REQUIRED', 'DISTANCE_UNAVAILABLE',
        'ROUTING_PROVIDER_UNAVAILABLE', 'POLICY_VERSION_UNAVAILABLE', 'CONTACT_STORE'
      ) OR (
        "routingProvider" IS NULL AND "distanceFeet" IS NULL AND
        "durationSeconds" IS NULL AND "roundTripDistanceFeet" IS NULL AND
        "estimatedRoundTripDurationSeconds" IS NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_preselection_outcome_guard"
    CHECK (
      "reasonCode" NOT IN (
        'INVALID_INPUT', 'INVALID_ADDRESS', 'GEOCODING_FAILED', 'AMBIGUOUS_ADDRESS',
        'ADDRESS_NOT_IN_MANHATTAN', 'OUTSIDE_WALKING_ZONE', 'OUTSIDE_WALKING_AREA',
        'NO_ACTIVE_ZONE', 'SERVICE_DAY_UNAVAILABLE', 'INVALID_ZONE_CONFIGURATION',
        'CONTACT_STORE'
      ) OR (
        "selectedLocationId" IS NULL AND
        "externalSelectedLocationId" IS NULL AND
        "selectedOperationalLocationId" IS NULL AND
        "selectedLocalDeliveryLocationId" IS NULL AND
        "zoneVersionId" IS NULL AND "zoneSetVersionId" IS NULL AND
        "walkingPublicationId" IS NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_eligible_complete"
    CHECK (
      "reasonCode" <> 'ELIGIBLE' OR (
        "normalizedAddress" IS NOT NULL AND "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND "selectedLocationId" IS NOT NULL AND
        "selectedOperationalLocationId" IS NOT NULL AND "zoneVersionId" IS NOT NULL AND
        "feePolicyVersionId" IS NOT NULL AND "routingProvider" IS NOT NULL AND
        "distanceFeet" IS NOT NULL AND "durationSeconds" IS NOT NULL AND
        "feeCents" IS NOT NULL AND "tierId" IS NOT NULL AND
        "slotPolicyId" IS NOT NULL AND "slotSnapshot" IS NOT NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_no_slots_complete"
    CHECK (
      "reasonCode" <> 'NO_AVAILABLE_SLOTS' OR (
        "normalizedAddress" IS NOT NULL AND "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND "selectedLocationId" IS NOT NULL AND
        "zoneVersionId" IS NOT NULL AND "feePolicyVersionId" IS NOT NULL AND
        "routingProvider" IS NOT NULL AND "distanceFeet" IS NOT NULL AND
        "durationSeconds" IS NOT NULL AND "feeCents" IS NOT NULL AND
        "tierId" IS NOT NULL AND "slotPolicyId" IS NOT NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_manager_review_complete"
    CHECK (
      "reasonCode" <> 'MANAGER_REVIEW' OR (
        "normalizedAddress" IS NOT NULL AND "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND "selectedLocationId" IS NOT NULL AND
        "zoneVersionId" IS NOT NULL AND "feePolicyVersionId" IS NOT NULL AND
        "routingProvider" IS NOT NULL AND "distanceFeet" IS NOT NULL AND
        "durationSeconds" IS NOT NULL AND "feeCents" IS NULL AND
        "tierId" IS NOT NULL AND "slotPolicyId" IS NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_structured_address_shape"
    CHECK (
      "normalizedAddressStructured" IS NULL OR
      CASE WHEN JSONB_TYPEOF("normalizedAddressStructured") = 'object' THEN
        JSONB_TYPEOF("normalizedAddressStructured" -> 'line1') = 'string' AND
        (
          NOT ("normalizedAddressStructured" ? 'line2') OR
          JSONB_TYPEOF("normalizedAddressStructured" -> 'line2') IN ('string', 'null')
        ) AND
        JSONB_TYPEOF("normalizedAddressStructured" -> 'city') = 'string' AND
        JSONB_TYPEOF("normalizedAddressStructured" -> 'borough') = 'string' AND
        JSONB_TYPEOF("normalizedAddressStructured" -> 'state') = 'string' AND
        JSONB_TYPEOF("normalizedAddressStructured" -> 'postalCode') = 'string' AND
        JSONB_TYPEOF("normalizedAddressStructured" -> 'country') = 'string' AND
        BTRIM("normalizedAddressStructured" ->> 'line1') <> '' AND
        BTRIM("normalizedAddressStructured" ->> 'city') <> '' AND
        ("normalizedAddressStructured" ->> 'borough') = 'Manhattan' AND
        ("normalizedAddressStructured" ->> 'state') = 'NY' AND
        ("normalizedAddressStructured" ->> 'postalCode') ~ '^[0-9]{5}$' AND
        ("postalCode" IS NULL OR
          ("normalizedAddressStructured" ->> 'postalCode') = "postalCode") AND
        ("normalizedAddressStructured" ->> 'country') = 'US'
      ELSE false END
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_external_versions_pair"
    CHECK (
      ("zoneSetVersionId" IS NULL) = ("externalZoneVersionId" IS NULL) AND
      ("externalFeePolicyVersionId" IS NULL OR "feePolicyVersionId" IS NOT NULL)
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_round_trip_consistent"
    CHECK (
      ("roundTripDistanceFeet" IS NULL AND "estimatedRoundTripDurationSeconds" IS NULL) OR
      (
        "distanceFeet" IS NOT NULL AND "durationSeconds" IS NOT NULL AND
        "distanceBasis" = 'ONE_WAY_FROM_SELECTED_STORE' AND
        "roundTripDistanceFeet" = "distanceFeet" * 2 AND
        "estimatedRoundTripDurationSeconds" = "durationSeconds" * 2
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_capacity_time_consistent"
    CHECK (
      ("preparationBufferSeconds" IS NULL OR "preparationBufferSeconds" >= 0) AND
      ("handoffBufferSeconds" IS NULL OR "handoffBufferSeconds" >= 0) AND
      ("capacityRequiredSeconds" IS NULL OR (
        "estimatedRoundTripDurationSeconds" IS NOT NULL AND
        "capacityRequiredSeconds" = "estimatedRoundTripDurationSeconds" +
          COALESCE("preparationBufferSeconds", 0) + COALESCE("handoffBufferSeconds", 0)
      ))
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_currency_guard"
    CHECK ("currency" IS NULL OR "currency" = 'USD'),
  ADD CONSTRAINT "WalkingDeliveryQuote_bookable_outcome_guard"
    CHECK (
      ("reasonCode" = 'ELIGIBLE' AND ("schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR "bookable" = true)) OR
      ("reasonCode" = 'TRANSFER_REQUIRED' AND "bookable" = true AND "slotSnapshot" IS NOT NULL) OR
      ("reasonCode" IN ('NO_SLOTS_FOR_SELECTED_LOCATION', 'CONTACT_STORE', 'INVENTORY_NOT_READY') AND "bookable" = false) OR
      ("reasonCode" NOT IN ('ELIGIBLE', 'TRANSFER_REQUIRED', 'NO_SLOTS_FOR_SELECTED_LOCATION', 'CONTACT_STORE', 'INVENTORY_NOT_READY') AND "bookable" IS NULL)
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_expiry_guard"
    CHECK (
      ("expiresAt" IS NULL OR "expiresAt" > "calculatedAt") AND
      ("routeCalculatedAt" IS NULL OR "routeCalculatedAt" <= "calculatedAt")
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_contact_store_guard"
    CHECK (
      "reasonCode" <> 'CONTACT_STORE' OR (
        "normalizedAddressStructured" IS NOT NULL AND
        "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND
        "postalCode" <> ALL(ARRAY['10021','10028','10065','10075','10128']) AND
        "selectedLocationId" IS NULL AND
        "selectedOperationalLocationId" IS NULL AND
        "selectedLocalDeliveryLocationId" IS NULL AND
        "zoneVersionId" IS NULL AND "zoneSetVersionId" IS NULL AND
        "feePolicyVersionId" IS NULL AND "tierId" IS NULL AND
        "distanceFeet" IS NULL AND "durationSeconds" IS NULL AND
        "feeCents" IS NULL AND "slotPolicyId" IS NULL AND "slotSnapshot" IS NULL AND
        "bookable" = false AND "expiresAt" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_v4_no_slots_guard"
    CHECK (
      "reasonCode" <> 'NO_SLOTS_FOR_SELECTED_LOCATION' OR (
        "selectedLocalDeliveryLocationId" IS NOT NULL AND
        "assignmentRule" IS NOT NULL AND
        "distanceFeet" IS NOT NULL AND "feeCents" IS NOT NULL AND
        "tierId" IS NOT NULL AND "slotPolicyId" IS NOT NULL AND
        "slotSnapshot" IS NOT NULL AND "bookable" = false
      )
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_inventory_outcome_guard"
    CHECK (
      ("reasonCode" <> 'TRANSFER_REQUIRED' OR
        ("inventoryReadinessStatus" = 'TRANSFER_REQUIRED' AND
         "inventoryReadyAt" IS NOT NULL AND "slotSnapshot" IS NOT NULL AND "bookable" = true)) AND
      ("reasonCode" <> 'INVENTORY_NOT_READY' OR
        ("inventoryReadinessStatus" IN ('NOT_READY', 'UNAVAILABLE') AND "slotSnapshot" IS NULL))
    ),
  ADD CONSTRAINT "WalkingDeliveryQuote_v4_resolved_complete"
    CHECK (
      "externalFeePolicyVersionId" IS NULL OR (
        "schemaVersion" = 'orderpro.walking-delivery-quote.v2' AND
        "normalizedAddressStructured" IS NOT NULL AND
        "externalSelectedLocationId" IS NOT NULL AND
        "selectedLocalDeliveryLocationId" IS NOT NULL AND
        "zoneSetVersionId" IS NOT NULL AND "externalZoneVersionId" IS NOT NULL AND
        "assignmentRule" IS NOT NULL AND "distanceBasis" = 'ONE_WAY_FROM_SELECTED_STORE' AND
        "roundTripDistanceFeet" IS NOT NULL AND
        "estimatedRoundTripDurationSeconds" IS NOT NULL AND
        "capacityRequiredSeconds" IS NOT NULL AND
        "currency" = 'USD' AND "routeCalculatedAt" IS NOT NULL AND
        "expiresAt" IS NOT NULL AND "bookable" IS NOT NULL
      )
    );

-- Keep the legacy quote path intact while selecting an explicit v4 validator
-- by schema/external policy identity.
ALTER FUNCTION validate_and_snapshot_walking_delivery_quote()
  RENAME TO validate_and_snapshot_walking_delivery_quote_v1;
DROP TRIGGER walking_delivery_quote_10_consistency ON "WalkingDeliveryQuote";

CREATE OR REPLACE FUNCTION require_walking_quote_write_flag() RETURNS trigger AS $$
DECLARE
  flag_key TEXT;
  flag_enabled BOOLEAN;
BEGIN
  flag_key := CASE
    WHEN NEW."schemaVersion" = 'orderpro.walking-delivery-quote.v2' OR
         NEW."externalFeePolicyVersionId" IS NOT NULL
      THEN 'local_delivery_v4.quote_writes'
    ELSE 'walking_delivery.quote_writes'
  END;

  SELECT "enabled" INTO flag_enabled FROM "FeatureFlag" WHERE "key" = flag_key;
  IF flag_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Walking-delivery quote writes are disabled by feature flag %', flag_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_and_snapshot_walking_delivery_quote_v4() RETURNS trigger AS $$
DECLARE
  local_identity "LocalDeliveryLocationIdentity"%ROWTYPE;
  zone_status "WalkingZoneVersionStatus";
  zone_assignment "WalkingAssignmentStrategy";
  zone_postal_codes TEXT[];
  zone_geometry JSONB;
  zone_effective_from TIMESTAMP(3);
  zone_effective_to TIMESTAMP(3);
  zone_set_status "WalkingZoneVersionStatus";
  zone_set_environment "FeePolicyEnvironment";
  zone_set_external_id VARCHAR(120);
  zone_set_effective_from TIMESTAMP(3);
  zone_set_effective_to TIMESTAMP(3);
  candidate_fee_version_id UUID;
  candidate_slot_policy_id UUID;
  version_status "DeliveryPolicyStatus";
  version_environment "FeePolicyEnvironment";
  version_external_id VARCHAR(120);
  version_currency CHAR(3);
  version_strategy "FeeCalculationStrategy";
  version_routing_profile VARCHAR(32);
  version_distance_basis "WalkingDistanceBasis";
  version_quote_ttl_seconds INTEGER;
  version_hold_ttl_seconds INTEGER;
  version_preparation_buffer_seconds INTEGER;
  version_handoff_buffer_seconds INTEGER;
  version_effective_from TIMESTAMP(3);
  version_effective_to TIMESTAMP(3);
  policy_external_id VARCHAR(120);
  canonical_fee_snapshot JSONB;
  tier_version_id UUID;
  tier_key VARCHAR(80);
  tier_sequence INTEGER;
  tier_lower DECIMAL(12, 2);
  tier_upper DECIMAL(12, 2);
  tier_fee INTEGER;
  tier_automatic BOOLEAN;
  tier_reason "WalkingQuoteReasonCode";
  requested_slots JSONB;
  canonical_slot_policy JSONB;
  slot_status "DeliveryPolicyStatus";
  slot_effective_from TIMESTAMP(3);
  slot_effective_to TIMESTAMP(3);
BEGIN
  IF NEW."schemaVersion" <> 'orderpro.walking-delivery-quote.v2' THEN
    RAISE EXCEPTION 'External walking fee v4 requires quote schema v2';
  END IF;

  IF NEW."reasonCode" = 'CONTACT_STORE' THEN
    IF NEW."externalFeePolicyVersionId" IS NOT NULL OR
       NEW."feePolicyVersionId" IS NOT NULL OR NEW."selectedLocationId" IS NOT NULL OR
       NEW."normalizedAddressStructured" IS NULL OR NEW."customerCoordinates" IS NULL OR
       NEW."postalCode" IS NULL OR NEW."expiresAt" IS NULL OR
       NEW."expiresAt" <= NEW."calculatedAt" THEN
      RAISE EXCEPTION 'CONTACT_STORE requires a normalized Manhattan address, expiry, and no priced route';
    END IF;
    NEW."bookable" := false;
    IF NEW."normalizedAddress" IS NULL THEN
      NEW."normalizedAddress" := COALESCE(
        NEW."normalizedAddressStructured" ->> 'formattedAddress',
        CONCAT_WS(', ',
          NEW."normalizedAddressStructured" ->> 'line1',
          NEW."normalizedAddressStructured" ->> 'city',
          CONCAT_WS(' ', NEW."normalizedAddressStructured" ->> 'state', NEW."postalCode")
        )
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."externalFeePolicyVersionId" IS NULL THEN
    RAISE EXCEPTION 'Quote schema v2 priced outcomes require an exact external fee version';
  END IF;

  SELECT * INTO local_identity
  FROM "LocalDeliveryLocationIdentity"
  WHERE "externalLocationId" = COALESCE(
    NEW."externalSelectedLocationId", NEW."selectedLocationId"
  ) AND "active" = true;

  IF local_identity."id" IS NULL THEN
    RAISE EXCEPTION 'Selected local-delivery location identity is unavailable';
  END IF;
  IF NEW."selectedOperationalLocationId" IS NOT NULL AND
     NEW."selectedOperationalLocationId" IS DISTINCT FROM local_identity."operationalLocationId" THEN
    RAISE EXCEPTION 'External and internal selected location identities do not match';
  END IF;
  IF NEW."selectedLocalDeliveryLocationId" IS NOT NULL AND
     NEW."selectedLocalDeliveryLocationId" IS DISTINCT FROM local_identity."id" THEN
    RAISE EXCEPTION 'Selected local-delivery identity reference does not match';
  END IF;

  NEW."selectedLocationId" := local_identity."externalLocationId";
  NEW."externalSelectedLocationId" := local_identity."externalLocationId";
  NEW."selectedOperationalLocationId" := local_identity."operationalLocationId";
  NEW."selectedLocalDeliveryLocationId" := local_identity."id";

  SELECT
    v."status", v."assignmentStrategy", v."postalCodes", v."geometry",
    v."effectiveFrom", v."effectiveTo",
    zs."status", zs."environment", zs."externalVersionId",
    zs."effectiveFrom", zs."effectiveTo"
  INTO
    zone_status, zone_assignment, zone_postal_codes, zone_geometry,
    zone_effective_from, zone_effective_to,
    zone_set_status, zone_set_environment, zone_set_external_id,
    zone_set_effective_from, zone_set_effective_to
  FROM "WalkingZoneVersion" v
  JOIN "WalkingZoneSetVersion" zs ON zs."id" = v."zoneSetVersionId"
  WHERE v."id" = NEW."zoneVersionId"
    AND zs."id" = NEW."zoneSetVersionId";

  IF zone_status IS DISTINCT FROM 'PUBLISHED' OR
     zone_set_status IS DISTINCT FROM 'PUBLISHED' OR
     zone_set_environment IS DISTINCT FROM 'STAGING' OR
     zone_set_external_id IS DISTINCT FROM 'upper-east-side-walking-zones-v1' OR
     zone_geometry IS NULL OR NEW."postalCode" <> ALL(zone_postal_codes) OR
     zone_effective_from IS NULL OR zone_effective_from > NEW."calculatedAt" OR
     (zone_effective_to IS NOT NULL AND zone_effective_to <= NEW."calculatedAt") OR
     zone_set_effective_from IS NULL OR zone_set_effective_from > NEW."calculatedAt" OR
     (zone_set_effective_to IS NOT NULL AND zone_set_effective_to <= NEW."calculatedAt") THEN
    RAISE EXCEPTION 'Exact walking-zone v4 version is not published and effective';
  END IF;
  NEW."externalZoneVersionId" := zone_set_external_id;

  NEW."assignmentRule" := CASE zone_assignment
    WHEN 'FIXED' THEN 'FIXED_POSTAL_ZONE'::"WalkingQuoteAssignmentRule"
    WHEN 'NEAREST_WALKING_ROUTE' THEN 'NEAREST_WALKING_ROUTE'::"WalkingQuoteAssignmentRule"
  END;

  SELECT f."calculationPolicyVersionId", c."slotPolicyId"
  INTO candidate_fee_version_id, candidate_slot_policy_id
  FROM "WalkingZoneCandidate" c
  JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
  WHERE c."walkingZoneVersionId" = NEW."zoneVersionId"
    AND c."locationId" = local_identity."operationalLocationId";

  IF candidate_fee_version_id IS NULL OR
     candidate_fee_version_id IS DISTINCT FROM NEW."feePolicyVersionId" THEN
    RAISE EXCEPTION 'Selected location is not assigned to the quoted v4 fee version';
  END IF;

  SELECT
    v."status", v."environment", v."externalVersionId", v."currency",
    v."strategy", v."routingProfile", v."distanceBasis",
    v."quoteTtlSeconds", v."holdTtlSeconds",
    v."preparationBufferSeconds", v."handoffBufferSeconds",
    v."effectiveFrom", v."effectiveTo", v."snapshot", p."externalPolicyId"
  INTO
    version_status, version_environment, version_external_id, version_currency,
    version_strategy, version_routing_profile, version_distance_basis,
    version_quote_ttl_seconds, version_hold_ttl_seconds,
    version_preparation_buffer_seconds, version_handoff_buffer_seconds,
    version_effective_from, version_effective_to, canonical_fee_snapshot,
    policy_external_id
  FROM "FeeCalculationPolicyVersion" v
  JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
  WHERE v."id" = NEW."feePolicyVersionId";

  IF version_status IS DISTINCT FROM 'PUBLISHED' OR
     version_environment IS DISTINCT FROM 'STAGING' OR
     policy_external_id IS DISTINCT FROM 'walking-route-distance-v4-base-10' OR
     version_external_id IS DISTINCT FROM 'walking-route-distance-v4-base-10-2026-07-16' OR
     version_strategy IS DISTINCT FROM 'WALKING_ROUTE_DISTANCE' OR
     version_routing_profile IS DISTINCT FROM 'walking' OR
     version_distance_basis IS DISTINCT FROM 'ONE_WAY_FROM_SELECTED_STORE' OR
     version_quote_ttl_seconds IS NULL OR version_hold_ttl_seconds IS NULL OR
     version_preparation_buffer_seconds IS NULL OR version_handoff_buffer_seconds IS NULL OR
     version_currency IS DISTINCT FROM 'USD' OR
     canonical_fee_snapshot IS NULL OR
     version_effective_from IS NULL OR version_effective_from > NEW."calculatedAt" OR
     (version_effective_to IS NOT NULL AND version_effective_to <= NEW."calculatedAt") THEN
    RAISE EXCEPTION 'Exact walking fee v4 version is not published and effective';
  END IF;
  IF NEW."externalFeePolicyVersionId" IS DISTINCT FROM version_external_id THEN
    RAISE EXCEPTION 'Caller feePolicyVersionId does not match the exact internal version reference';
  END IF;

  NEW."externalFeePolicyVersionId" := version_external_id;
  NEW."routingProfile" := version_routing_profile;
  NEW."distanceBasis" := version_distance_basis;
  NEW."currency" := version_currency;
  NEW."preparationBufferSeconds" := version_preparation_buffer_seconds;
  NEW."handoffBufferSeconds" := version_handoff_buffer_seconds;
  NEW."feePolicySnapshot" := canonical_fee_snapshot;

  SELECT
    t."feePolicyVersionId", t."tierKey", t."sequence",
    t."lowerExclusiveFeet", t."upperInclusiveFeet", t."feeCents",
    t."automatic", t."reasonCode"
  INTO
    tier_version_id, tier_key, tier_sequence,
    tier_lower, tier_upper, tier_fee, tier_automatic, tier_reason
  FROM "FeeCalculationTier" t
  WHERE t."id" = NEW."tierId";

  IF tier_version_id IS NULL OR tier_version_id IS DISTINCT FROM NEW."feePolicyVersionId" OR
     NEW."distanceFeet" IS NULL OR
     (tier_lower IS NOT NULL AND NEW."distanceFeet" <= tier_lower) OR
     (tier_upper IS NOT NULL AND NEW."distanceFeet" > tier_upper) OR
     tier_automatic IS DISTINCT FROM true OR tier_reason IS DISTINCT FROM 'ELIGIBLE' OR
     NEW."feeCents" IS DISTINCT FROM tier_fee THEN
    RAISE EXCEPTION 'Walking fee v4 quote does not match its exact automatic tier';
  END IF;

  NEW."tierSnapshot" := JSONB_BUILD_OBJECT(
    'id', tier_key, 'internalId', NEW."tierId", 'sequence', tier_sequence,
    'lowerExclusiveFeet', tier_lower, 'upperInclusiveFeet', tier_upper,
    'feeCents', tier_fee, 'automatic', tier_automatic, 'reasonCode', tier_reason
  );

  IF NEW."routingProvider" IS NULL OR BTRIM(NEW."routingProvider") = '' OR
     NEW."distanceFeet" IS NULL OR NEW."durationSeconds" IS NULL OR
     NEW."roundTripDistanceFeet" IS NULL OR
     NEW."estimatedRoundTripDurationSeconds" IS NULL OR
     NEW."capacityRequiredSeconds" IS NULL OR NEW."routeCalculatedAt" IS NULL OR
     NEW."expiresAt" IS NULL THEN
    RAISE EXCEPTION 'Walking fee v4 quote requires complete route, capacity, and expiry metrics';
  END IF;
  IF NEW."expiresAt" IS DISTINCT FROM
       NEW."calculatedAt" + (version_quote_ttl_seconds * INTERVAL '1 second') THEN
    RAISE EXCEPTION 'Walking fee v4 quote expiry does not match its versioned TTL';
  END IF;

  IF NEW."walkingPublicationId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "WalkingPublication" wp
    WHERE wp."id" = NEW."walkingPublicationId"
      AND wp."zoneSetVersionId" = NEW."zoneSetVersionId"
      AND wp."status" = 'PUBLISHED'
      AND wp."effectiveFrom" <= NEW."calculatedAt"
      AND (wp."effectiveTo" IS NULL OR wp."effectiveTo" > NEW."calculatedAt")
      AND EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(
          CASE WHEN JSONB_TYPEOF(wp."snapshot" -> 'zones') = 'array'
            THEN wp."snapshot" -> 'zones' ELSE '[]'::JSONB END
        ) published_zone
        WHERE published_zone ->> 'zoneVersionId' = NEW."zoneVersionId"::TEXT
      )
  ) THEN
    RAISE EXCEPTION 'Walking quote v4 requires exact published polygon lineage';
  END IF;

  IF NEW."reasonCode" IN ('ELIGIBLE', 'NO_SLOTS_FOR_SELECTED_LOCATION', 'TRANSFER_REQUIRED') THEN
    IF candidate_slot_policy_id IS NULL OR
       NEW."slotPolicyId" IS DISTINCT FROM candidate_slot_policy_id THEN
      RAISE EXCEPTION 'Walking quote v4 must evaluate only the selected location slot policy';
    END IF;
    requested_slots := CASE
      WHEN JSONB_TYPEOF(NEW."slotSnapshot") = 'array' THEN NEW."slotSnapshot"
      WHEN JSONB_TYPEOF(NEW."slotSnapshot") = 'object' THEN NEW."slotSnapshot" -> 'slots'
      ELSE NULL
    END;
    IF JSONB_TYPEOF(requested_slots) IS DISTINCT FROM 'array' OR
       (NEW."reasonCode" IN ('ELIGIBLE', 'TRANSFER_REQUIRED') AND JSONB_ARRAY_LENGTH(requested_slots) = 0) OR
       (NEW."reasonCode" = 'NO_SLOTS_FOR_SELECTED_LOCATION' AND JSONB_ARRAY_LENGTH(requested_slots) <> 0) OR
       EXISTS (
         SELECT 1 FROM JSONB_ARRAY_ELEMENTS(requested_slots) slot
         WHERE JSONB_TYPEOF(slot) IS DISTINCT FROM 'object'
            OR JSONB_TYPEOF(slot -> 'locationId') IS DISTINCT FROM 'string'
            OR JSONB_TYPEOF(slot -> 'startsAt') IS DISTINCT FROM 'string'
            OR JSONB_TYPEOF(slot -> 'endsAt') IS DISTINCT FROM 'string'
            OR slot ->> 'locationId' IS DISTINCT FROM local_identity."externalLocationId"
            OR NOT ISFINITE((slot ->> 'startsAt')::TIMESTAMPTZ)
            OR NOT ISFINITE((slot ->> 'endsAt')::TIMESTAMPTZ)
            OR (slot ->> 'startsAt')::TIMESTAMPTZ >= (slot ->> 'endsAt')::TIMESTAMPTZ
            OR (slot ->> 'startsAt')::TIMESTAMPTZ < NEW."calculatedAt"
       ) THEN
      RAISE EXCEPTION 'Walking quote v4 slots must belong exclusively to the selected location';
    END IF;
    IF NEW."reasonCode" = 'TRANSFER_REQUIRED' AND (
      NEW."inventoryReadinessStatus" IS DISTINCT FROM 'TRANSFER_REQUIRED' OR
      NEW."inventoryReadyAt" IS NULL OR EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(requested_slots) slot
        WHERE (slot ->> 'startsAt')::TIMESTAMPTZ < NEW."inventoryReadyAt"
      )
    ) THEN
      RAISE EXCEPTION 'Transfer-required slots must start after certified inventory readiness';
    END IF;

    SELECT s."status", s."effectiveFrom", s."effectiveTo", JSONB_BUILD_OBJECT(
      'id', s."id", 'policyKey', s."policyKey", 'versionNumber', s."versionNumber",
      'locationId', local_identity."externalLocationId", 'status', s."status",
      'activeDays', s."activeDays", 'leadTimeMinutes', s."leadTimeMinutes",
      'cutoffMinuteOfDay', s."cutoffMinuteOfDay",
      'capacityPolicyRef', s."capacityPolicyRef", 'effectiveFrom', s."effectiveFrom",
      'effectiveTo', s."effectiveTo", 'digest', s."digest"
    ) INTO slot_status, slot_effective_from, slot_effective_to, canonical_slot_policy
    FROM "SlotPolicy" s WHERE s."id" = NEW."slotPolicyId";

    IF slot_status IS DISTINCT FROM 'PUBLISHED' OR
       slot_effective_from IS NULL OR slot_effective_from > NEW."calculatedAt" OR
       (slot_effective_to IS NOT NULL AND slot_effective_to <= NEW."calculatedAt") THEN
      RAISE EXCEPTION 'Selected location slot policy is not published and effective';
    END IF;
    NEW."slotSnapshot" := JSONB_BUILD_OBJECT('policy', canonical_slot_policy, 'slots', requested_slots);
  ELSIF NEW."slotPolicyId" IS NOT NULL OR NEW."slotSnapshot" IS NOT NULL THEN
    RAISE EXCEPTION 'Non-slot v4 outcomes cannot promise delivery slots';
  END IF;

  NEW."bookable" := NEW."reasonCode" IN ('ELIGIBLE', 'TRANSFER_REQUIRED');

  IF NEW."normalizedAddress" IS NULL THEN
    NEW."normalizedAddress" := COALESCE(
      NEW."normalizedAddressStructured" ->> 'formattedAddress',
      CONCAT_WS(', ',
        NEW."normalizedAddressStructured" ->> 'line1',
        NEW."normalizedAddressStructured" ->> 'city',
        CONCAT_WS(' ', NEW."normalizedAddressStructured" ->> 'state', NEW."postalCode")
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_10_consistency_v1
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW
WHEN (NEW."schemaVersion" <> 'orderpro.walking-delivery-quote.v2')
EXECUTE FUNCTION validate_and_snapshot_walking_delivery_quote_v1();

CREATE TRIGGER walking_delivery_quote_10_consistency_v4
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW
WHEN (NEW."schemaVersion" = 'orderpro.walking-delivery-quote.v2')
EXECUTE FUNCTION validate_and_snapshot_walking_delivery_quote_v4();

CREATE FUNCTION canonicalize_walking_quote_candidate_route() RETURNS trigger AS $$
DECLARE
  identity "LocalDeliveryLocationIdentity"%ROWTYPE;
  quote_schema VARCHAR(100);
  quote_provider VARCHAR(80);
  quote_profile VARCHAR(32);
  quote_calculated_at TIMESTAMP(3);
BEGIN
  SELECT * INTO identity FROM "LocalDeliveryLocationIdentity"
  WHERE "id" = NEW."localDeliveryLocationId" AND "active" = true;
  IF identity."id" IS NULL THEN
    RAISE EXCEPTION 'Candidate route local-delivery identity is unavailable';
  END IF;
  IF identity."locationPriority" IS NULL THEN
    RAISE EXCEPTION 'Candidate route requires configured auditable locationPriority';
  END IF;

  SELECT q."schemaVersion", q."routingProvider", q."routingProfile", q."calculatedAt"
  INTO quote_schema, quote_provider, quote_profile, quote_calculated_at
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  IF quote_schema IS DISTINCT FROM 'orderpro.walking-delivery-quote.v2' THEN
    RAISE EXCEPTION 'Candidate routes are supported only by quote schema v2';
  END IF;
  IF NEW."routingProvider" IS DISTINCT FROM quote_provider OR
     NEW."routingProfile" IS DISTINCT FROM quote_profile OR
     NEW."routeCalculatedAt" > quote_calculated_at THEN
    RAISE EXCEPTION 'Candidate route provider/profile/timestamp does not match its quote';
  END IF;

  NEW."operationalLocationId" := identity."operationalLocationId";
  NEW."externalLocationId" := identity."externalLocationId";
  NEW."locationPriority" := identity."locationPriority";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_quote_candidate_route_canonical
BEFORE INSERT ON "WalkingDeliveryQuoteCandidateRoute"
FOR EACH ROW EXECUTE FUNCTION canonicalize_walking_quote_candidate_route();

CREATE FUNCTION validate_walking_quote_candidate_routes() RETURNS trigger AS $$
DECLARE
  target_quote_id UUID;
  assignment "WalkingQuoteAssignmentRule";
  postal_code VARCHAR(10);
  selected_location_id UUID;
  selected_external_id VARCHAR(64);
  quote_distance DECIMAL(12, 2);
  quote_duration INTEGER;
  quote_route_calculated_at TIMESTAMP(3);
  quote_external_fee_id VARCHAR(120);
  route_count INTEGER;
  selected_count INTEGER;
  expected_count INTEGER;
  winner_id UUID;
BEGIN
  target_quote_id := CASE
    WHEN TG_TABLE_NAME = 'WalkingDeliveryQuote' THEN NEW."id"
    WHEN TG_OP = 'DELETE' THEN OLD."quoteId"
    ELSE NEW."quoteId"
  END;

  SELECT
    q."assignmentRule", q."postalCode", q."selectedOperationalLocationId",
    q."externalSelectedLocationId", q."distanceFeet", q."durationSeconds",
    q."routeCalculatedAt", q."externalFeePolicyVersionId"
  INTO
    assignment, postal_code, selected_location_id,
    selected_external_id, quote_distance, quote_duration,
    quote_route_calculated_at, quote_external_fee_id
  FROM "WalkingDeliveryQuote" q WHERE q."id" = target_quote_id;

  IF quote_external_fee_id IS NULL OR quote_distance IS NULL THEN
    RETURN NULL;
  END IF;

  expected_count := CASE assignment
    WHEN 'FIXED_POSTAL_ZONE' THEN 1
    WHEN 'NEAREST_WALKING_ROUTE' THEN 2
  END;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE "selected" = true)
  INTO route_count, selected_count
  FROM "WalkingDeliveryQuoteCandidateRoute"
  WHERE "quoteId" = target_quote_id;

  IF route_count <> expected_count OR selected_count <> 1 THEN
    RAISE EXCEPTION 'Quote candidate-route set is incomplete or has multiple winners';
  END IF;

  IF assignment = 'FIXED_POSTAL_ZONE' AND NOT (
    (postal_code IN ('10021', '10065') AND selected_external_id = 'third_avenue') OR
    (postal_code IN ('10028', '10128') AND selected_external_id = 'east_86th_street')
  ) THEN
    RAISE EXCEPTION 'Fixed postal zone selected the wrong local-delivery location';
  END IF;

  IF assignment = 'NEAREST_WALKING_ROUTE' AND (
    postal_code <> '10075' OR
    NOT EXISTS (
      SELECT 1 FROM "WalkingDeliveryQuoteCandidateRoute"
      WHERE "quoteId" = target_quote_id AND "externalLocationId" = 'third_avenue'
    ) OR
    NOT EXISTS (
      SELECT 1 FROM "WalkingDeliveryQuoteCandidateRoute"
      WHERE "quoteId" = target_quote_id AND "externalLocationId" = 'east_86th_street'
    )
  ) THEN
    RAISE EXCEPTION 'ZIP 10075 must preserve both candidate walking routes';
  END IF;

  SELECT "id" INTO winner_id
  FROM "WalkingDeliveryQuoteCandidateRoute"
  WHERE "quoteId" = target_quote_id
  ORDER BY
    "walkingDistanceFeet" ASC,
    "walkingDurationSeconds" ASC,
    "locationPriority" ASC,
    "externalLocationId" ASC
  LIMIT 1;

  IF NOT EXISTS (
    SELECT 1 FROM "WalkingDeliveryQuoteCandidateRoute" r
    WHERE r."id" = winner_id AND r."selected" = true
      AND r."operationalLocationId" = selected_location_id
      AND r."externalLocationId" = selected_external_id
      AND r."walkingDistanceFeet" = quote_distance
      AND r."walkingDurationSeconds" = quote_duration
      AND r."routeCalculatedAt" = quote_route_calculated_at
  ) THEN
    RAISE EXCEPTION 'Selected quote route is not the deterministic candidate-route winner';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER walking_quote_candidate_routes_from_quote_check
AFTER INSERT ON "WalkingDeliveryQuote"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_candidate_routes();

CREATE CONSTRAINT TRIGGER walking_quote_candidate_routes_check
AFTER INSERT OR UPDATE OR DELETE ON "WalkingDeliveryQuoteCandidateRoute"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_candidate_routes();

CREATE FUNCTION reject_walking_quote_candidate_route_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Walking quote candidate routes are immutable audit evidence';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_quote_candidate_route_no_update
BEFORE UPDATE ON "WalkingDeliveryQuoteCandidateRoute"
FOR EACH ROW EXECUTE FUNCTION reject_walking_quote_candidate_route_mutation();
CREATE TRIGGER walking_quote_candidate_route_no_delete
BEFORE DELETE ON "WalkingDeliveryQuoteCandidateRoute"
FOR EACH ROW EXECUTE FUNCTION reject_walking_quote_candidate_route_mutation();

CREATE FUNCTION validate_walking_quote_inventory_line() RETURNS trigger AS $$
DECLARE
  quote_status "WalkingInventoryReadinessStatus";
  container_location_id UUID;
  container_storage_id UUID;
  lot_product_id UUID;
  lot_owner_id UUID;
BEGIN
  SELECT q."inventoryReadinessStatus" INTO quote_status
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  IF quote_status IS NULL OR quote_status = 'NOT_EVALUATED' THEN
    RAISE EXCEPTION 'Inventory line requires an evaluated quote inventory status';
  END IF;

  IF NEW."productId" IS NOT NULL AND NEW."containerId" IS NOT NULL THEN
    SELECT c."currentLocationId", c."storageLocationId"
    INTO container_location_id, container_storage_id
    FROM "Container" c WHERE c."id" = NEW."containerId";
    IF NEW."inventoryNodeId" IS DISTINCT FROM container_location_id OR
       NEW."storageLocationId" IS DISTINCT FROM container_storage_id THEN
      RAISE EXCEPTION 'Quote inventory physical node/container/bin references disagree';
    END IF;
  END IF;

  NEW."snapshot" := JSONB_BUILD_OBJECT(
    'variantId', NEW."variantId", 'productId', NEW."productId",
    'quantity', NEW."quantity", 'readinessStatus', NEW."readinessStatus",
    'inventoryOwnerLocationId', NEW."inventoryOwnerLocationId",
    'inventoryNodeId', NEW."inventoryNodeId", 'containerId', NEW."containerId",
    'storageLocationId', NEW."storageLocationId",
    'transferStatus', NEW."transferStatus", 'earliestReadyAt', NEW."earliestReadyAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_quote_inventory_line_validate
BEFORE INSERT ON "WalkingDeliveryQuoteInventoryLine"
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_inventory_line();

CREATE FUNCTION reject_walking_quote_inventory_line_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Walking quote inventory evidence is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_quote_inventory_line_no_update
BEFORE UPDATE ON "WalkingDeliveryQuoteInventoryLine"
FOR EACH ROW EXECUTE FUNCTION reject_walking_quote_inventory_line_mutation();
CREATE TRIGGER walking_quote_inventory_line_no_delete
BEFORE DELETE ON "WalkingDeliveryQuoteInventoryLine"
FOR EACH ROW EXECUTE FUNCTION reject_walking_quote_inventory_line_mutation();

CREATE FUNCTION validate_walking_capacity_slot() RETURNS trigger AS $$
DECLARE
  policy_location_id UUID;
  policy_status "DeliveryPolicyStatus";
BEGIN
  SELECT s."locationId", s."status"
  INTO policy_location_id, policy_status
  FROM "SlotPolicy" s WHERE s."id" = NEW."slotPolicyId";
  IF policy_location_id IS DISTINCT FROM NEW."operationalLocationId" THEN
    RAISE EXCEPTION 'Capacity slot location does not match its slot policy';
  END IF;
  IF NEW."status" = 'OPEN' AND policy_status IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'Open capacity slots require a published slot policy';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."slotPolicyId" IS DISTINCT FROM OLD."slotPolicyId" OR
       NEW."operationalLocationId" IS DISTINCT FROM OLD."operationalLocationId" OR
       NEW."slotKey" IS DISTINCT FROM OLD."slotKey" OR
       NEW."startsAt" IS DISTINCT FROM OLD."startsAt" OR
       NEW."endsAt" IS DISTINCT FROM OLD."endsAt" OR
       NEW."capacitySeconds" IS DISTINCT FROM OLD."capacitySeconds" THEN
      RAISE EXCEPTION 'Capacity slot identity, time, and capacity are immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Capacity slot updates require optimistic version increment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_capacity_slot_validate
BEFORE INSERT OR UPDATE ON "WalkingCapacitySlot"
FOR EACH ROW EXECUTE FUNCTION validate_walking_capacity_slot();

CREATE FUNCTION reject_walking_capacity_slot_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Capacity slots cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_capacity_slot_no_delete
BEFORE DELETE ON "WalkingCapacitySlot"
FOR EACH ROW EXECUTE FUNCTION reject_walking_capacity_slot_delete();

CREATE FUNCTION validate_walking_capacity_hold() RETURNS trigger AS $$
DECLARE
  write_enabled BOOLEAN;
  quote_client_id VARCHAR(120);
  quote_location_id UUID;
  quote_capacity_seconds INTEGER;
  quote_expires_at TIMESTAMP(3);
  quote_inventory_ready_at TIMESTAMP(3);
  quote_bookable BOOLEAN;
  version_hold_ttl_seconds INTEGER;
  slot_location_id UUID;
  slot_starts_at TIMESTAMP(3);
  slot_ends_at TIMESTAMP(3);
  slot_capacity INTEGER;
  slot_status "WalkingCapacitySlotStatus";
  active_capacity BIGINT;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IN ('HELD', 'CONFIRMED') THEN
    SELECT "enabled" INTO write_enabled FROM "FeatureFlag"
    WHERE "key" = 'local_delivery_v4.hold_writes';
    IF write_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Local-delivery v4 capacity-hold writes are disabled';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."quoteId" IS DISTINCT FROM OLD."quoteId" OR
       NEW."capacitySlotId" IS DISTINCT FROM OLD."capacitySlotId" OR
       NEW."clientId" IS DISTINCT FROM OLD."clientId" OR
       NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
       NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
       NEW."correlationId" IS DISTINCT FROM OLD."correlationId" OR
       NEW."reservedCapacitySeconds" IS DISTINCT FROM OLD."reservedCapacitySeconds" OR
       NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
      RAISE EXCEPTION 'Capacity hold identity and reservation inputs are immutable';
    END IF;
    IF NOT (
      OLD."status" = 'HELD' AND NEW."status" IN ('CONFIRMED', 'RELEASED', 'EXPIRED')
    ) THEN
      RAISE EXCEPTION 'Invalid capacity hold lifecycle transition';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Capacity hold transition requires optimistic version increment';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'HELD' THEN
    RAISE EXCEPTION 'A capacity hold must start in HELD status';
  END IF;

  SELECT
    q."clientId", q."selectedOperationalLocationId", q."capacityRequiredSeconds",
    q."expiresAt", q."inventoryReadyAt", q."bookable", v."holdTtlSeconds"
  INTO
    quote_client_id, quote_location_id, quote_capacity_seconds,
    quote_expires_at, quote_inventory_ready_at, quote_bookable, version_hold_ttl_seconds
  FROM "WalkingDeliveryQuote" q
  JOIN "FeeCalculationPolicyVersion" v ON v."id" = q."feePolicyVersionId"
  WHERE q."id" = NEW."quoteId";

  IF quote_client_id IS NULL OR quote_client_id IS DISTINCT FROM NEW."clientId" OR
     quote_bookable IS DISTINCT FROM true OR
     quote_capacity_seconds IS NULL OR
     quote_capacity_seconds IS DISTINCT FROM NEW."reservedCapacitySeconds" OR
     quote_expires_at IS NULL OR version_hold_ttl_seconds IS NULL OR
     NEW."expiresAt" IS DISTINCT FROM LEAST(
       quote_expires_at,
       NEW."createdAt" + (version_hold_ttl_seconds * INTERVAL '1 second')
     ) THEN
    RAISE EXCEPTION 'Capacity hold does not match its unexpired quote';
  END IF;
  IF NEW."status" IN ('HELD', 'CONFIRMED') AND
     (NEW."expiresAt" <= CURRENT_TIMESTAMP OR quote_expires_at <= CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'Cannot hold or confirm expired quote capacity';
  END IF;

  SELECT s."operationalLocationId", s."startsAt", s."endsAt", s."capacitySeconds", s."status"
  INTO slot_location_id, slot_starts_at, slot_ends_at, slot_capacity, slot_status
  FROM "WalkingCapacitySlot" s
  WHERE s."id" = NEW."capacitySlotId"
  FOR UPDATE;

  IF slot_status IS DISTINCT FROM 'OPEN' OR slot_location_id IS DISTINCT FROM quote_location_id OR
     slot_starts_at <= NEW."createdAt" OR
     (quote_inventory_ready_at IS NOT NULL AND slot_starts_at < quote_inventory_ready_at) THEN
    RAISE EXCEPTION 'Capacity slot is unavailable for the selected location or inventory readiness';
  END IF;

  IF NEW."status" IN ('HELD', 'CONFIRMED') THEN
    SELECT COALESCE(SUM(h."reservedCapacitySeconds"), 0)
    INTO active_capacity
    FROM "WalkingCapacityHold" h
    WHERE h."capacitySlotId" = NEW."capacitySlotId"
      AND h."id" <> NEW."id"
      AND (
        h."status" = 'CONFIRMED' OR
        (h."status" = 'HELD' AND h."expiresAt" > CURRENT_TIMESTAMP)
      );
    IF active_capacity + NEW."reservedCapacitySeconds" > slot_capacity THEN
      RAISE EXCEPTION 'CAPACITY_HOLD_FAILED: slot capacity would be oversubscribed';
    END IF;
  END IF;

  IF NEW."status" = 'CONFIRMED' AND CURRENT_TIMESTAMP >= NEW."expiresAt" THEN
    RAISE EXCEPTION 'Cannot confirm an expired capacity hold';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_capacity_hold_validate
BEFORE INSERT OR UPDATE ON "WalkingCapacityHold"
FOR EACH ROW EXECUTE FUNCTION validate_walking_capacity_hold();

CREATE FUNCTION reject_walking_capacity_hold_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Capacity holds are append/lifecycle audit records and cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_capacity_hold_no_delete
BEFORE DELETE ON "WalkingCapacityHold"
FOR EACH ROW EXECUTE FUNCTION reject_walking_capacity_hold_delete();

CREATE FUNCTION validate_walking_inventory_reservation() RETURNS trigger AS $$
DECLARE
  write_enabled BOOLEAN;
  quote_client_id VARCHAR(120);
  quote_location_id UUID;
  quote_expires_at TIMESTAMP(3);
  hold_quote_id UUID;
  hold_status "WalkingCapacityHoldStatus";
  hold_expires_at TIMESTAMP(3);
  order_external_id VARCHAR(64);
  delivery_external_id VARCHAR(64);
  release_line RECORD;
  release_balance RECORD;
  release_ledger_idempotency_key TEXT;
  release_ledger_sequence BIGINT;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IN ('HELD', 'CONFIRMED') THEN
    SELECT "enabled" INTO write_enabled FROM "FeatureFlag"
    WHERE "key" = 'local_delivery_v4.inventory_reservation_writes';
    IF write_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Local-delivery v4 inventory reservation writes are disabled';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."quoteId" IS DISTINCT FROM OLD."quoteId" OR
       NEW."capacityHoldId" IS DISTINCT FROM OLD."capacityHoldId" OR
       NEW."clientId" IS DISTINCT FROM OLD."clientId" OR
       NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
       NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
       NEW."correlationId" IS DISTINCT FROM OLD."correlationId" OR
       NEW."orderLocationId" IS DISTINCT FROM OLD."orderLocationId" OR
       NEW."deliveryLocationId" IS DISTINCT FROM OLD."deliveryLocationId" OR
       NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
      RAISE EXCEPTION 'Inventory reservation identity and inputs are immutable';
    END IF;
    IF NOT (
      OLD."status" = 'HELD' AND NEW."status" IN ('CONFIRMED', 'RELEASED', 'EXPIRED')
    ) THEN
      RAISE EXCEPTION 'Invalid inventory reservation lifecycle transition';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Inventory reservation transition requires optimistic version increment';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'HELD' THEN
    RAISE EXCEPTION 'An inventory reservation must start in HELD status';
  END IF;

  SELECT q."clientId", q."selectedOperationalLocationId", q."expiresAt"
  INTO quote_client_id, quote_location_id, quote_expires_at
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  IF quote_client_id IS NULL OR quote_client_id IS DISTINCT FROM NEW."clientId" OR
     quote_location_id IS DISTINCT FROM NEW."deliveryLocationId" OR
     quote_expires_at IS NULL OR NEW."expiresAt" > quote_expires_at THEN
    RAISE EXCEPTION 'Inventory reservation does not match its quote and delivery location';
  END IF;

  SELECT h."quoteId", h."status", h."expiresAt"
  INTO hold_quote_id, hold_status, hold_expires_at
  FROM "WalkingCapacityHold" h WHERE h."id" = NEW."capacityHoldId";
  IF hold_quote_id IS DISTINCT FROM NEW."quoteId" OR
     NEW."expiresAt" IS DISTINCT FROM hold_expires_at OR
     hold_status::TEXT IS DISTINCT FROM NEW."status"::TEXT THEN
    RAISE EXCEPTION 'Inventory reservation requires the same active capacity hold';
  END IF;
  IF NEW."status" IN ('HELD', 'CONFIRMED') AND NEW."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Cannot hold or confirm expired inventory';
  END IF;

  SELECT i."externalLocationId" INTO order_external_id
  FROM "LocalDeliveryLocationIdentity" i
  WHERE i."operationalLocationId" = NEW."orderLocationId" AND i."active" = true;
  SELECT i."externalLocationId" INTO delivery_external_id
  FROM "LocalDeliveryLocationIdentity" i
  WHERE i."operationalLocationId" = NEW."deliveryLocationId" AND i."active" = true;
  IF order_external_id IS NULL OR delivery_external_id IS NULL THEN
    RAISE EXCEPTION 'Order and delivery locations require active external identities';
  END IF;
  NEW."orderLocationExternalId" := order_external_id;
  NEW."deliveryLocationExternalId" := delivery_external_id;

  IF NEW."status" = 'CONFIRMED' AND NOT EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" l
    WHERE l."reservationId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Cannot confirm an empty inventory reservation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" IN ('RELEASED', 'EXPIRED') THEN
    FOR release_line IN
      SELECT l."inventoryNodeBalanceId", SUM(l."quantity") AS quantity
      FROM "WalkingInventoryReservationLine" l
      WHERE l."reservationId" = NEW."id"
      GROUP BY l."inventoryNodeBalanceId"
      ORDER BY l."inventoryNodeBalanceId"
    LOOP
      PERFORM 1 FROM "InventoryNodeBalance" b
      WHERE b."id" = release_line."inventoryNodeBalanceId"
      FOR UPDATE;
      SELECT b.* INTO release_balance
      FROM "InventoryNodeBalance" b
      WHERE b."id" = release_line."inventoryNodeBalanceId";
      IF release_balance."id" IS NULL OR
         release_balance."reserved" < release_line.quantity THEN
        RAISE EXCEPTION 'Inventory reservation release exceeds its reserved balance';
      END IF;

      release_ledger_idempotency_key :=
        'walking-v4:reservation:' || NEW."id"::TEXT || ':balance:' ||
        release_line."inventoryNodeBalanceId"::TEXT || ':released';
      INSERT INTO "InventoryLedgerEntry" (
        "id", "eventType", "idempotencyKey", "productId", "inventoryLotId",
        "containerId", "quantity", "fromAvailabilityState", "toAvailabilityState",
        "fromLocationId", "toLocationId", "fromStorageLocationId",
        "toStorageLocationId", "businessReferenceType", "businessReferenceId",
        "correlationId", "metadata", "occurredAt"
      ) VALUES (
        md5(release_ledger_idempotency_key)::UUID, 'RESERVATION_RELEASED',
        release_ledger_idempotency_key, release_balance."productId",
        release_balance."inventoryLotId", release_balance."containerId",
        release_line.quantity, 'RESERVED', 'AVAILABLE_ONLINE',
        release_balance."inventoryNodeId", release_balance."inventoryNodeId",
        release_balance."storageLocationId", release_balance."storageLocationId",
        'WalkingInventoryReservation', NEW."id"::TEXT, NEW."correlationId",
        jsonb_build_object(
          'inventoryNodeBalanceId', release_line."inventoryNodeBalanceId",
          'reservationStatus', NEW."status",
          'releaseReason', NEW."releaseReason",
          'availableBefore', release_balance."available",
          'availableAfter', release_balance."available" + release_line.quantity,
          'reservedBefore', release_balance."reserved",
          'reservedAfter', release_balance."reserved" - release_line.quantity
        ),
        NEW."releasedAt"
      )
      RETURNING "sequence" INTO release_ledger_sequence;

      UPDATE "InventoryNodeBalance"
      SET
        "available" = "available" + release_line.quantity,
        "reserved" = "reserved" - release_line.quantity,
        "ledgerSequence" = release_ledger_sequence,
        "version" = "version" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = release_line."inventoryNodeBalanceId"
        AND "reserved" >= release_line.quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Inventory reservation release exceeds its reserved balance';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_inventory_reservation_validate
BEFORE INSERT OR UPDATE ON "WalkingInventoryReservation"
FOR EACH ROW EXECUTE FUNCTION validate_walking_inventory_reservation();

CREATE FUNCTION reject_walking_inventory_reservation_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Inventory reservations are append/lifecycle audit records and cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_inventory_reservation_no_delete
BEFORE DELETE ON "WalkingInventoryReservation"
FOR EACH ROW EXECUTE FUNCTION reject_walking_inventory_reservation_delete();

CREATE FUNCTION validate_walking_hold_inventory_pair() RETURNS trigger AS $$
DECLARE
  target_hold_id UUID;
  hold_quote_id UUID;
  hold_client_id VARCHAR(120);
  hold_idempotency_key VARCHAR(160);
  hold_request_hash VARCHAR(80);
  hold_correlation_id VARCHAR(120);
  hold_status "WalkingCapacityHoldStatus";
  hold_expires_at TIMESTAMP(3);
  hold_confirmed_order_id VARCHAR(160);
  hold_confirmed_at TIMESTAMP(3);
  hold_released_at TIMESTAMP(3);
  hold_release_reason "WalkingCapacityHoldReleaseReason";
  reservation_count INTEGER;
  reservation_quote_id UUID;
  reservation_client_id VARCHAR(120);
  reservation_idempotency_key VARCHAR(160);
  reservation_request_hash VARCHAR(80);
  reservation_correlation_id VARCHAR(120);
  reservation_status "WalkingInventoryReservationStatus";
  reservation_expires_at TIMESTAMP(3);
  reservation_confirmed_order_id VARCHAR(160);
  reservation_confirmed_at TIMESTAMP(3);
  reservation_released_at TIMESTAMP(3);
  reservation_release_reason "WalkingInventoryReservationReleaseReason";
BEGIN
  target_hold_id := CASE
    WHEN TG_TABLE_NAME = 'WalkingCapacityHold' THEN NEW."id"
    ELSE NEW."capacityHoldId"
  END;

  SELECT h."quoteId", h."clientId", h."idempotencyKey", h."requestHash",
         h."correlationId", h."status", h."expiresAt", h."confirmedOrderId",
         h."confirmedAt", h."releasedAt", h."releaseReason"
  INTO hold_quote_id, hold_client_id, hold_idempotency_key, hold_request_hash,
       hold_correlation_id, hold_status, hold_expires_at, hold_confirmed_order_id,
       hold_confirmed_at, hold_released_at, hold_release_reason
  FROM "WalkingCapacityHold" h WHERE h."id" = target_hold_id;

  SELECT COUNT(*) INTO reservation_count
  FROM "WalkingInventoryReservation" r WHERE r."capacityHoldId" = target_hold_id;
  IF reservation_count = 1 THEN
    SELECT r."quoteId", r."clientId", r."idempotencyKey", r."requestHash",
           r."correlationId", r."status", r."expiresAt", r."confirmedOrderId",
           r."confirmedAt", r."releasedAt", r."releaseReason"
    INTO reservation_quote_id, reservation_client_id, reservation_idempotency_key,
         reservation_request_hash, reservation_correlation_id, reservation_status,
         reservation_expires_at, reservation_confirmed_order_id,
         reservation_confirmed_at, reservation_released_at, reservation_release_reason
    FROM "WalkingInventoryReservation" r WHERE r."capacityHoldId" = target_hold_id;
  END IF;

  IF hold_quote_id IS NULL OR reservation_count <> 1 OR
     reservation_quote_id IS DISTINCT FROM hold_quote_id OR
     reservation_client_id IS DISTINCT FROM hold_client_id OR
     reservation_idempotency_key IS DISTINCT FROM hold_idempotency_key OR
     reservation_request_hash IS DISTINCT FROM hold_request_hash OR
     reservation_correlation_id IS DISTINCT FROM hold_correlation_id OR
     reservation_status::TEXT IS DISTINCT FROM hold_status::TEXT OR
     reservation_expires_at IS DISTINCT FROM hold_expires_at THEN
    RAISE EXCEPTION 'Capacity hold and inventory reservation must be one atomic synchronized pair';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" l
    JOIN "WalkingInventoryReservation" r ON r."id" = l."reservationId"
    WHERE r."capacityHoldId" = target_hold_id
  ) THEN
    RAISE EXCEPTION 'Capacity/inventory hold pair cannot be empty';
  END IF;
  IF EXISTS (
    WITH quote_totals AS (
      SELECT ql."variantId", SUM(ql."quantity"::DECIMAL(18, 3)) AS quantity
      FROM "WalkingDeliveryQuoteInventoryLine" ql
      WHERE ql."quoteId" = hold_quote_id
      GROUP BY ql."variantId"
    ), reservation_totals AS (
      SELECT rl."variantId", SUM(rl."quantity") AS quantity
      FROM "WalkingInventoryReservationLine" rl
      JOIN "WalkingInventoryReservation" r ON r."id" = rl."reservationId"
      WHERE r."capacityHoldId" = target_hold_id
      GROUP BY rl."variantId"
    )
    SELECT 1 FROM quote_totals q
    FULL JOIN reservation_totals r USING ("variantId")
    WHERE COALESCE(q.quantity, 0) IS DISTINCT FROM COALESCE(r.quantity, 0)
  ) THEN
    RAISE EXCEPTION 'Reserved inventory totals must exactly match quote cart evidence';
  END IF;
  IF hold_status = 'CONFIRMED' AND (
    hold_confirmed_order_id IS NULL OR
    reservation_confirmed_order_id IS DISTINCT FROM hold_confirmed_order_id OR
    reservation_confirmed_at IS DISTINCT FROM hold_confirmed_at
  ) THEN
    RAISE EXCEPTION 'Confirmed capacity/inventory pair must share the same order';
  END IF;
  IF hold_status IN ('RELEASED', 'EXPIRED') AND (
     reservation_released_at IS DISTINCT FROM hold_released_at OR
     reservation_release_reason::TEXT IS DISTINCT FROM hold_release_reason::TEXT
  ) THEN
    RAISE EXCEPTION 'Released/expired capacity and inventory pair must share its lifecycle timestamp';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER walking_hold_inventory_pair_from_hold_check
AFTER INSERT OR UPDATE ON "WalkingCapacityHold"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_hold_inventory_pair();
CREATE CONSTRAINT TRIGGER walking_hold_inventory_pair_from_reservation_check
AFTER INSERT OR UPDATE ON "WalkingInventoryReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_hold_inventory_pair();

CREATE FUNCTION validate_inventory_node_balance() RETURNS trigger AS $$
DECLARE
  lot_product_id UUID;
  lot_owner_id UUID;
  container_node_id UUID;
  container_storage_id UUID;
  storage_node_id UUID;
BEGIN
  SELECT l."productId", l."ownerLocationId"
  INTO lot_product_id, lot_owner_id
  FROM "InventoryLot" l WHERE l."id" = NEW."inventoryLotId";
  IF lot_product_id IS DISTINCT FROM NEW."productId" OR
     lot_owner_id IS DISTINCT FROM NEW."inventoryOwnerLocationId" THEN
    RAISE EXCEPTION 'Inventory-node balance product/lot/owner references disagree';
  END IF;
  IF NEW."containerId" IS NOT NULL THEN
    SELECT c."currentLocationId", c."storageLocationId"
    INTO container_node_id, container_storage_id
    FROM "Container" c WHERE c."id" = NEW."containerId";
    IF container_node_id IS DISTINCT FROM NEW."inventoryNodeId" OR
       (NEW."storageLocationId" IS NOT NULL AND
        container_storage_id IS DISTINCT FROM NEW."storageLocationId") THEN
      RAISE EXCEPTION 'Inventory-node balance box is not at its declared node/bin';
    END IF;
  END IF;
  IF NEW."storageLocationId" IS NOT NULL THEN
    SELECT s."operationalLocationId" INTO storage_node_id
    FROM "StorageLocation" s WHERE s."id" = NEW."storageLocationId";
    IF storage_node_id IS DISTINCT FROM NEW."inventoryNodeId" THEN
      RAISE EXCEPTION 'Inventory-node balance bin is not at its declared node';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."productId" IS DISTINCT FROM OLD."productId" OR
       NEW."inventoryLotId" IS DISTINCT FROM OLD."inventoryLotId" OR
       NEW."inventoryOwnerLocationId" IS DISTINCT FROM OLD."inventoryOwnerLocationId" OR
       NEW."inventoryNodeId" IS DISTINCT FROM OLD."inventoryNodeId" OR
       NEW."containerId" IS DISTINCT FROM OLD."containerId" OR
       NEW."storageLocationId" IS DISTINCT FROM OLD."storageLocationId" THEN
      RAISE EXCEPTION 'Inventory-node balance identity is immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 OR NEW."ledgerSequence" < OLD."ledgerSequence" THEN
      RAISE EXCEPTION 'Inventory-node balance update requires monotonic ledger/version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_node_balance_validate
BEFORE INSERT OR UPDATE ON "InventoryNodeBalance"
FOR EACH ROW EXECUTE FUNCTION validate_inventory_node_balance();

CREATE FUNCTION reject_inventory_node_balance_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" l
    WHERE l."inventoryNodeBalanceId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'Referenced inventory-node balance cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_node_balance_delete_guard
BEFORE DELETE ON "InventoryNodeBalance"
FOR EACH ROW EXECUTE FUNCTION reject_inventory_node_balance_delete();

CREATE FUNCTION validate_walking_inventory_reservation_line() RETURNS trigger AS $$
DECLARE
  write_enabled BOOLEAN;
  reservation_status "WalkingInventoryReservationStatus";
  reservation_expires_at TIMESTAMP(3);
  reservation_correlation_id VARCHAR(120);
  delivery_location_id UUID;
  balance_product_id UUID;
  balance_lot_id UUID;
  balance_owner_id UUID;
  balance_node_id UUID;
  balance_container_id UUID;
  balance_storage_id UUID;
  balance_available DECIMAL(18, 3);
  balance_reserved DECIMAL(18, 3);
  container_code VARCHAR(16);
  storage_code TEXT;
  ledger_idempotency_key TEXT;
  ledger_sequence BIGINT;
BEGIN
  SELECT "enabled" INTO write_enabled FROM "FeatureFlag"
  WHERE "key" = 'local_delivery_v4.inventory_reservation_writes';
  IF write_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Local-delivery v4 inventory reservation writes are disabled';
  END IF;

  SELECT r."status", r."expiresAt", r."correlationId", r."deliveryLocationId"
  INTO reservation_status, reservation_expires_at, reservation_correlation_id,
       delivery_location_id
  FROM "WalkingInventoryReservation" r WHERE r."id" = NEW."reservationId"
  FOR UPDATE;
  IF reservation_status IS DISTINCT FROM 'HELD' OR reservation_expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Inventory lines require an active HELD reservation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" l
    WHERE l."id" = NEW."id" OR
          (l."reservationId" = NEW."reservationId" AND
           l."lineNumber" = NEW."lineNumber")
  ) THEN
    RAISE EXCEPTION 'Duplicate inventory reservation line replay rejected before stock mutation';
  END IF;

  SELECT
    b."productId", b."inventoryLotId", b."inventoryOwnerLocationId",
    b."inventoryNodeId", b."containerId", b."storageLocationId", b."available",
    b."reserved"
  INTO
    balance_product_id, balance_lot_id, balance_owner_id,
    balance_node_id, balance_container_id, balance_storage_id, balance_available,
    balance_reserved
  FROM "InventoryNodeBalance" b
  WHERE b."id" = NEW."inventoryNodeBalanceId"
  FOR UPDATE;
  IF balance_product_id IS NULL OR
     balance_product_id IS DISTINCT FROM NEW."productId" OR
     balance_lot_id IS DISTINCT FROM NEW."inventoryLotId" OR
     balance_owner_id IS DISTINCT FROM NEW."inventoryOwnerLocationId" OR
     balance_node_id IS DISTINCT FROM NEW."inventoryNodeId" OR
     balance_container_id IS DISTINCT FROM NEW."containerId" OR
     balance_storage_id IS DISTINCT FROM NEW."storageLocationId" THEN
    RAISE EXCEPTION 'Reservation line does not match its certified inventory-node balance';
  END IF;

  IF NEW."containerId" IS NOT NULL THEN
    SELECT c."code" INTO container_code FROM "Container" c
    WHERE c."id" = NEW."containerId" AND c."currentLocationId" = NEW."inventoryNodeId";
    IF container_code IS NULL THEN
      RAISE EXCEPTION 'Inventory box does not belong to the physical inventory node';
    END IF;
  END IF;
  IF NEW."storageLocationId" IS NOT NULL THEN
    SELECT s."code" INTO storage_code FROM "StorageLocation" s
    WHERE s."id" = NEW."storageLocationId"
      AND s."operationalLocationId" = NEW."inventoryNodeId";
    IF storage_code IS NULL THEN
      RAISE EXCEPTION 'Inventory bin does not belong to the physical inventory node';
    END IF;
  END IF;
  NEW."warehouseBoxId" := container_code;
  NEW."binId" := storage_code;

  IF NEW."quantity" > balance_available THEN
    RAISE EXCEPTION 'Inventory reservation would oversubscribe certified physical stock';
  END IF;

  ledger_idempotency_key :=
    'walking-v4:reservation-line:' || NEW."id"::TEXT || ':reserved';
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId",
    "containerId", "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId",
    "toStorageLocationId", "businessReferenceType", "businessReferenceId",
    "correlationId", "metadata", "occurredAt"
  ) VALUES (
    md5(ledger_idempotency_key)::UUID, 'RESERVED', ledger_idempotency_key,
    NEW."productId", NEW."inventoryLotId", NEW."containerId", NEW."quantity",
    'AVAILABLE_ONLINE', 'RESERVED', NEW."inventoryNodeId", NEW."inventoryNodeId",
    NEW."storageLocationId", NEW."storageLocationId",
    'WalkingInventoryReservationLine', NEW."id"::TEXT,
    reservation_correlation_id,
    jsonb_build_object(
      'reservationId', NEW."reservationId",
      'inventoryNodeBalanceId', NEW."inventoryNodeBalanceId",
      'availableBefore', balance_available,
      'availableAfter', balance_available - NEW."quantity",
      'reservedBefore', balance_reserved,
      'reservedAfter', balance_reserved + NEW."quantity"
    ),
    NEW."createdAt"
  )
  RETURNING "sequence" INTO ledger_sequence;

  UPDATE "InventoryNodeBalance"
  SET
    "available" = "available" - NEW."quantity",
    "reserved" = "reserved" + NEW."quantity",
    "ledgerSequence" = ledger_sequence,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."inventoryNodeBalanceId";

  IF NEW."inventoryNodeId" IS DISTINCT FROM delivery_location_id AND
     NEW."transferStatus" NOT IN ('TRANSFER_REQUIRED', 'REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'READY') THEN
    RAISE EXCEPTION 'Inventory outside the delivery store must be marked for transfer';
  END IF;
  IF NEW."inventoryNodeId" = delivery_location_id AND
     NEW."transferStatus" NOT IN ('NOT_REQUIRED', 'READY') THEN
    RAISE EXCEPTION 'Inventory already at the delivery store cannot require transfer';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_inventory_reservation_line_validate
BEFORE INSERT ON "WalkingInventoryReservationLine"
FOR EACH ROW EXECUTE FUNCTION validate_walking_inventory_reservation_line();

CREATE FUNCTION reject_walking_inventory_reservation_line_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Inventory reservation lines are immutable allocation evidence';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_inventory_reservation_line_no_update
BEFORE UPDATE ON "WalkingInventoryReservationLine"
FOR EACH ROW EXECUTE FUNCTION reject_walking_inventory_reservation_line_mutation();
CREATE TRIGGER walking_inventory_reservation_line_no_delete
BEFORE DELETE ON "WalkingInventoryReservationLine"
FOR EACH ROW EXECUTE FUNCTION reject_walking_inventory_reservation_line_mutation();

CREATE OR REPLACE FUNCTION validate_fee_policy_calculation_version() RETURNS trigger AS $$
DECLARE
  calculation_status "DeliveryPolicyStatus";
  calculation_effective_from TIMESTAMP(3);
  calculation_effective_to TIMESTAMP(3);
  calculation_policy_code VARCHAR(80);
  calculation_strategy "FeeCalculationStrategy";
  calculation_routing_profile VARCHAR(32);
BEGIN
  IF NEW."calculationPolicyVersionId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."serviceScope" <> 'GENERAL_LOCAL_DELIVERY' OR
     NEW."baseFeeCents" IS NOT NULL OR NEW."rateRules" IS NOT NULL OR
     NEW."exceptions" IS NOT NULL THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy cannot contain legacy fee rules';
  END IF;

  SELECT v."status", v."effectiveFrom", v."effectiveTo",
         p."code", v."strategy", v."routingProfile"
  INTO calculation_status, calculation_effective_from, calculation_effective_to,
       calculation_policy_code, calculation_strategy, calculation_routing_profile
  FROM "FeeCalculationPolicyVersion" v
  JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
  WHERE v."id" = NEW."calculationPolicyVersionId";

  IF calculation_status IS NULL THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy calculation version does not exist';
  END IF;
  IF calculation_policy_code NOT IN (
       'WALKING_ROUTE_DISTANCE_STANDARD',
       'WALKING_ROUTE_DISTANCE_V4_BASE_10'
     ) OR calculation_strategy <> 'WALKING_ROUTE_DISTANCE' OR
     calculation_routing_profile <> 'walking' THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy requires an approved route-distance identity';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND (
    calculation_status <> 'PUBLISHED' OR NEW."effectiveFrom" IS NULL OR
    calculation_effective_from IS NULL OR
    calculation_effective_from > NEW."effectiveFrom" OR
    (calculation_effective_to IS NOT NULL AND (
      calculation_effective_to <= NEW."effectiveFrom" OR
      NEW."effectiveTo" IS NULL OR NEW."effectiveTo" > calculation_effective_to
    ))
  ) THEN
    RAISE EXCEPTION 'Published walking FeePolicy must fit its published calculation version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Exact external store identities preserve the historical publicId values.
INSERT INTO "LocalDeliveryLocationIdentity" (
  "id", "operationalLocationId", "externalLocationId", "displayName",
  "addressLine1", "city", "regionCode", "postalCode", "countryCode",
  "latitude", "longitude", "locationPriority", "active", "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8610-000000000072',
    '00000000-0000-4000-8000-000000000072',
    'third_avenue', '3rd Avenue Store', '1243 3rd Ave', 'New York', 'NY', '10021', 'US',
    40.769473514641, -73.960715741688, NULL, true,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8610-000000000086',
    '00000000-0000-4000-8000-000000000086',
    'east_86th_street', '86th Street Store', '112 E 86th St', 'New York', 'NY', '10028', 'US',
    40.779922307507, -73.956748615355, NULL, true,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

INSERT INTO "FeeCalculationPolicy" (
  "id", "code", "externalPolicyId", "name", "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8500-000000000001',
  'WALKING_ROUTE_DISTANCE_V4_BASE_10',
  'walking-route-distance-v4-base-10',
  'Local walking route-distance v4 base $10',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "FeeCalculationPolicyVersion" (
  "id", "feeCalculationPolicyId", "versionKey", "externalVersionId",
  "versionNumber", "revision", "status", "environment", "strategy",
  "currency", "routingProfile", "distanceBasis", "quoteTtlSeconds",
  "holdTtlSeconds", "preparationBufferSeconds", "handoffBufferSeconds",
  "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8510-000000000001',
  '00000000-0000-4000-8500-000000000001',
  'walking-route-distance-v4-base-10-2026-07-16',
  'walking-route-distance-v4-base-10-2026-07-16',
  1, 1, 'DRAFT', 'STAGING', 'WALKING_ROUTE_DISTANCE', 'USD', 'walking',
  'ONE_WAY_FROM_SELECTED_STORE', NULL, NULL, NULL, NULL,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "FeeCalculationTier" (
  "id", "feePolicyVersionId", "tierKey", "sequence",
  "lowerExclusiveFeet", "upperInclusiveFeet", "feeCents", "automatic",
  "reasonCode", "createdAt", "updatedAt"
)
VALUES
  ('00000000-0000-4000-8520-000000000001', '00000000-0000-4000-8510-000000000001', 'free-local', 1, NULL, 1200.00, 0, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000002', '00000000-0000-4000-8510-000000000001', 'base-delivery', 2, 1200.00, 2200.00, 1000, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000003', '00000000-0000-4000-8510-000000000001', 'extended-12', 3, 2200.00, 2700.00, 1200, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000004', '00000000-0000-4000-8510-000000000001', 'extended-14', 4, 2700.00, 2950.00, 1400, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000005', '00000000-0000-4000-8510-000000000001', 'extended-15', 5, 2950.00, 3250.00, 1500, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000006', '00000000-0000-4000-8510-000000000001', 'extended-17', 6, 3250.00, 3500.00, 1700, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000007', '00000000-0000-4000-8510-000000000001', 'extended-19', 7, 3500.00, 3750.00, 1900, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000008', '00000000-0000-4000-8510-000000000001', 'extended-21', 8, 3750.00, 4000.00, 2100, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000009', '00000000-0000-4000-8510-000000000001', 'extended-23', 9, 4000.00, 4250.00, 2300, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8520-000000000010', '00000000-0000-4000-8510-000000000001', 'whole-zone-25', 10, 4250.00, NULL, 2500, true, 'ELIGIBLE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

SET CONSTRAINTS fee_calculation_tier_partition_check IMMEDIATE;

INSERT INTO "FeePolicy" (
  "id", "policyKey", "versionNumber", "locationId", "name", "serviceScope",
  "status", "currency", "activeDays", "calculationPolicyVersionId",
  "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8100-000000000172',
    'walking-fee-third-avenue', 2,
    '00000000-0000-4000-8000-000000000072',
    'Third Avenue local walking fee v4 draft', 'GENERAL_LOCAL_DELIVERY',
    'DRAFT', 'USD', ARRAY[]::"WalkingWeekday"[],
    '00000000-0000-4000-8510-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8100-000000000186',
    'walking-fee-86th-street', 2,
    '00000000-0000-4000-8000-000000000086',
    'East 86th Street local walking fee v4 draft', 'GENERAL_LOCAL_DELIVERY',
    'DRAFT', 'USD', ARRAY[]::"WalkingWeekday"[],
    '00000000-0000-4000-8510-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

INSERT INTO "WalkingZoneSetVersion" (
  "id", "externalVersionId", "revision", "status", "environment",
  "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8600-000000000001',
  'upper-east-side-walking-zones-v1',
  1, 'DRAFT', 'STAGING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "WalkingZone" (
  "id", "slug", "name", "currentVersionNumber", "createdAt", "updatedAt"
)
VALUES
  ('20065000-0000-4000-8000-000000000001', 'local-v4-walking-10065', 'Local walking v4 draft 10065', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20021000-0000-4000-8000-000000000001', 'local-v4-walking-10021', 'Local walking v4 draft 10021', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20075000-0000-4000-8000-000000000001', 'local-v4-walking-10075', 'Local walking v4 draft 10075', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20028000-0000-4000-8000-000000000001', 'local-v4-walking-10028', 'Local walking v4 draft 10028', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20128000-0000-4000-8000-000000000001', 'local-v4-walking-10128', 'Local walking v4 draft 10128', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "WalkingZoneVersion" (
  "id", "walkingZoneId", "versionNumber", "revision", "status", "serviceMode",
  "assignmentStrategy", "postalCodes", "activeDays", "zoneSetVersionId",
  "createdAt", "updatedAt"
)
VALUES
  ('20065000-0000-4000-8000-000000000101', '20065000-0000-4000-8000-000000000001', 1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10065']::TEXT[], ARRAY[]::"WalkingWeekday"[], '00000000-0000-4000-8600-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20021000-0000-4000-8000-000000000101', '20021000-0000-4000-8000-000000000001', 1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10021']::TEXT[], ARRAY[]::"WalkingWeekday"[], '00000000-0000-4000-8600-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20075000-0000-4000-8000-000000000101', '20075000-0000-4000-8000-000000000001', 1, 1, 'DRAFT', 'WALKING', 'NEAREST_WALKING_ROUTE', ARRAY['10075']::TEXT[], ARRAY[]::"WalkingWeekday"[], '00000000-0000-4000-8600-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20028000-0000-4000-8000-000000000101', '20028000-0000-4000-8000-000000000001', 1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10028']::TEXT[], ARRAY[]::"WalkingWeekday"[], '00000000-0000-4000-8600-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20128000-0000-4000-8000-000000000101', '20128000-0000-4000-8000-000000000001', 1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10128']::TEXT[], ARRAY[]::"WalkingWeekday"[], '00000000-0000-4000-8600-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "WalkingZoneCandidate" (
  "walkingZoneVersionId", "locationId", "feePolicyId", "slotPolicyId", "createdAt"
)
VALUES
  ('20065000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8100-000000000172', '00000000-0000-4000-8200-000000000072', CURRENT_TIMESTAMP),
  ('20021000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8100-000000000172', '00000000-0000-4000-8200-000000000072', CURRENT_TIMESTAMP),
  ('20075000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8100-000000000172', '00000000-0000-4000-8200-000000000072', CURRENT_TIMESTAMP),
  ('20075000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000086', '00000000-0000-4000-8100-000000000186', '00000000-0000-4000-8200-000000000086', CURRENT_TIMESTAMP),
  ('20028000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000086', '00000000-0000-4000-8100-000000000186', '00000000-0000-4000-8200-000000000086', CURRENT_TIMESTAMP),
  ('20128000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000086', '00000000-0000-4000-8100-000000000186', '00000000-0000-4000-8200-000000000086', CURRENT_TIMESTAMP);

CREATE FUNCTION validate_walking_quote_inventory_evidence() RETURNS trigger AS $$
DECLARE
  target_quote_id UUID;
  quote_readiness "WalkingInventoryReadinessStatus";
  quote_ready_at TIMESTAMP(3);
  line_count INTEGER;
  mismatch_count INTEGER;
  latest_ready_at TIMESTAMP(3);
BEGIN
  target_quote_id := CASE
    WHEN TG_TABLE_NAME = 'WalkingDeliveryQuote' THEN NEW."id"
    WHEN TG_OP = 'DELETE' THEN OLD."quoteId"
    ELSE NEW."quoteId"
  END;
  SELECT q."inventoryReadinessStatus", q."inventoryReadyAt"
  INTO quote_readiness, quote_ready_at
  FROM "WalkingDeliveryQuote" q WHERE q."id" = target_quote_id;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE (quote_readiness = 'READY' AND l."readinessStatus" <> 'READY') OR
            (quote_readiness = 'TRANSFER_REQUIRED' AND l."readinessStatus" NOT IN ('READY', 'TRANSFER_REQUIRED')) OR
            (quote_readiness = 'NOT_READY' AND l."readinessStatus" NOT IN ('READY', 'TRANSFER_REQUIRED', 'NOT_READY')) OR
            (quote_readiness = 'UNAVAILABLE' AND l."readinessStatus" NOT IN ('READY', 'TRANSFER_REQUIRED', 'NOT_READY', 'UNAVAILABLE'))
    ),
    MAX(l."earliestReadyAt")
  INTO line_count, mismatch_count, latest_ready_at
  FROM "WalkingDeliveryQuoteInventoryLine" l
  WHERE l."quoteId" = target_quote_id;

  IF quote_readiness = 'NOT_EVALUATED' THEN
    IF line_count <> 0 OR quote_ready_at IS NOT NULL THEN
      RAISE EXCEPTION 'Unevaluated quote cannot contain inventory readiness evidence';
    END IF;
    RETURN NULL;
  END IF;
  IF line_count = 0 OR mismatch_count > 0 THEN
    RAISE EXCEPTION 'Quote inventory readiness does not match its line evidence';
  END IF;
  IF quote_readiness = 'TRANSFER_REQUIRED' AND NOT EXISTS (
    SELECT 1 FROM "WalkingDeliveryQuoteInventoryLine" l
    WHERE l."quoteId" = target_quote_id AND l."readinessStatus" = 'TRANSFER_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'TRANSFER_REQUIRED quote requires at least one transfer line';
  END IF;
  IF quote_readiness IN ('READY', 'TRANSFER_REQUIRED', 'NOT_READY') AND
     quote_ready_at IS DISTINCT FROM latest_ready_at THEN
    RAISE EXCEPTION 'Quote inventoryReadyAt must preserve the latest line readiness time';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER walking_quote_inventory_evidence_from_quote_check
AFTER INSERT ON "WalkingDeliveryQuote"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_inventory_evidence();
CREATE CONSTRAINT TRIGGER walking_quote_inventory_evidence_check
AFTER INSERT OR UPDATE OR DELETE ON "WalkingDeliveryQuoteInventoryLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_inventory_evidence();

CREATE OR REPLACE FUNCTION audit_walking_delivery_quote() RETURNS trigger AS $$
DECLARE
  location_code TEXT;
BEGIN
  SELECT "code" INTO location_code FROM "OperationalLocation"
  WHERE "id" = NEW."selectedOperationalLocationId";
  INSERT INTO "AuditEvent" (
    "id", "actorId", "action", "entityType", "entityId", "locationCode",
    "correlationId", "reason", "before", "after", "occurredAt"
  ) VALUES (
    MD5('walking-delivery-quote:' || NEW."id"::TEXT)::UUID,
    NEW."createdById", 'walking_delivery.quote.created', 'WalkingDeliveryQuote',
    NEW."id"::TEXT, location_code, NEW."correlationId", NEW."reasonCode"::TEXT,
    NULL,
    JSONB_BUILD_OBJECT(
      'schemaVersion', NEW."schemaVersion",
      'selectedLocationId', COALESCE(NEW."externalSelectedLocationId", NEW."selectedLocationId"),
      'zoneVersionId', COALESCE(NEW."externalZoneVersionId", NEW."zoneVersionId"::TEXT),
      'feePolicyVersionId', COALESCE(NEW."externalFeePolicyVersionId", NEW."feePolicyVersionId"::TEXT),
      'assignmentRule', NEW."assignmentRule", 'distanceBasis', NEW."distanceBasis",
      'tierId', NEW."tierId", 'routingProvider', NEW."routingProvider",
      'routingProfile', NEW."routingProfile", 'distanceFeet', NEW."distanceFeet",
      'durationSeconds', NEW."durationSeconds",
      'roundTripDistanceFeet', NEW."roundTripDistanceFeet",
      'estimatedRoundTripDurationSeconds', NEW."estimatedRoundTripDurationSeconds",
      'capacityRequiredSeconds', NEW."capacityRequiredSeconds",
      'feeCents', NEW."feeCents", 'currency', NEW."currency", 'bookable', NEW."bookable",
      'reasonCode', NEW."reasonCode", 'calculatedAt', NEW."calculatedAt",
      'expiresAt', NEW."expiresAt",
      'inventoryReadinessStatus', NEW."inventoryReadinessStatus"
    ), CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION audit_walking_candidate_route() RETURNS trigger AS $$
BEGIN
  INSERT INTO "AuditEvent" (
    "id", "action", "entityType", "entityId", "correlationId", "reason",
    "before", "after", "occurredAt"
  ) SELECT
    MD5('walking-candidate-route:' || NEW."id"::TEXT)::UUID,
    'walking_delivery.quote.candidate_route_recorded',
    'WalkingDeliveryQuoteCandidateRoute', NEW."id"::TEXT, q."correlationId",
    CASE WHEN NEW."selected" THEN 'SELECTED' ELSE 'CANDIDATE' END,
    NULL,
    JSONB_BUILD_OBJECT(
      'quoteId', NEW."quoteId", 'locationId', NEW."externalLocationId",
      'locationPriority', NEW."locationPriority",
      'walkingDistanceFeet', NEW."walkingDistanceFeet",
      'walkingDurationSeconds', NEW."walkingDurationSeconds",
      'routingProvider', NEW."routingProvider", 'routingProfile', NEW."routingProfile",
      'routeCalculatedAt', NEW."routeCalculatedAt", 'selected', NEW."selected"
    ), CURRENT_TIMESTAMP
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_candidate_route_audit
AFTER INSERT ON "WalkingDeliveryQuoteCandidateRoute"
FOR EACH ROW EXECUTE FUNCTION audit_walking_candidate_route();

CREATE FUNCTION audit_walking_hold_lifecycle() RETURNS trigger AS $$
DECLARE
  action_name TEXT;
BEGIN
  action_name := CASE WHEN TG_OP = 'INSERT'
    THEN 'walking_delivery.capacity_hold.created'
    ELSE 'walking_delivery.capacity_hold.' || LOWER(NEW."status"::TEXT) END;
  INSERT INTO "AuditEvent" (
    "id", "action", "entityType", "entityId", "correlationId", "reason",
    "before", "after", "occurredAt"
  ) VALUES (
    MD5('walking-capacity-hold:' || NEW."id"::TEXT || ':' || NEW."version"::TEXT)::UUID,
    action_name, 'WalkingCapacityHold', NEW."id"::TEXT, NEW."correlationId",
    COALESCE(NEW."releaseReason"::TEXT, NEW."status"::TEXT),
    CASE WHEN TG_OP = 'UPDATE' THEN JSONB_BUILD_OBJECT('status', OLD."status", 'version', OLD."version") ELSE NULL END,
    JSONB_BUILD_OBJECT(
      'quoteId', NEW."quoteId", 'capacitySlotId', NEW."capacitySlotId",
      'status', NEW."status", 'reservedCapacitySeconds', NEW."reservedCapacitySeconds",
      'expiresAt', NEW."expiresAt", 'confirmedOrderId', NEW."confirmedOrderId",
      'version', NEW."version"
    ), CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_capacity_hold_audit
AFTER INSERT OR UPDATE ON "WalkingCapacityHold"
FOR EACH ROW EXECUTE FUNCTION audit_walking_hold_lifecycle();

CREATE FUNCTION audit_walking_inventory_reservation_lifecycle() RETURNS trigger AS $$
DECLARE
  action_name TEXT;
BEGIN
  action_name := CASE WHEN TG_OP = 'INSERT'
    THEN 'walking_delivery.inventory_reservation.created'
    ELSE 'walking_delivery.inventory_reservation.' || LOWER(NEW."status"::TEXT) END;
  INSERT INTO "AuditEvent" (
    "id", "action", "entityType", "entityId", "locationCode", "correlationId",
    "reason", "before", "after", "occurredAt"
  ) SELECT
    MD5('walking-inventory-reservation:' || NEW."id"::TEXT || ':' || NEW."version"::TEXT)::UUID,
    action_name, 'WalkingInventoryReservation', NEW."id"::TEXT, l."code",
    NEW."correlationId", COALESCE(NEW."releaseReason"::TEXT, NEW."status"::TEXT),
    CASE WHEN TG_OP = 'UPDATE' THEN JSONB_BUILD_OBJECT('status', OLD."status", 'version', OLD."version") ELSE NULL END,
    JSONB_BUILD_OBJECT(
      'quoteId', NEW."quoteId", 'capacityHoldId', NEW."capacityHoldId",
      'orderLocationId', NEW."orderLocationExternalId",
      'deliveryLocationId', NEW."deliveryLocationExternalId",
      'status', NEW."status", 'expiresAt', NEW."expiresAt",
      'confirmedOrderId', NEW."confirmedOrderId", 'version', NEW."version"
    ), CURRENT_TIMESTAMP
  FROM "OperationalLocation" l WHERE l."id" = NEW."deliveryLocationId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER walking_inventory_reservation_audit
AFTER INSERT OR UPDATE ON "WalkingInventoryReservation"
FOR EACH ROW EXECUTE FUNCTION audit_walking_inventory_reservation_lifecycle();

INSERT INTO "FeatureFlag" ("key", "enabled", "description", "rules", "updatedAt")
VALUES
  (
    'local_delivery_v4.publish', false,
    'Allows audited publication of the Local Walking Delivery v4 policy and exact zone set.',
    NULL, CURRENT_TIMESTAMP
  ),
  (
    'local_delivery_v4.quote_writes', false,
    'Allows persistence of Local Walking Delivery v4 quote decisions.',
    NULL, CURRENT_TIMESTAMP
  ),
  (
    'local_delivery_v4.hold_writes', false,
    'Allows concurrency-protected Local Walking Delivery v4 capacity holds.',
    NULL, CURRENT_TIMESTAMP
  ),
  (
    'local_delivery_v4.inventory_reservation_writes', false,
    'Allows concurrency-protected Local Walking Delivery v4 inventory reservations.',
    NULL, CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO UPDATE SET
  "enabled" = false,
  "description" = EXCLUDED."description",
  "rules" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

DO $$
DECLARE
  tier_count INTEGER;
  zone_count INTEGER;
  candidate_count INTEGER;
  false_flag_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO tier_count
  FROM "FeeCalculationTier" t
  JOIN "FeeCalculationPolicyVersion" v ON v."id" = t."feePolicyVersionId"
  JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
  WHERE p."externalPolicyId" = 'walking-route-distance-v4-base-10'
    AND v."externalVersionId" = 'walking-route-distance-v4-base-10-2026-07-16'
    AND v."status" = 'DRAFT' AND v."environment" = 'STAGING'
    AND v."snapshot" IS NULL AND v."digest" IS NULL
    AND v."quoteTtlSeconds" IS NULL AND v."holdTtlSeconds" IS NULL
    AND v."preparationBufferSeconds" IS NULL AND v."handoffBufferSeconds" IS NULL;
  IF tier_count <> 10 THEN
    RAISE EXCEPTION 'Expected exact ten-tier v4 DRAFT/STAGING policy';
  END IF;

  SELECT COUNT(*) INTO zone_count
  FROM "WalkingZoneVersion" v
  JOIN "WalkingZoneSetVersion" s ON s."id" = v."zoneSetVersionId"
  WHERE s."externalVersionId" = 'upper-east-side-walking-zones-v1'
    AND s."status" = 'DRAFT' AND s."environment" = 'STAGING'
    AND v."status" = 'DRAFT' AND v."geometry" IS NULL
    AND CARDINALITY(v."activeDays") = 0
    AND v."effectiveFrom" IS NULL AND v."effectiveTo" IS NULL;
  IF zone_count <> 5 THEN
    RAISE EXCEPTION 'Expected five geometry-free v4 postal-zone drafts';
  END IF;

  SELECT COUNT(*) INTO candidate_count
  FROM "WalkingZoneCandidate" c
  JOIN "WalkingZoneVersion" v ON v."id" = c."walkingZoneVersionId"
  WHERE v."zoneSetVersionId" = '00000000-0000-4000-8600-000000000001';
  IF candidate_count <> 6 THEN
    RAISE EXCEPTION 'Expected fixed candidates plus both 10075 route candidates';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "LocalDeliveryLocationIdentity"
    WHERE "externalLocationId" IN ('third_avenue', 'east_86th_street')
      AND "locationPriority" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Location priority must remain undecided in the initial draft';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "OperationalLocation"
    WHERE "code" = 'ST72' AND "publicId" = 'store-3rd-avenue'
  ) OR NOT EXISTS (
    SELECT 1 FROM "OperationalLocation"
    WHERE "code" = 'ST86' AND "publicId" = 'store-86th-street'
  ) THEN
    RAISE EXCEPTION 'Historical store public IDs changed unexpectedly';
  END IF;

  SELECT COUNT(*) INTO false_flag_count FROM "FeatureFlag"
  WHERE "key" IN (
    'local_delivery_v4.publish',
    'local_delivery_v4.quote_writes',
    'local_delivery_v4.hold_writes',
    'local_delivery_v4.inventory_reservation_writes'
  ) AND "enabled" = false;
  IF false_flag_count <> 4 THEN
    RAISE EXCEPTION 'All Local Walking Delivery v4 gates must remain disabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "FeeCalculationPolicyPublication"
    WHERE "feePolicyVersionId" = '00000000-0000-4000-8510-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM "WalkingPublication"
    WHERE "snapshot" @> '{"externalVersionId":"upper-east-side-walking-zones-v1"}'::JSONB
  ) THEN
    RAISE EXCEPTION 'The v4 draft migration cannot create a publication';
  END IF;
END;
$$;

ALTER TABLE "WalkingZoneSetVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalDeliveryLocationIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryNodeBalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingDeliveryQuoteCandidateRoute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingDeliveryQuoteInventoryLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingCapacitySlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingCapacityHold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingInventoryReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingInventoryReservationLine" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON
      "WalkingZoneSetVersion", "LocalDeliveryLocationIdentity", "InventoryNodeBalance",
      "WalkingDeliveryQuoteCandidateRoute", "WalkingDeliveryQuoteInventoryLine",
      "WalkingCapacitySlot", "WalkingCapacityHold",
      "WalkingInventoryReservation", "WalkingInventoryReservationLine"
    FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON
      "WalkingZoneSetVersion", "LocalDeliveryLocationIdentity", "InventoryNodeBalance",
      "WalkingDeliveryQuoteCandidateRoute", "WalkingDeliveryQuoteInventoryLine",
      "WalkingCapacitySlot", "WalkingCapacityHold",
      "WalkingInventoryReservation", "WalkingInventoryReservationLine"
    FROM authenticated;
  END IF;
END;
$$;

COMMIT;
