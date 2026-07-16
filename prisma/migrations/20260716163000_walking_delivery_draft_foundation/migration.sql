-- Walking delivery and store-backed online fulfillment configuration foundation.
-- This migration creates only inactive DRAFT/DRAFT_INCOMPLETE configuration.
-- It does not publish geometry, enable online sales, or expose inventory to a storefront.

-- CreateEnum
CREATE TYPE "WalkingWeekday" AS ENUM (
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY'
);

-- CreateEnum
CREATE TYPE "WalkingAssignmentStrategy" AS ENUM ('FIXED', 'NEAREST_WALKING_ROUTE');

-- CreateEnum
CREATE TYPE "WalkingServiceMode" AS ENUM ('WALKING');

-- CreateEnum
CREATE TYPE "WalkingZoneVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DeliveryPolicyStatus" AS ENUM ('DRAFT', 'DRAFT_INCOMPLETE', 'VALIDATED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FeeServiceScope" AS ENUM ('GENERAL_LOCAL_DELIVERY', 'BALLOON_DELIVERY');

-- CreateEnum
CREATE TYPE "FulfillmentMode" AS ENUM ('PICKUP', 'WALKING_LOCAL_DELIVERY', 'WAREHOUSE_SHIPPING', 'STORE_RETRIEVAL_SHIPPING');

-- CreateEnum
CREATE TYPE "WalkingPublicationStatus" AS ENUM ('PUBLISHED', 'ARCHIVED');

-- Stable integration identity and routing metadata. Exact coordinates remain
-- nullable until they are verified; no point is inferred from an address.
ALTER TABLE "OperationalLocation"
  ADD COLUMN "publicId" VARCHAR(64),
  ADD COLUMN "addressLine1" TEXT,
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "regionCode" VARCHAR(2),
  ADD COLUMN "postalCode" VARCHAR(10),
  ADD COLUMN "countryCode" CHAR(2),
  ADD COLUMN "timeZone" VARCHAR(64),
  ADD COLUMN "latitude" DECIMAL(9, 6),
  ADD COLUMN "longitude" DECIMAL(9, 6);

CREATE UNIQUE INDEX "OperationalLocation_publicId_key"
  ON "OperationalLocation" ("publicId");

ALTER TABLE "OperationalLocation"
  ADD CONSTRAINT "OperationalLocation_public_id_format"
    CHECK ("publicId" IS NULL OR "publicId" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "OperationalLocation_coordinate_pair"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "OperationalLocation_latitude_range"
    CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "OperationalLocation_longitude_range"
    CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "OperationalLocation_region_code_format"
    CHECK ("regionCode" IS NULL OR "regionCode" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "OperationalLocation_country_code_format"
    CHECK ("countryCode" IS NULL OR "countryCode" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "OperationalLocation_time_zone_nonempty"
    CHECK ("timeZone" IS NULL OR BTRIM("timeZone") <> '');

-- CreateTable
CREATE TABLE "StoreOnlineFulfillmentPolicy" (
  "id" UUID NOT NULL,
  "policyKey" VARCHAR(80) NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "sourceLocationId" UUID NOT NULL,
  "consolidationLocationId" UUID NOT NULL,
  "status" "DeliveryPolicyStatus" NOT NULL DEFAULT 'DRAFT_INCOMPLETE',
  "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'STORE_RETRIEVAL_SHIPPING',
  "onlineSalesEnabled" BOOLEAN NOT NULL DEFAULT false,
  "availableOnlyAfterStoreActivation" BOOLEAN NOT NULL DEFAULT true,
  "addedBusinessDays" INTEGER NOT NULL DEFAULT 2,
  "timeZone" VARCHAR(64) NOT NULL,
  "pickupWeekdays" "WalkingWeekday"[] NOT NULL,
  "retrievalCutoffMinuteOfDay" INTEGER,
  "businessCalendarRef" VARCHAR(120),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "digest" VARCHAR(80),
  "createdById" UUID,
  "publishedById" UUID,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StoreOnlineFulfillmentPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreOnlinePolicy_key_format" CHECK ("policyKey" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "StoreOnlinePolicy_version_positive" CHECK ("versionNumber" > 0),
  CONSTRAINT "StoreOnlinePolicy_route_distinct" CHECK ("sourceLocationId" <> "consolidationLocationId"),
  CONSTRAINT "StoreOnlinePolicy_mode_guard" CHECK ("fulfillmentMode" = 'STORE_RETRIEVAL_SHIPPING'),
  CONSTRAINT "StoreOnlinePolicy_business_days_nonnegative" CHECK ("addedBusinessDays" >= 0),
  CONSTRAINT "StoreOnlinePolicy_activation_guard" CHECK ("availableOnlyAfterStoreActivation" = true),
  CONSTRAINT "StoreOnlinePolicy_cutoff_range" CHECK (
    "retrievalCutoffMinuteOfDay" IS NULL OR
    "retrievalCutoffMinuteOfDay" BETWEEN 0 AND 1439
  ),
  CONSTRAINT "StoreOnlinePolicy_time_zone_nonempty" CHECK (BTRIM("timeZone") <> ''),
  CONSTRAINT "StoreOnlinePolicy_effective_range" CHECK (
    "effectiveTo" IS NULL OR
    ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
  ),
  CONSTRAINT "StoreOnlinePolicy_digest_format" CHECK (
    "digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "StoreOnlinePolicy_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      CARDINALITY("pickupWeekdays") > 0 AND
      "retrievalCutoffMinuteOfDay" IS NOT NULL AND
      "businessCalendarRef" IS NOT NULL AND
      BTRIM("businessCalendarRef") <> '' AND
      "effectiveFrom" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "publishedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "StoreOnlinePolicy_online_sales_guard" CHECK (
    "onlineSalesEnabled" = false OR "status" IN ('PUBLISHED', 'ARCHIVED')
  )
);

-- CreateTable
CREATE TABLE "FeePolicy" (
  "id" UUID NOT NULL,
  "policyKey" VARCHAR(80) NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "locationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "serviceScope" "FeeServiceScope" NOT NULL,
  "status" "DeliveryPolicyStatus" NOT NULL DEFAULT 'DRAFT_INCOMPLETE',
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "baseFeeCents" INTEGER,
  "rateRules" JSONB,
  "exceptions" JSONB,
  "activeDays" "WalkingWeekday"[] NOT NULL,
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "digest" VARCHAR(80),
  "createdById" UUID,
  "publishedById" UUID,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeePolicy_key_format" CHECK ("policyKey" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "FeePolicy_version_positive" CHECK ("versionNumber" > 0),
  CONSTRAINT "FeePolicy_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "FeePolicy_base_fee_nonnegative" CHECK ("baseFeeCents" IS NULL OR "baseFeeCents" >= 0),
  CONSTRAINT "FeePolicy_effective_range" CHECK (
    "effectiveTo" IS NULL OR
    ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
  ),
  CONSTRAINT "FeePolicy_digest_format" CHECK (
    "digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "FeePolicy_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      "baseFeeCents" IS NOT NULL AND
      CARDINALITY("activeDays") > 0 AND
      "effectiveFrom" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "publishedAt" IS NOT NULL
    )
  )
);

-- CreateTable
CREATE TABLE "SlotPolicy" (
  "id" UUID NOT NULL,
  "policyKey" VARCHAR(80) NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "locationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'WALKING_LOCAL_DELIVERY',
  "status" "DeliveryPolicyStatus" NOT NULL DEFAULT 'DRAFT_INCOMPLETE',
  "activeDays" "WalkingWeekday"[] NOT NULL,
  "leadTimeMinutes" INTEGER,
  "cutoffMinuteOfDay" INTEGER,
  "capacityPolicyRef" VARCHAR(120),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "digest" VARCHAR(80),
  "createdById" UUID,
  "publishedById" UUID,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SlotPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SlotPolicy_key_format" CHECK ("policyKey" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "SlotPolicy_version_positive" CHECK ("versionNumber" > 0),
  CONSTRAINT "SlotPolicy_lead_time_nonnegative" CHECK ("leadTimeMinutes" IS NULL OR "leadTimeMinutes" >= 0),
  CONSTRAINT "SlotPolicy_cutoff_range" CHECK (
    "cutoffMinuteOfDay" IS NULL OR "cutoffMinuteOfDay" BETWEEN 0 AND 1439
  ),
  CONSTRAINT "SlotPolicy_effective_range" CHECK (
    "effectiveTo" IS NULL OR
    ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
  ),
  CONSTRAINT "SlotPolicy_digest_format" CHECK (
    "digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "SlotPolicy_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      "fulfillmentMode" = 'WALKING_LOCAL_DELIVERY' AND
      CARDINALITY("activeDays") > 0 AND
      "leadTimeMinutes" IS NOT NULL AND
      "cutoffMinuteOfDay" IS NOT NULL AND
      "capacityPolicyRef" IS NOT NULL AND
      BTRIM("capacityPolicyRef") <> '' AND
      "effectiveFrom" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "publishedAt" IS NOT NULL
    )
  )
);

-- CreateTable
CREATE TABLE "WalkingZone" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(80) NOT NULL,
  "name" TEXT NOT NULL,
  "currentVersionNumber" INTEGER NOT NULL DEFAULT 0,
  "createdById" UUID,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingZone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingZone_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "WalkingZone_current_version_nonnegative" CHECK ("currentVersionNumber" >= 0)
);

-- CreateTable
CREATE TABLE "WalkingZoneVersion" (
  "id" UUID NOT NULL,
  "walkingZoneId" UUID NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "WalkingZoneVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "serviceMode" "WalkingServiceMode" NOT NULL DEFAULT 'WALKING',
  "assignmentStrategy" "WalkingAssignmentStrategy" NOT NULL,
  "postalCodes" TEXT[] NOT NULL,
  "priority" INTEGER,
  "geometry" JSONB,
  "activeDays" "WalkingWeekday"[] NOT NULL,
  "maxDistanceMiles" DECIMAL(8, 3),
  "maxRouteMinutes" INTEGER,
  "minimumOrderCents" INTEGER,
  "snapshot" JSONB,
  "digest" VARCHAR(80),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "rollbackOfVersionId" UUID,
  "createdById" UUID,
  "publishedById" UUID,
  "validatedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WalkingZoneVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingZoneVersion_version_positive" CHECK ("versionNumber" > 0),
  CONSTRAINT "WalkingZoneVersion_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "WalkingZoneVersion_distance_nonnegative" CHECK (
    "maxDistanceMiles" IS NULL OR "maxDistanceMiles" >= 0
  ),
  CONSTRAINT "WalkingZoneVersion_route_time_nonnegative" CHECK (
    "maxRouteMinutes" IS NULL OR "maxRouteMinutes" >= 0
  ),
  CONSTRAINT "WalkingZoneVersion_minimum_order_nonnegative" CHECK (
    "minimumOrderCents" IS NULL OR "minimumOrderCents" >= 0
  ),
  CONSTRAINT "WalkingZoneVersion_geometry_shape" CHECK (
    "geometry" IS NULL OR (
      JSONB_TYPEOF("geometry") = 'object' AND
      "geometry" ->> 'type' IN ('Polygon', 'MultiPolygon')
    )
  ),
  CONSTRAINT "WalkingZoneVersion_snapshot_shape" CHECK (
    "snapshot" IS NULL OR JSONB_TYPEOF("snapshot") = 'object'
  ),
  CONSTRAINT "WalkingZoneVersion_digest_format" CHECK (
    "digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "WalkingZoneVersion_effective_range" CHECK (
    "effectiveTo" IS NULL OR
    ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
  ),
  CONSTRAINT "WalkingZoneVersion_validated_complete" CHECK (
    "status" NOT IN ('VALIDATED', 'PUBLISHED') OR (
      CARDINALITY("postalCodes") > 0 AND
      CARDINALITY("activeDays") > 0 AND
      "priority" IS NOT NULL AND
      "geometry" IS NOT NULL AND
      "snapshot" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "validatedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "WalkingZoneVersion_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      "effectiveFrom" IS NOT NULL AND
      "publishedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "WalkingZoneVersion_not_self_rollback" CHECK (
    "rollbackOfVersionId" IS NULL OR "rollbackOfVersionId" <> "id"
  )
);

-- CreateTable
CREATE TABLE "WalkingZoneCandidate" (
  "walkingZoneVersionId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "feePolicyId" UUID,
  "slotPolicyId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingZoneCandidate_pkey" PRIMARY KEY ("walkingZoneVersionId", "locationId")
);

-- CreateTable
CREATE TABLE "WalkingPublication" (
  "id" UUID NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(80) NOT NULL DEFAULT 'orderpro.walking-zones.v1',
  "status" "WalkingPublicationStatus" NOT NULL DEFAULT 'PUBLISHED',
  "snapshot" JSONB NOT NULL,
  "digest" VARCHAR(80) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "rollbackOfPublicationId" UUID,
  "publishedById" UUID,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingPublication_version_positive" CHECK ("versionNumber" > 0),
  CONSTRAINT "WalkingPublication_schema_version_nonempty" CHECK (BTRIM("schemaVersion") <> ''),
  CONSTRAINT "WalkingPublication_snapshot_shape" CHECK (JSONB_TYPEOF("snapshot") = 'object'),
  CONSTRAINT "WalkingPublication_digest_format" CHECK ("digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "WalkingPublication_effective_range" CHECK (
    "effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"
  ),
  CONSTRAINT "WalkingPublication_not_self_rollback" CHECK (
    "rollbackOfPublicationId" IS NULL OR "rollbackOfPublicationId" <> "id"
  )
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreOnlinePolicy_key_version_key"
  ON "StoreOnlineFulfillmentPolicy" ("policyKey", "versionNumber");
CREATE INDEX "StoreOnlinePolicy_source_status_idx"
  ON "StoreOnlineFulfillmentPolicy" ("sourceLocationId", "status", "effectiveFrom");
CREATE INDEX "StoreOnlinePolicy_hub_status_idx"
  ON "StoreOnlineFulfillmentPolicy" ("consolidationLocationId", "status");

CREATE UNIQUE INDEX "FeePolicy_key_version_key"
  ON "FeePolicy" ("policyKey", "versionNumber");
CREATE INDEX "FeePolicy_location_scope_status_idx"
  ON "FeePolicy" ("locationId", "serviceScope", "status", "effectiveFrom");

CREATE UNIQUE INDEX "SlotPolicy_key_version_key"
  ON "SlotPolicy" ("policyKey", "versionNumber");
CREATE INDEX "SlotPolicy_location_mode_status_idx"
  ON "SlotPolicy" ("locationId", "fulfillmentMode", "status", "effectiveFrom");

CREATE UNIQUE INDEX "WalkingZone_slug_key" ON "WalkingZone" ("slug");
CREATE INDEX "WalkingZone_archive_updated_idx" ON "WalkingZone" ("archivedAt", "updatedAt");

CREATE UNIQUE INDEX "WalkingZoneVersion_zone_version_key"
  ON "WalkingZoneVersion" ("walkingZoneId", "versionNumber");
CREATE INDEX "WalkingZoneVersion_status_effective_idx"
  ON "WalkingZoneVersion" ("status", "effectiveFrom", "effectiveTo");
CREATE INDEX "WalkingZoneVersion_digest_idx" ON "WalkingZoneVersion" ("digest");
CREATE INDEX "WalkingZoneVersion_postal_codes_gin_idx"
  ON "WalkingZoneVersion" USING GIN ("postalCodes");
CREATE UNIQUE INDEX "WalkingZoneVersion_one_working_version_idx"
  ON "WalkingZoneVersion" ("walkingZoneId")
  WHERE "status" IN ('DRAFT', 'VALIDATED');

CREATE INDEX "WalkingZoneCandidate_location_version_idx"
  ON "WalkingZoneCandidate" ("locationId", "walkingZoneVersionId");
CREATE INDEX "WalkingZoneCandidate_fee_policy_idx" ON "WalkingZoneCandidate" ("feePolicyId");
CREATE INDEX "WalkingZoneCandidate_slot_policy_idx" ON "WalkingZoneCandidate" ("slotPolicyId");

CREATE UNIQUE INDEX "WalkingPublication_version_key" ON "WalkingPublication" ("versionNumber");
CREATE INDEX "WalkingPublication_status_effective_idx"
  ON "WalkingPublication" ("status", "effectiveFrom", "effectiveTo");
CREATE INDEX "WalkingPublication_digest_idx" ON "WalkingPublication" ("digest");

-- AddForeignKey
ALTER TABLE "StoreOnlineFulfillmentPolicy"
  ADD CONSTRAINT "StoreOnlinePolicy_source_location_fkey"
    FOREIGN KEY ("sourceLocationId") REFERENCES "OperationalLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreOnlinePolicy_consolidation_location_fkey"
    FOREIGN KEY ("consolidationLocationId") REFERENCES "OperationalLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreOnlinePolicy_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreOnlinePolicy_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FeePolicy"
  ADD CONSTRAINT "FeePolicy_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "OperationalLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeePolicy_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "FeePolicy_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SlotPolicy"
  ADD CONSTRAINT "SlotPolicy_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "OperationalLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SlotPolicy_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "SlotPolicy_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WalkingZone"
  ADD CONSTRAINT "WalkingZone_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WalkingZoneVersion"
  ADD CONSTRAINT "WalkingZoneVersion_zone_fkey"
    FOREIGN KEY ("walkingZoneId") REFERENCES "WalkingZone" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneVersion_rollback_fkey"
    FOREIGN KEY ("rollbackOfVersionId") REFERENCES "WalkingZoneVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneVersion_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneVersion_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WalkingZoneCandidate"
  ADD CONSTRAINT "WalkingZoneCandidate_version_fkey"
    FOREIGN KEY ("walkingZoneVersionId") REFERENCES "WalkingZoneVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneCandidate_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "OperationalLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneCandidate_fee_policy_fkey"
    FOREIGN KEY ("feePolicyId") REFERENCES "FeePolicy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingZoneCandidate_slot_policy_fkey"
    FOREIGN KEY ("slotPolicyId") REFERENCES "SlotPolicy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalkingPublication"
  ADD CONSTRAINT "WalkingPublication_rollback_fkey"
    FOREIGN KEY ("rollbackOfPublicationId") REFERENCES "WalkingPublication" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingPublication_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Once assigned, a public integration ID cannot be renamed. A null value can
-- be populated later after the identifier has been approved.
CREATE FUNCTION protect_operational_location_public_id() RETURNS trigger AS $$
BEGIN
  IF OLD."publicId" IS NOT NULL AND NEW."publicId" IS DISTINCT FROM OLD."publicId" THEN
    RAISE EXCEPTION 'OperationalLocation publicId is immutable once assigned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operational_location_public_id_immutable
BEFORE UPDATE ON "OperationalLocation"
FOR EACH ROW EXECUTE FUNCTION protect_operational_location_public_id();

-- Store-backed shipping always starts at a store and consolidates at a
-- warehouse. Inventory ownership is deliberately not changed by this policy.
CREATE FUNCTION validate_store_online_policy_locations() RETURNS trigger AS $$
DECLARE
  source_type "LocationType";
  hub_type "LocationType";
BEGIN
  SELECT "type" INTO source_type FROM "OperationalLocation" WHERE "id" = NEW."sourceLocationId";
  SELECT "type" INTO hub_type FROM "OperationalLocation" WHERE "id" = NEW."consolidationLocationId";

  IF source_type IS DISTINCT FROM 'STORE'::"LocationType" THEN
    RAISE EXCEPTION 'StoreOnlineFulfillmentPolicy source must be a STORE';
  END IF;
  IF hub_type IS DISTINCT FROM 'WAREHOUSE'::"LocationType" THEN
    RAISE EXCEPTION 'StoreOnlineFulfillmentPolicy consolidation location must be a WAREHOUSE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_online_policy_location_types
BEFORE INSERT OR UPDATE OF "sourceLocationId", "consolidationLocationId"
ON "StoreOnlineFulfillmentPolicy"
FOR EACH ROW EXECUTE FUNCTION validate_store_online_policy_locations();

-- A candidate can reference only fee and slot policies owned by that same
-- store. This preserves per-store pricing and capacity selection.
CREATE FUNCTION validate_walking_candidate_policy_locations() RETURNS trigger AS $$
DECLARE
  fee_location UUID;
  fee_scope "FeeServiceScope";
  slot_location UUID;
  slot_mode "FulfillmentMode";
BEGIN
  IF NEW."feePolicyId" IS NOT NULL THEN
    SELECT "locationId", "serviceScope" INTO fee_location, fee_scope
    FROM "FeePolicy" WHERE "id" = NEW."feePolicyId";

    IF fee_location IS DISTINCT FROM NEW."locationId" THEN
      RAISE EXCEPTION 'Walking candidate fee policy belongs to a different location';
    END IF;
    IF fee_scope IS DISTINCT FROM 'GENERAL_LOCAL_DELIVERY'::"FeeServiceScope" THEN
      RAISE EXCEPTION 'Walking candidate requires a GENERAL_LOCAL_DELIVERY fee policy';
    END IF;
  END IF;

  IF NEW."slotPolicyId" IS NOT NULL THEN
    SELECT "locationId", "fulfillmentMode" INTO slot_location, slot_mode
    FROM "SlotPolicy" WHERE "id" = NEW."slotPolicyId";

    IF slot_location IS DISTINCT FROM NEW."locationId" THEN
      RAISE EXCEPTION 'Walking candidate slot policy belongs to a different location';
    END IF;
    IF slot_mode IS DISTINCT FROM 'WALKING_LOCAL_DELIVERY'::"FulfillmentMode" THEN
      RAISE EXCEPTION 'Walking candidate requires a WALKING_LOCAL_DELIVERY slot policy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_candidate_policy_location_check
BEFORE INSERT OR UPDATE ON "WalkingZoneCandidate"
FOR EACH ROW EXECUTE FUNCTION validate_walking_candidate_policy_locations();

-- Candidate membership is immutable once a zone version has been published
-- or archived. Rollback always creates a new version.
CREATE FUNCTION protect_walking_candidate_membership() RETURNS trigger AS $$
DECLARE
  parent_status "WalkingZoneVersionStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO parent_status
    FROM "WalkingZoneVersion"
    WHERE "id" = OLD."walkingZoneVersionId";

    IF parent_status IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published walking-zone candidates are immutable';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status" INTO parent_status
    FROM "WalkingZoneVersion"
    WHERE "id" = NEW."walkingZoneVersionId";

    IF parent_status IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published walking-zone candidates are immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_candidate_membership_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "WalkingZoneCandidate"
FOR EACH ROW EXECUTE FUNCTION protect_walking_candidate_membership();

-- Cross-row publish/validation rules that cannot be represented by CHECK.
CREATE FUNCTION validate_walking_zone_version_state() RETURNS trigger AS $$
DECLARE
  candidate_count INTEGER;
  incomplete_count INTEGER;
BEGIN
  IF NEW."rollbackOfVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "WalkingZoneVersion" prior
    WHERE prior."id" = NEW."rollbackOfVersionId"
      AND prior."walkingZoneId" = NEW."walkingZoneId"
      AND prior."status" IN ('PUBLISHED', 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'A walking-zone rollback must reference a published version of the same zone';
  END IF;

  IF NEW."status" NOT IN ('VALIDATED', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE c."feePolicyId" IS NULL OR c."slotPolicyId" IS NULL
         OR l."active" = false OR l."type" <> 'STORE' OR l."publicId" IS NULL
         OR (NEW."status" = 'VALIDATED' AND (f."status" NOT IN ('VALIDATED', 'PUBLISHED') OR s."status" NOT IN ('VALIDATED', 'PUBLISHED')))
         OR (NEW."status" = 'PUBLISHED' AND (f."status" <> 'PUBLISHED' OR s."status" <> 'PUBLISHED'))
    )
  INTO candidate_count, incomplete_count
  FROM "WalkingZoneCandidate" c
  JOIN "OperationalLocation" l ON l."id" = c."locationId"
  LEFT JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
  LEFT JOIN "SlotPolicy" s ON s."id" = c."slotPolicyId"
  WHERE c."walkingZoneVersionId" = NEW."id";

  IF NEW."assignmentStrategy" = 'FIXED' AND candidate_count <> 1 THEN
    RAISE EXCEPTION 'FIXED walking zones require exactly one candidate';
  END IF;
  IF NEW."assignmentStrategy" = 'NEAREST_WALKING_ROUTE' AND candidate_count < 2 THEN
    RAISE EXCEPTION 'NEAREST_WALKING_ROUTE requires at least two candidates';
  END IF;
  IF incomplete_count > 0 THEN
    RAISE EXCEPTION 'Walking-zone candidates require active stores and complete matching policies';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_zone_version_state_check
BEFORE INSERT OR UPDATE ON "WalkingZoneVersion"
FOR EACH ROW EXECUTE FUNCTION validate_walking_zone_version_state();

-- Publishing is impossible while its explicit production feature flag is off.
CREATE FUNCTION require_configuration_publish_flag() RETURNS trigger AS $$
DECLARE
  flag_enabled BOOLEAN;
BEGIN
  IF NEW."status"::TEXT <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status"::TEXT = 'PUBLISHED' THEN
    RETURN NEW;
  END IF;

  SELECT "enabled" INTO flag_enabled FROM "FeatureFlag" WHERE "key" = TG_ARGV[0];
  IF flag_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Publishing is disabled by feature flag %', TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_online_policy_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "StoreOnlineFulfillmentPolicy"
FOR EACH ROW EXECUTE FUNCTION require_configuration_publish_flag('store_online_fulfillment');

CREATE TRIGGER fee_policy_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "FeePolicy"
FOR EACH ROW EXECUTE FUNCTION require_configuration_publish_flag('walking_delivery.publish');

CREATE TRIGGER slot_policy_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "SlotPolicy"
FOR EACH ROW EXECUTE FUNCTION require_configuration_publish_flag('walking_delivery.publish');

CREATE TRIGGER walking_zone_version_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "WalkingZoneVersion"
FOR EACH ROW EXECUTE FUNCTION require_configuration_publish_flag('walking_delivery.publish');

CREATE TRIGGER walking_publication_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "WalkingPublication"
FOR EACH ROW EXECUTE FUNCTION require_configuration_publish_flag('walking_delivery.publish');

CREATE FUNCTION validate_walking_publication_rollback() RETURNS trigger AS $$
DECLARE
  prior_version INTEGER;
  prior_schema VARCHAR(80);
BEGIN
  IF NEW."rollbackOfPublicationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "versionNumber", "schemaVersion" INTO prior_version, prior_schema
  FROM "WalkingPublication"
  WHERE "id" = NEW."rollbackOfPublicationId";

  IF prior_version IS NULL THEN
    RAISE EXCEPTION 'Walking publication rollback target does not exist';
  END IF;
  IF prior_version >= NEW."versionNumber" THEN
    RAISE EXCEPTION 'Walking publication rollback must create a newer version';
  END IF;
  IF prior_schema IS DISTINCT FROM NEW."schemaVersion" THEN
    RAISE EXCEPTION 'Walking publication rollback must use the same schema version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_publication_rollback_check
BEFORE INSERT OR UPDATE OF "rollbackOfPublicationId", "versionNumber", "schemaVersion"
ON "WalkingPublication"
FOR EACH ROW EXECUTE FUNCTION validate_walking_publication_rollback();

-- Published configuration content is immutable. Lifecycle-only changes may
-- set effectiveTo and move PUBLISHED to ARCHIVED; archived rows are frozen.
CREATE FUNCTION protect_published_configuration() RETURNS trigger AS $$
DECLARE
  old_payload JSONB;
  new_payload JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::TEXT IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published configuration cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status"::TEXT = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Archived configuration is immutable';
  END IF;

  IF OLD."status"::TEXT = 'PUBLISHED' THEN
    IF NEW."status"::TEXT NOT IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published configuration cannot return to a draft state';
    END IF;

    old_payload := TO_JSONB(OLD) - ARRAY['status', 'effectiveTo', 'updatedAt'];
    new_payload := TO_JSONB(NEW) - ARRAY['status', 'effectiveTo', 'updatedAt'];
    IF new_payload IS DISTINCT FROM old_payload THEN
      RAISE EXCEPTION 'Published configuration content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_online_policy_published_immutable
BEFORE UPDATE OR DELETE ON "StoreOnlineFulfillmentPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();

CREATE TRIGGER fee_policy_published_immutable
BEFORE UPDATE OR DELETE ON "FeePolicy"
FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();

CREATE TRIGGER slot_policy_published_immutable
BEFORE UPDATE OR DELETE ON "SlotPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();

CREATE TRIGGER walking_zone_version_published_immutable
BEFORE UPDATE OR DELETE ON "WalkingZoneVersion"
FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();

CREATE TRIGGER walking_publication_immutable
BEFORE UPDATE OR DELETE ON "WalkingPublication"
FOR EACH ROW EXECUTE FUNCTION protect_published_configuration();

-- Canonical operational identity. ST72 is the Third Avenue store and ST86 is
-- the 86th Street store. The exact WH01 street address and coordinates remain
-- intentionally unset; only the user-confirmed Englewood, NJ locality is kept.
UPDATE "OperationalLocation"
SET
  "publicId" = 'store-3rd-avenue',
  "name" = '3rd Avenue Store',
  "addressLine1" = '1243 3rd Ave',
  "city" = 'New York',
  "regionCode" = 'NY',
  "postalCode" = '10021',
  "countryCode" = 'US',
  "timeZone" = 'America/New_York',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'ST72';

UPDATE "OperationalLocation"
SET
  "publicId" = 'store-86th-street',
  "name" = '86th Street Store',
  "addressLine1" = '112 E 86th St',
  "city" = 'New York',
  "regionCode" = 'NY',
  "postalCode" = '10028',
  "countryCode" = 'US',
  "timeZone" = 'America/New_York',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'ST86';

UPDATE "OperationalLocation"
SET
  "publicId" = 'warehouse-englewood',
  "name" = 'Englewood Warehouse',
  "city" = 'Englewood',
  "regionCode" = 'NJ',
  "countryCode" = 'US',
  "timeZone" = 'America/New_York',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'WH01';

-- Store-backed online shipping policies encode the confirmed +2 business-day
-- retrieval lead time. They remain incomplete and online sales remain off
-- until pickup weekdays, cutoff, and a business calendar are approved.
INSERT INTO "StoreOnlineFulfillmentPolicy" (
  "id", "policyKey", "versionNumber", "sourceLocationId", "consolidationLocationId",
  "status", "fulfillmentMode", "onlineSalesEnabled", "availableOnlyAfterStoreActivation",
  "addedBusinessDays", "timeZone", "pickupWeekdays", "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8300-000000000072',
    'store-3rd-avenue-online-via-wh01',
    1,
    '00000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8000-000000000101',
    'DRAFT_INCOMPLETE',
    'STORE_RETRIEVAL_SHIPPING',
    false,
    true,
    2,
    'America/New_York',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8300-000000000086',
    'store-86th-street-online-via-wh01',
    1,
    '00000000-0000-4000-8000-000000000086',
    '00000000-0000-4000-8000-000000000101',
    'DRAFT_INCOMPLETE',
    'STORE_RETRIEVAL_SHIPPING',
    false,
    true,
    2,
    'America/New_York',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

-- These are empty GENERAL_LOCAL_DELIVERY policy shells, not the unconfirmed
-- balloon pricing table. No fee is assumed and neither policy can publish.
INSERT INTO "FeePolicy" (
  "id", "policyKey", "versionNumber", "locationId", "name", "serviceScope",
  "status", "currency", "activeDays", "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8100-000000000072',
    'walking-fee-third-avenue',
    1,
    '00000000-0000-4000-8000-000000000072',
    'Third Avenue general walking-delivery fee',
    'GENERAL_LOCAL_DELIVERY',
    'DRAFT_INCOMPLETE',
    'USD',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8100-000000000086',
    'walking-fee-86th-street',
    1,
    '00000000-0000-4000-8000-000000000086',
    '86th Street general walking-delivery fee',
    'GENERAL_LOCAL_DELIVERY',
    'DRAFT_INCOMPLETE',
    'USD',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

-- Slot policy shells contain no invented hours, cutoffs, or capacity.
INSERT INTO "SlotPolicy" (
  "id", "policyKey", "versionNumber", "locationId", "name", "fulfillmentMode",
  "status", "activeDays", "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8200-000000000072',
    'walking-slots-third-avenue',
    1,
    '00000000-0000-4000-8000-000000000072',
    'Third Avenue walking-delivery slots',
    'WALKING_LOCAL_DELIVERY',
    'DRAFT_INCOMPLETE',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8200-000000000086',
    'walking-slots-86th-street',
    1,
    '00000000-0000-4000-8000-000000000086',
    '86th Street walking-delivery slots',
    'WALKING_LOCAL_DELIVERY',
    'DRAFT_INCOMPLETE',
    ARRAY[]::"WalkingWeekday"[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

-- Stable zone identities and deliberately incomplete first drafts. Assignment
-- rules and candidate stores are confirmed; priority, geometry, service days,
-- distance/time limits, and commercial policies remain unset.
INSERT INTO "WalkingZone" (
  "id", "slug", "name", "currentVersionNumber", "createdAt", "updatedAt"
)
VALUES
  ('10065000-0000-4000-8000-000000000001', 'walking-10065', 'Walking delivery 10065', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('10021000-0000-4000-8000-000000000001', 'walking-10021', 'Walking delivery 10021', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('10075000-0000-4000-8000-000000000001', 'walking-10075', 'Walking delivery 10075', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('10028000-0000-4000-8000-000000000001', 'walking-10028', 'Walking delivery 10028', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('10128000-0000-4000-8000-000000000001', 'walking-10128', 'Walking delivery 10128', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "WalkingZoneVersion" (
  "id", "walkingZoneId", "versionNumber", "revision", "status", "serviceMode",
  "assignmentStrategy", "postalCodes", "activeDays", "createdAt", "updatedAt"
)
VALUES
  (
    '10065000-0000-4000-8000-000000000101',
    '10065000-0000-4000-8000-000000000001',
    1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10065']::TEXT[],
    ARRAY[]::"WalkingWeekday"[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '10021000-0000-4000-8000-000000000101',
    '10021000-0000-4000-8000-000000000001',
    1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10021']::TEXT[],
    ARRAY[]::"WalkingWeekday"[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '10075000-0000-4000-8000-000000000101',
    '10075000-0000-4000-8000-000000000001',
    1, 1, 'DRAFT', 'WALKING', 'NEAREST_WALKING_ROUTE', ARRAY['10075']::TEXT[],
    ARRAY[]::"WalkingWeekday"[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '10028000-0000-4000-8000-000000000101',
    '10028000-0000-4000-8000-000000000001',
    1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10028']::TEXT[],
    ARRAY[]::"WalkingWeekday"[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '10128000-0000-4000-8000-000000000101',
    '10128000-0000-4000-8000-000000000001',
    1, 1, 'DRAFT', 'WALKING', 'FIXED', ARRAY['10128']::TEXT[],
    ARRAY[]::"WalkingWeekday"[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

INSERT INTO "WalkingZoneCandidate" (
  "walkingZoneVersionId", "locationId", "feePolicyId", "slotPolicyId", "createdAt"
)
VALUES
  (
    '10065000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8100-000000000072',
    '00000000-0000-4000-8200-000000000072',
    CURRENT_TIMESTAMP
  ),
  (
    '10021000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8100-000000000072',
    '00000000-0000-4000-8200-000000000072',
    CURRENT_TIMESTAMP
  ),
  (
    '10075000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8100-000000000072',
    '00000000-0000-4000-8200-000000000072',
    CURRENT_TIMESTAMP
  ),
  (
    '10075000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000086',
    '00000000-0000-4000-8100-000000000086',
    '00000000-0000-4000-8200-000000000086',
    CURRENT_TIMESTAMP
  ),
  (
    '10028000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000086',
    '00000000-0000-4000-8100-000000000086',
    '00000000-0000-4000-8200-000000000086',
    CURRENT_TIMESTAMP
  ),
  (
    '10128000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000086',
    '00000000-0000-4000-8100-000000000086',
    '00000000-0000-4000-8200-000000000086',
    CURRENT_TIMESTAMP
  );

-- Draft administration is the only enabled capability. Publication, store
-- online fulfillment, and existing inventory/storefront mutations remain off.
INSERT INTO "FeatureFlag" ("key", "enabled", "description", "rules", "updatedAt")
VALUES
  (
    'walking_delivery.admin',
    true,
    'Allows administrative editing and validation of walking-delivery drafts.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_delivery.publish',
    false,
    'Allows an explicitly authorized walking-delivery publication command.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'store_online_fulfillment',
    false,
    'Allows store-backed online availability and retrieval through WH01.',
    NULL,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO NOTHING;

-- Supabase hardening must be applied explicitly to tables created after the
-- foundation migration. Trusted Prisma connections remain server-side only.
ALTER TABLE "StoreOnlineFulfillmentPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SlotPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingZone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingZoneVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingZoneCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingPublication" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "StoreOnlineFulfillmentPolicy", "FeePolicy", "SlotPolicy",
      "WalkingZone", "WalkingZoneVersion", "WalkingZoneCandidate", "WalkingPublication" FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "StoreOnlineFulfillmentPolicy", "FeePolicy", "SlotPolicy",
      "WalkingZone", "WalkingZoneVersion", "WalkingZoneCandidate", "WalkingPublication" FROM authenticated;
  END IF;
END;
$$;
