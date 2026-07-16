-- Versioned walking-route pricing and immutable walking-delivery quotes.
-- This migration seeds only DRAFT/STAGING calibration data. It does not
-- publish a fee policy, enable quote writes, or expose quote PII to clients.

BEGIN;

-- CreateEnum
CREATE TYPE "FeeCalculationStrategy" AS ENUM ('WALKING_ROUTE_DISTANCE');

-- CreateEnum
CREATE TYPE "FeePolicyEnvironment" AS ENUM ('STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "WalkingQuoteReasonCode" AS ENUM (
  'INVALID_INPUT',
  'INVALID_ADDRESS',
  'GEOCODING_FAILED',
  'AMBIGUOUS_ADDRESS',
  'OUTSIDE_WALKING_ZONE',
  'NO_ACTIVE_ZONE',
  'SERVICE_DAY_UNAVAILABLE',
  'INVALID_ZONE_CONFIGURATION',
  'STORE_NOT_AVAILABLE',
  'ROUTE_METRICS_REQUIRED',
  'DISTANCE_EXCEEDED',
  'ROUTE_TIME_EXCEEDED',
  'MINIMUM_ORDER_NOT_MET',
  'FEE_POLICY_INCOMPLETE',
  'SLOT_POLICY_INCOMPLETE',
  'NO_AVAILABLE_SLOTS',
  'ELIGIBLE',
  'MANAGER_REVIEW'
);

-- The per-location FeePolicy remains the location-facing policy shell. Its
-- optional calculation version points both stores at one shared standard.
ALTER TABLE "FeePolicy"
  ADD COLUMN "calculationPolicyVersionId" UUID;

-- A GENERAL_LOCAL_DELIVERY shell may delegate its amount calculation to the
-- versioned standard. Legacy fee policies still require baseFeeCents.
ALTER TABLE "FeePolicy"
  DROP CONSTRAINT "FeePolicy_published_complete",
  ADD CONSTRAINT "FeePolicy_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      CARDINALITY("activeDays") > 0 AND
      "effectiveFrom" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "publishedAt" IS NOT NULL AND
      (
        (
          "calculationPolicyVersionId" IS NULL AND
          "baseFeeCents" IS NOT NULL
        ) OR (
          "calculationPolicyVersionId" IS NOT NULL AND
          "serviceScope" = 'GENERAL_LOCAL_DELIVERY' AND
          "baseFeeCents" IS NULL AND
          "rateRules" IS NULL AND
          "exceptions" IS NULL
        )
      )
    )
  );

-- CreateTable
CREATE TABLE "FeeCalculationPolicy" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" TEXT NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FeeCalculationPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeCalculationPolicy_code_format"
    CHECK ("code" ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  CONSTRAINT "FeeCalculationPolicy_name_nonempty"
    CHECK (BTRIM("name") <> '')
);

-- CreateTable
CREATE TABLE "FeeCalculationPolicyVersion" (
  "id" UUID NOT NULL,
  "feeCalculationPolicyId" UUID NOT NULL,
  "versionKey" VARCHAR(80) NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "DeliveryPolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "environment" "FeePolicyEnvironment" NOT NULL DEFAULT 'STAGING',
  "strategy" "FeeCalculationStrategy" NOT NULL DEFAULT 'WALKING_ROUTE_DISTANCE',
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "routingProfile" VARCHAR(32) NOT NULL DEFAULT 'walking',
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

  CONSTRAINT "FeeCalculationPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeCalculationVersion_key_format"
    CHECK ("versionKey" ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  CONSTRAINT "FeeCalculationVersion_number_positive"
    CHECK ("versionNumber" > 0),
  CONSTRAINT "FeeCalculationVersion_revision_positive"
    CHECK ("revision" > 0),
  CONSTRAINT "FeeCalculationVersion_currency_guard"
    CHECK ("currency" = 'USD'),
  CONSTRAINT "FeeCalculationVersion_routing_profile_guard"
    CHECK ("routingProfile" = 'walking'),
  CONSTRAINT "FeeCalculationVersion_snapshot_shape"
    CHECK ("snapshot" IS NULL OR JSONB_TYPEOF("snapshot") = 'object'),
  CONSTRAINT "FeeCalculationVersion_digest_format"
    CHECK ("digest" IS NULL OR "digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "FeeCalculationVersion_effective_range"
    CHECK (
      "effectiveTo" IS NULL OR
      ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
    ),
  CONSTRAINT "FeeCalculationVersion_validated_complete"
    CHECK (
      "status" NOT IN ('VALIDATED', 'PUBLISHED', 'ARCHIVED') OR (
        "snapshot" IS NOT NULL AND
        "digest" IS NOT NULL AND
        "validatedAt" IS NOT NULL
      )
    ),
  CONSTRAINT "FeeCalculationVersion_published_complete"
    CHECK (
      "status" NOT IN ('PUBLISHED', 'ARCHIVED') OR (
        "effectiveFrom" IS NOT NULL AND
        "publishedAt" IS NOT NULL
      )
    )
);

-- CreateTable
CREATE TABLE "FeeCalculationTier" (
  "id" UUID NOT NULL,
  "feePolicyVersionId" UUID NOT NULL,
  "tierKey" VARCHAR(80) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "lowerExclusiveFeet" DECIMAL(12, 2),
  "upperInclusiveFeet" DECIMAL(12, 2),
  "feeCents" INTEGER,
  "automatic" BOOLEAN NOT NULL,
  "reasonCode" "WalkingQuoteReasonCode" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FeeCalculationTier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeCalculationTier_key_format"
    CHECK ("tierKey" ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
  CONSTRAINT "FeeCalculationTier_sequence_positive"
    CHECK ("sequence" > 0),
  CONSTRAINT "FeeCalculationTier_lower_nonnegative"
    CHECK ("lowerExclusiveFeet" IS NULL OR "lowerExclusiveFeet" >= 0),
  CONSTRAINT "FeeCalculationTier_upper_nonnegative"
    CHECK ("upperInclusiveFeet" IS NULL OR "upperInclusiveFeet" >= 0),
  CONSTRAINT "FeeCalculationTier_bounds_ordered"
    CHECK (
      "lowerExclusiveFeet" IS NULL OR
      "upperInclusiveFeet" IS NULL OR
      "upperInclusiveFeet" > "lowerExclusiveFeet"
    ),
  CONSTRAINT "FeeCalculationTier_resolution_consistent"
    CHECK (
      (
        "automatic" = true AND
        "feeCents" IS NOT NULL AND
        "feeCents" >= 0 AND
        "reasonCode" = 'ELIGIBLE'
      ) OR (
        "automatic" = false AND
        "feeCents" IS NULL AND
        "reasonCode" = 'MANAGER_REVIEW'
      )
    )
);

-- CreateTable
CREATE TABLE "FeeCalculationPolicyPublication" (
  "id" UUID NOT NULL,
  "feeCalculationPolicyId" UUID NOT NULL,
  "feePolicyVersionId" UUID NOT NULL,
  "publicationNumber" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(100) NOT NULL DEFAULT 'orderpro.walking-route-distance-fee.v1',
  "status" "WalkingPublicationStatus" NOT NULL DEFAULT 'PUBLISHED',
  "snapshot" JSONB NOT NULL,
  "digest" VARCHAR(80) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "rollbackOfPublicationId" UUID,
  "publishedById" UUID,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FeeCalculationPolicyPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeCalculationPublication_number_positive"
    CHECK ("publicationNumber" > 0),
  CONSTRAINT "FeeCalculationPublication_schema_nonempty"
    CHECK (BTRIM("schemaVersion") <> ''),
  CONSTRAINT "FeeCalculationPublication_snapshot_shape"
    CHECK (JSONB_TYPEOF("snapshot") = 'object'),
  CONSTRAINT "FeeCalculationPublication_digest_format"
    CHECK ("digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "FeeCalculationPublication_effective_range"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "FeeCalculationPublication_not_self_rollback"
    CHECK ("rollbackOfPublicationId" IS NULL OR "rollbackOfPublicationId" <> "id")
);

-- CreateTable
CREATE TABLE "WalkingDeliveryQuote" (
  "id" UUID NOT NULL,
  "schemaVersion" VARCHAR(100) NOT NULL DEFAULT 'orderpro.walking-delivery-quote.v1',
  "clientId" VARCHAR(120) NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "requestHash" VARCHAR(80) NOT NULL,
  "normalizedAddress" TEXT,
  "customerCoordinates" JSONB,
  "postalCode" VARCHAR(10),
  "selectedLocationId" VARCHAR(64),
  "selectedOperationalLocationId" UUID,
  "zoneVersionId" UUID,
  "feePolicyVersionId" UUID,
  "routingProvider" VARCHAR(80),
  "routingProfile" VARCHAR(32) NOT NULL DEFAULT 'walking',
  "distanceFeet" DECIMAL(12, 2),
  "durationSeconds" INTEGER,
  "feeCents" INTEGER,
  "tierId" UUID,
  "reasonCode" "WalkingQuoteReasonCode" NOT NULL,
  "calculatedAt" TIMESTAMP(3) NOT NULL,
  "feePolicySnapshot" JSONB,
  "tierSnapshot" JSONB,
  "slotPolicyId" UUID,
  "slotSnapshot" JSONB,
  "walkingPublicationId" UUID,
  "correlationId" VARCHAR(120) NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalkingDeliveryQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalkingDeliveryQuote_schema_nonempty"
    CHECK (BTRIM("schemaVersion") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_client_nonempty"
    CHECK (BTRIM("clientId") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_idempotency_nonempty"
    CHECK (BTRIM("idempotencyKey") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_request_hash_format"
    CHECK ("requestHash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "WalkingDeliveryQuote_normalized_address_nonempty"
    CHECK ("normalizedAddress" IS NULL OR BTRIM("normalizedAddress") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_coordinates_shape"
    CHECK (
      "customerCoordinates" IS NULL OR
      CASE
        WHEN JSONB_TYPEOF("customerCoordinates") = 'array' THEN
          CASE
            WHEN JSONB_ARRAY_LENGTH("customerCoordinates") = 2 THEN
              CASE
                WHEN JSONB_TYPEOF("customerCoordinates" -> 0) = 'number' AND
                     JSONB_TYPEOF("customerCoordinates" -> 1) = 'number'
                THEN
                  ("customerCoordinates" ->> 0)::NUMERIC BETWEEN -180 AND 180 AND
                  ("customerCoordinates" ->> 1)::NUMERIC BETWEEN -90 AND 90
                ELSE false
              END
            ELSE false
          END
        ELSE false
      END
    ),
  CONSTRAINT "WalkingDeliveryQuote_postal_code_format"
    CHECK ("postalCode" IS NULL OR "postalCode" ~ '^[0-9]{5}$'),
  CONSTRAINT "WalkingDeliveryQuote_location_id_format"
    CHECK (
      "selectedLocationId" IS NULL OR
      "selectedLocationId" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ),
  CONSTRAINT "WalkingDeliveryQuote_routing_provider_nonempty"
    CHECK ("routingProvider" IS NULL OR BTRIM("routingProvider") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_routing_profile_guard"
    CHECK ("routingProfile" = 'walking'),
  CONSTRAINT "WalkingDeliveryQuote_distance_nonnegative"
    CHECK ("distanceFeet" IS NULL OR "distanceFeet" >= 0),
  CONSTRAINT "WalkingDeliveryQuote_duration_nonnegative"
    CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0),
  CONSTRAINT "WalkingDeliveryQuote_fee_nonnegative"
    CHECK ("feeCents" IS NULL OR "feeCents" >= 0),
  CONSTRAINT "WalkingDeliveryQuote_fee_outcome_guard"
    CHECK (
      "reasonCode" IN ('ELIGIBLE', 'NO_AVAILABLE_SLOTS') OR
      "feeCents" IS NULL
    ),
  CONSTRAINT "WalkingDeliveryQuote_nonpricing_outcome_guard"
    CHECK (
      "reasonCode" IN ('ELIGIBLE', 'NO_AVAILABLE_SLOTS', 'MANAGER_REVIEW') OR (
        "tierId" IS NULL AND
        "tierSnapshot" IS NULL AND
        "feeCents" IS NULL AND
        "slotPolicyId" IS NULL AND
        "slotSnapshot" IS NULL
      )
    ),
  CONSTRAINT "WalkingDeliveryQuote_preroute_outcome_guard"
    CHECK (
      "reasonCode" NOT IN (
        'INVALID_INPUT',
        'INVALID_ADDRESS',
        'GEOCODING_FAILED',
        'AMBIGUOUS_ADDRESS',
        'OUTSIDE_WALKING_ZONE',
        'NO_ACTIVE_ZONE',
        'SERVICE_DAY_UNAVAILABLE',
        'INVALID_ZONE_CONFIGURATION',
        'ROUTE_METRICS_REQUIRED'
      ) OR (
        "routingProvider" IS NULL AND
        "distanceFeet" IS NULL AND
        "durationSeconds" IS NULL
      )
    ),
  CONSTRAINT "WalkingDeliveryQuote_preselection_outcome_guard"
    CHECK (
      "reasonCode" NOT IN (
        'INVALID_INPUT',
        'INVALID_ADDRESS',
        'GEOCODING_FAILED',
        'AMBIGUOUS_ADDRESS',
        'OUTSIDE_WALKING_ZONE',
        'NO_ACTIVE_ZONE',
        'SERVICE_DAY_UNAVAILABLE',
        'INVALID_ZONE_CONFIGURATION'
      ) OR (
        "selectedLocationId" IS NULL AND
        "selectedOperationalLocationId" IS NULL AND
        "zoneVersionId" IS NULL AND
        "walkingPublicationId" IS NULL
      )
    ),
  CONSTRAINT "WalkingDeliveryQuote_fee_snapshot_shape"
    CHECK (
      "feePolicySnapshot" IS NULL OR
      JSONB_TYPEOF("feePolicySnapshot") = 'object'
    ),
  CONSTRAINT "WalkingDeliveryQuote_tier_snapshot_shape"
    CHECK ("tierSnapshot" IS NULL OR JSONB_TYPEOF("tierSnapshot") = 'object'),
  CONSTRAINT "WalkingDeliveryQuote_slot_snapshot_shape"
    CHECK ("slotSnapshot" IS NULL OR JSONB_TYPEOF("slotSnapshot") = 'object'),
  CONSTRAINT "WalkingDeliveryQuote_correlation_nonempty"
    CHECK (BTRIM("correlationId") <> ''),
  CONSTRAINT "WalkingDeliveryQuote_location_pair_consistent"
    CHECK (
      ("selectedOperationalLocationId" IS NULL OR "selectedLocationId" IS NOT NULL) AND
      ("selectedLocationId" IS NULL OR "zoneVersionId" IS NOT NULL)
    ),
  CONSTRAINT "WalkingDeliveryQuote_route_metrics_consistent"
    CHECK (
      ("distanceFeet" IS NULL) = ("durationSeconds" IS NULL) AND
      ("distanceFeet" IS NULL OR "routingProvider" IS NOT NULL)
    ),
  CONSTRAINT "WalkingDeliveryQuote_fee_version_snapshot_consistent"
    CHECK (
      ("feePolicyVersionId" IS NULL) = ("feePolicySnapshot" IS NULL)
    ),
  CONSTRAINT "WalkingDeliveryQuote_tier_snapshot_consistent"
    CHECK (
      ("tierId" IS NULL) = ("tierSnapshot" IS NULL) AND
      ("tierId" IS NULL OR (
        "feePolicyVersionId" IS NOT NULL AND "distanceFeet" IS NOT NULL
      )) AND
      ("feeCents" IS NULL OR "tierId" IS NOT NULL)
    ),
  CONSTRAINT "WalkingDeliveryQuote_slot_snapshot_consistent"
    CHECK (
      ("slotPolicyId" IS NULL) = ("slotSnapshot" IS NULL) AND
      ("slotPolicyId" IS NULL OR (
        "selectedLocationId" IS NOT NULL AND "tierId" IS NOT NULL
      ))
    ),
  CONSTRAINT "WalkingDeliveryQuote_publication_zone_consistent"
    CHECK (
      "walkingPublicationId" IS NULL OR "zoneVersionId" IS NOT NULL
    ),
  CONSTRAINT "WalkingDeliveryQuote_eligible_complete"
    CHECK (
      "reasonCode" <> 'ELIGIBLE' OR (
        "normalizedAddress" IS NOT NULL AND
        "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND
        "selectedLocationId" IS NOT NULL AND
        "zoneVersionId" IS NOT NULL AND
        "feePolicyVersionId" IS NOT NULL AND
        "routingProvider" IS NOT NULL AND
        "distanceFeet" IS NOT NULL AND
        "durationSeconds" IS NOT NULL AND
        "feeCents" IS NOT NULL AND
        "tierId" IS NOT NULL AND
        "slotPolicyId" IS NOT NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    ),
  CONSTRAINT "WalkingDeliveryQuote_no_slots_complete"
    CHECK (
      "reasonCode" <> 'NO_AVAILABLE_SLOTS' OR (
        "normalizedAddress" IS NOT NULL AND
        "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND
        "selectedLocationId" IS NOT NULL AND
        "zoneVersionId" IS NOT NULL AND
        "feePolicyVersionId" IS NOT NULL AND
        "routingProvider" IS NOT NULL AND
        "distanceFeet" IS NOT NULL AND
        "durationSeconds" IS NOT NULL AND
        "feeCents" IS NOT NULL AND
        "tierId" IS NOT NULL AND
        "slotPolicyId" IS NOT NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    ),
  CONSTRAINT "WalkingDeliveryQuote_manager_review_complete"
    CHECK (
      "reasonCode" <> 'MANAGER_REVIEW' OR (
        "normalizedAddress" IS NOT NULL AND
        "customerCoordinates" IS NOT NULL AND
        "postalCode" IS NOT NULL AND
        "selectedLocationId" IS NOT NULL AND
        "zoneVersionId" IS NOT NULL AND
        "feePolicyVersionId" IS NOT NULL AND
        "routingProvider" IS NOT NULL AND
        "distanceFeet" IS NOT NULL AND
        "durationSeconds" IS NOT NULL AND
        "feeCents" IS NULL AND
        "tierId" IS NOT NULL AND
        "slotPolicyId" IS NULL AND
        "walkingPublicationId" IS NOT NULL
      )
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeCalculationPolicy_code_key"
  ON "FeeCalculationPolicy" ("code");
CREATE INDEX "FeeCalculationPolicy_updated_idx"
  ON "FeeCalculationPolicy" ("updatedAt");

CREATE UNIQUE INDEX "FeeCalculationVersion_policy_number_key"
  ON "FeeCalculationPolicyVersion" ("feeCalculationPolicyId", "versionNumber");
CREATE UNIQUE INDEX "FeeCalculationVersion_policy_key_key"
  ON "FeeCalculationPolicyVersion" ("feeCalculationPolicyId", "versionKey");
CREATE INDEX "FeeCalculationVersion_status_environment_idx"
  ON "FeeCalculationPolicyVersion" ("status", "environment", "effectiveFrom");
CREATE INDEX "FeeCalculationVersion_digest_idx"
  ON "FeeCalculationPolicyVersion" ("digest");

CREATE UNIQUE INDEX "FeeCalculationTier_version_key_key"
  ON "FeeCalculationTier" ("feePolicyVersionId", "tierKey");
CREATE UNIQUE INDEX "FeeCalculationTier_version_sequence_key"
  ON "FeeCalculationTier" ("feePolicyVersionId", "sequence");
CREATE INDEX "FeeCalculationTier_bounds_idx"
  ON "FeeCalculationTier" (
    "feePolicyVersionId",
    "lowerExclusiveFeet",
    "upperInclusiveFeet"
  );

CREATE UNIQUE INDEX "FeeCalculationPublication_policy_number_key"
  ON "FeeCalculationPolicyPublication" (
    "feeCalculationPolicyId",
    "publicationNumber"
  );
CREATE INDEX "FeeCalculationPublication_version_idx"
  ON "FeeCalculationPolicyPublication" ("feePolicyVersionId");
CREATE INDEX "FeeCalculationPublication_status_effective_idx"
  ON "FeeCalculationPolicyPublication" ("status", "effectiveFrom", "effectiveTo");
CREATE INDEX "FeeCalculationPublication_digest_idx"
  ON "FeeCalculationPolicyPublication" ("digest");
CREATE UNIQUE INDEX "FeeCalculationPublication_one_active_idx"
  ON "FeeCalculationPolicyPublication" ("feeCalculationPolicyId")
  WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "WalkingDeliveryQuote_client_idempotency_key"
  ON "WalkingDeliveryQuote" ("clientId", "idempotencyKey");
CREATE INDEX "WalkingDeliveryQuote_location_calculated_idx"
  ON "WalkingDeliveryQuote" ("selectedLocationId", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_operational_location_idx"
  ON "WalkingDeliveryQuote" ("selectedOperationalLocationId");
CREATE INDEX "WalkingDeliveryQuote_zone_calculated_idx"
  ON "WalkingDeliveryQuote" ("zoneVersionId", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_fee_version_calculated_idx"
  ON "WalkingDeliveryQuote" ("feePolicyVersionId", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_postal_calculated_idx"
  ON "WalkingDeliveryQuote" ("postalCode", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_reason_calculated_idx"
  ON "WalkingDeliveryQuote" ("reasonCode", "calculatedAt");
CREATE INDEX "WalkingDeliveryQuote_correlation_idx"
  ON "WalkingDeliveryQuote" ("correlationId");
CREATE INDEX "WalkingDeliveryQuote_request_hash_idx"
  ON "WalkingDeliveryQuote" ("requestHash");

CREATE INDEX "FeePolicy_calculation_version_idx"
  ON "FeePolicy" ("calculationPolicyVersionId");

-- AddForeignKey
ALTER TABLE "FeeCalculationPolicy"
  ADD CONSTRAINT "FeeCalculationPolicy_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FeeCalculationPolicyVersion"
  ADD CONSTRAINT "FeeCalculationVersion_policy_fkey"
    FOREIGN KEY ("feeCalculationPolicyId") REFERENCES "FeeCalculationPolicy" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeeCalculationVersion_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeeCalculationVersion_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FeeCalculationTier"
  ADD CONSTRAINT "FeeCalculationTier_version_fkey"
    FOREIGN KEY ("feePolicyVersionId") REFERENCES "FeeCalculationPolicyVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FeeCalculationPolicyPublication"
  ADD CONSTRAINT "FeeCalculationPublication_policy_fkey"
    FOREIGN KEY ("feeCalculationPolicyId") REFERENCES "FeeCalculationPolicy" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeeCalculationPublication_version_fkey"
    FOREIGN KEY ("feePolicyVersionId") REFERENCES "FeeCalculationPolicyVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeeCalculationPublication_rollback_fkey"
    FOREIGN KEY ("rollbackOfPublicationId") REFERENCES "FeeCalculationPolicyPublication" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FeeCalculationPublication_published_by_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FeePolicy"
  ADD CONSTRAINT "FeePolicy_calculation_version_fkey"
    FOREIGN KEY ("calculationPolicyVersionId") REFERENCES "FeeCalculationPolicyVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalkingDeliveryQuote"
  ADD CONSTRAINT "WalkingDeliveryQuote_location_fkey"
    FOREIGN KEY ("selectedOperationalLocationId") REFERENCES "OperationalLocation" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_zone_version_fkey"
    FOREIGN KEY ("zoneVersionId") REFERENCES "WalkingZoneVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_fee_version_fkey"
    FOREIGN KEY ("feePolicyVersionId") REFERENCES "FeeCalculationPolicyVersion" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_tier_fkey"
    FOREIGN KEY ("tierId") REFERENCES "FeeCalculationTier" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_slot_policy_fkey"
    FOREIGN KEY ("slotPolicyId") REFERENCES "SlotPolicy" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_publication_fkey"
    FOREIGN KEY ("walkingPublicationId") REFERENCES "WalkingPublication" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WalkingDeliveryQuote_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;

-- Delegated per-location shells cannot mix the versioned standard with legacy
-- base/rule payloads. Publication additionally requires an effective published
-- calculation version, making later zone publication reachable but explicit.
CREATE FUNCTION validate_fee_policy_calculation_version() RETURNS trigger AS $$
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
     NEW."baseFeeCents" IS NOT NULL OR
     NEW."rateRules" IS NOT NULL OR
     NEW."exceptions" IS NOT NULL THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy cannot contain legacy fee rules';
  END IF;

  SELECT
    v."status", v."effectiveFrom", v."effectiveTo",
    p."code", v."strategy", v."routingProfile"
  INTO
    calculation_status, calculation_effective_from, calculation_effective_to,
    calculation_policy_code, calculation_strategy, calculation_routing_profile
  FROM "FeeCalculationPolicyVersion" v
  JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
  WHERE v."id" = NEW."calculationPolicyVersionId";

  IF calculation_status IS NULL THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy calculation version does not exist';
  END IF;

  IF calculation_policy_code <> 'WALKING_ROUTE_DISTANCE_STANDARD' OR
     calculation_strategy <> 'WALKING_ROUTE_DISTANCE' OR
     calculation_routing_profile <> 'walking' THEN
    RAISE EXCEPTION 'Delegated walking FeePolicy requires the route-distance standard';
  END IF;

  IF NEW."status" = 'PUBLISHED' AND (
    calculation_status <> 'PUBLISHED' OR
    NEW."effectiveFrom" IS NULL OR
    calculation_effective_from IS NULL OR
    calculation_effective_from > NEW."effectiveFrom" OR
    (
      calculation_effective_to IS NOT NULL AND
      (
        calculation_effective_to <= NEW."effectiveFrom" OR
        NEW."effectiveTo" IS NULL OR
        NEW."effectiveTo" > calculation_effective_to
      )
    )
  ) THEN
    RAISE EXCEPTION 'Published walking FeePolicy must remain within an effective published calculation version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_policy_calculation_version_check
BEFORE INSERT OR UPDATE ON "FeePolicy"
FOR EACH ROW EXECUTE FUNCTION validate_fee_policy_calculation_version();

-- A calculation-version lifecycle change cannot invalidate a published
-- per-location shell. Operators must close/archive dependent shells first.
CREATE FUNCTION protect_published_fee_policy_calculation_references() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FeePolicy" f
    WHERE f."calculationPolicyVersionId" = NEW."id"
      AND f."status" = 'PUBLISHED'
      AND (
        NEW."status" <> 'PUBLISHED' OR
        NEW."effectiveFrom" IS NULL OR
        f."effectiveFrom" IS NULL OR
        NEW."effectiveFrom" > f."effectiveFrom" OR
        (
          NEW."effectiveTo" IS NOT NULL AND
          (
            f."effectiveTo" IS NULL OR
            f."effectiveTo" > NEW."effectiveTo"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Calculation-version lifecycle would invalidate a published FeePolicy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_version_fee_policy_reference_guard
BEFORE UPDATE ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION protect_published_fee_policy_calculation_references();

-- The stable policy code is an integration contract. A display name may be
-- corrected, but a code change requires a new policy identity.
CREATE FUNCTION protect_fee_calculation_policy_code() RETURNS trigger AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'Fee-calculation policy code is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_policy_code_immutable
BEFORE UPDATE OF "code" ON "FeeCalculationPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_fee_calculation_policy_code();

-- Route-distance tiers must form one contiguous partition: the first begins
-- at zero, automatic tiers have finite upper bounds, and the final open-ended
-- tier always routes to manager review. The deferred check permits replacing
-- a draft tier set atomically in one transaction.
CREATE FUNCTION validate_fee_calculation_tier_partition() RETURNS trigger AS $$
DECLARE
  version_id UUID;
  tier_count INTEGER;
  violation_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."feePolicyVersionId";
  ELSE
    version_id := NEW."feePolicyVersionId";
  END IF;

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
         OR (position = total AND "automatic" = true)
         OR (position = total AND "reasonCode" <> 'MANAGER_REVIEW')
    )
  INTO tier_count, violation_count
  FROM ordered;

  IF tier_count = 0 OR violation_count > 0 THEN
    RAISE EXCEPTION
      'Fee-calculation tiers must be contiguous and end in open manager review';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER fee_calculation_tier_partition_check
AFTER INSERT OR UPDATE OR DELETE ON "FeeCalculationTier"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_fee_calculation_tier_partition();

-- Once any quote references a version, its pricing inputs are frozen. Quotes
-- retain snapshots as defense in depth, while new calibration requires a new
-- explicit version instead of mutating history.
CREATE FUNCTION protect_fee_calculation_tier() RETURNS trigger AS $$
DECLARE
  version_id UUID;
  parent_status "DeliveryPolicyStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."feePolicyVersionId";
  ELSE
    version_id := NEW."feePolicyVersionId";
  END IF;

  IF TG_OP = 'UPDATE' AND
     NEW."feePolicyVersionId" IS DISTINCT FROM OLD."feePolicyVersionId" THEN
    RAISE EXCEPTION 'A fee-calculation tier cannot move between versions';
  END IF;

  SELECT "status" INTO parent_status
  FROM "FeeCalculationPolicyVersion"
  WHERE "id" = version_id;

  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'Fee-calculation tier parent version does not exist';
  END IF;
  IF parent_status IN ('VALIDATED', 'PUBLISHED', 'ARCHIVED') THEN
    RAISE EXCEPTION 'Validated fee-calculation tiers are immutable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "WalkingDeliveryQuote"
    WHERE "feePolicyVersionId" = version_id
  ) THEN
    RAISE EXCEPTION 'A quoted fee-calculation version is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_tier_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "FeeCalculationTier"
FOR EACH ROW EXECUTE FUNCTION protect_fee_calculation_tier();

-- Canonical JSON equivalent to the application serializer: object keys sort,
-- arrays preserve order, and no insignificant whitespace enters the digest.
CREATE FUNCTION canonical_fee_policy_json(value JSONB) RETURNS TEXT AS $$
DECLARE
  value_type TEXT;
BEGIN
  value_type := JSONB_TYPEOF(value);

  IF value_type IN ('null', 'boolean', 'string') THEN
    RETURN value::TEXT;
  ELSIF value_type = 'number' THEN
    -- PostgreSQL NUMERIC preserves display scale (for example 1200.00), while
    -- JSON.stringify emits the shortest decimal representation (1200). The
    -- policy snapshot only contains bounded decimal/integer columns, so
    -- removing insignificant fractional zeroes keeps both canonicalizers in
    -- lockstep without losing precision.
    RETURN TRIM_SCALE((value #>> '{}')::NUMERIC)::TEXT;
  ELSIF value_type = 'array' THEN
    RETURN '[' || COALESCE((
      SELECT STRING_AGG(
        canonical_fee_policy_json(element),
        ',' ORDER BY ordinal
      )
      FROM JSONB_ARRAY_ELEMENTS(value) WITH ORDINALITY AS item(element, ordinal)
    ), '') || ']';
  ELSIF value_type = 'object' THEN
    RETURN '{' || COALESCE((
      SELECT STRING_AGG(
        TO_JSONB(entry_key)::TEXT || ':' || canonical_fee_policy_json(entry_value),
        ',' ORDER BY entry_key COLLATE "C"
      )
      FROM JSONB_EACH(value) AS item(entry_key, entry_value)
    ), '') || '}';
  END IF;

  RAISE EXCEPTION 'Unsupported fee-policy JSON value';
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Validated and published versions must already have a complete tier set.
CREATE FUNCTION validate_fee_calculation_version_state() RETURNS trigger AS $$
DECLARE
  tier_count INTEGER;
  manager_tier_count INTEGER;
  standard_mismatch_count INTEGER;
  parent_policy_code VARCHAR(80);
  canonical_snapshot JSONB;
  expected_digest TEXT;
BEGIN
  IF NEW."status" = 'ARCHIVED' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'A fee-calculation version can archive only from PUBLISHED';
    END IF;
    IF OLD."status" IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'A fee-calculation version can archive only from PUBLISHED';
    END IF;
  END IF;

  IF NEW."status" NOT IN ('VALIDATED', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE "automatic" = false
        AND "reasonCode" = 'MANAGER_REVIEW'
        AND "upperInclusiveFeet" IS NULL
    )
  INTO tier_count, manager_tier_count
  FROM "FeeCalculationTier"
  WHERE "feePolicyVersionId" = NEW."id";

  IF tier_count = 0 OR manager_tier_count <> 1 THEN
    RAISE EXCEPTION 'Validated fee-calculation versions require complete tiers';
  END IF;

  SELECT p."code" INTO parent_policy_code
  FROM "FeeCalculationPolicy" p
  WHERE p."id" = NEW."feeCalculationPolicyId";

  IF parent_policy_code = 'WALKING_ROUTE_DISTANCE_STANDARD' THEN
    SELECT COUNT(*) INTO standard_mismatch_count
    FROM "FeeCalculationTier" t
    WHERE t."feePolicyVersionId" = NEW."id"
      AND NOT (
        (
          t."sequence" = 1 AND t."tierKey" = 'UP_TO_1200_FT' AND
          t."lowerExclusiveFeet" IS NULL AND t."upperInclusiveFeet" = 1200.00 AND
          t."feeCents" = 0 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE'
        ) OR (
          t."sequence" = 2 AND t."tierKey" = 'UP_TO_2300_FT' AND
          t."lowerExclusiveFeet" = 1200.00 AND t."upperInclusiveFeet" = 2300.00 AND
          t."feeCents" = 1000 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE'
        ) OR (
          t."sequence" = 3 AND t."tierKey" = 'UP_TO_3250_FT' AND
          t."lowerExclusiveFeet" = 2300.00 AND t."upperInclusiveFeet" = 3250.00 AND
          t."feeCents" = 1500 AND t."automatic" = true AND t."reasonCode" = 'ELIGIBLE'
        ) OR (
          t."sequence" = 4 AND t."tierKey" = 'OVER_3250_FT_MANAGER_REVIEW' AND
          t."lowerExclusiveFeet" = 3250.00 AND t."upperInclusiveFeet" IS NULL AND
          t."feeCents" IS NULL AND t."automatic" = false AND
          t."reasonCode" = 'MANAGER_REVIEW'
        )
      );

    IF tier_count <> 4 OR standard_mismatch_count <> 0 THEN
      RAISE EXCEPTION 'WALKING_ROUTE_DISTANCE_STANDARD tiers do not match the approved matrix';
    END IF;
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
      SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'id', t."id",
          'tierKey', t."tierKey",
          'sequence', t."sequence",
          'lowerExclusiveFeet', t."lowerExclusiveFeet",
          'upperInclusiveFeet', t."upperInclusiveFeet",
          'feeCents', t."feeCents",
          'automatic', t."automatic",
          'reasonCode', t."reasonCode"
        ) ORDER BY t."sequence"
      )
      FROM "FeeCalculationTier" t
      WHERE t."feePolicyVersionId" = NEW."id"
    ), '[]'::JSONB)
  )
  INTO canonical_snapshot;

  IF NEW."snapshot" IS DISTINCT FROM canonical_snapshot THEN
    RAISE EXCEPTION 'Fee-calculation snapshot does not match its version and tiers';
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

CREATE TRIGGER fee_calculation_version_state_check
BEFORE INSERT OR UPDATE ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION validate_fee_calculation_version_state();

-- Published configuration content is immutable. A published version may only
-- receive lifecycle changes (effectiveTo and PUBLISHED -> ARCHIVED). Before
-- publication, versions already used by quotes freeze their pricing identity.
CREATE FUNCTION protect_fee_calculation_version() RETURNS trigger AS $$
DECLARE
  old_payload JSONB;
  new_payload JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published fee-calculation versions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Archived fee-calculation versions are immutable';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'Published fee-calculation versions cannot return to draft';
    END IF;

    old_payload := TO_JSONB(OLD) - ARRAY['status', 'effectiveTo', 'updatedAt'];
    new_payload := TO_JSONB(NEW) - ARRAY['status', 'effectiveTo', 'updatedAt'];
    IF new_payload IS DISTINCT FROM old_payload THEN
      RAISE EXCEPTION 'Published fee-calculation version content is immutable';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "WalkingDeliveryQuote"
    WHERE "feePolicyVersionId" = OLD."id"
  ) THEN
    old_payload := TO_JSONB(OLD) - ARRAY[
      'status', 'environment', 'snapshot', 'digest', 'effectiveFrom',
      'effectiveTo', 'publishedById', 'validatedAt', 'publishedAt', 'updatedAt'
    ];
    new_payload := TO_JSONB(NEW) - ARRAY[
      'status', 'environment', 'snapshot', 'digest', 'effectiveFrom',
      'effectiveTo', 'publishedById', 'validatedAt', 'publishedAt', 'updatedAt'
    ];
    IF new_payload IS DISTINCT FROM old_payload THEN
      RAISE EXCEPTION 'Quoted fee-calculation version identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_version_immutable
BEFORE UPDATE OR DELETE ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION protect_fee_calculation_version();

-- STAGING publication is explicitly available for Owner-approved calibration;
-- PRODUCTION uses a separate disabled gate and therefore remains locked.
CREATE FUNCTION require_fee_calculation_version_publish_flag() RETURNS trigger AS $$
DECLARE
  flag_key TEXT;
  flag_enabled BOOLEAN;
BEGIN
  IF NEW."status" <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'PUBLISHED' THEN
      RETURN NEW;
    END IF;
  END IF;

  flag_key := CASE NEW."environment"
    WHEN 'STAGING' THEN 'walking_fee_policy.staging_publish'
    ELSE 'walking_fee_policy.publish'
  END;

  SELECT "enabled" INTO flag_enabled
  FROM "FeatureFlag"
  WHERE "key" = flag_key;

  IF flag_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Fee-calculation publication is disabled by feature flag %', flag_key;
  END IF;
  IF NEW."publishedById" IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "UserRole" ur
    JOIN "User" u ON u."id" = ur."userId"
    WHERE ur."userId" = NEW."publishedById"
      AND ur."role" = 'OWNER'
      AND u."active" = true
  ) THEN
    RAISE EXCEPTION 'Fee-calculation publication requires Owner approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_version_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "FeeCalculationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION require_fee_calculation_version_publish_flag();

CREATE FUNCTION require_fee_calculation_publication_flag() RETURNS trigger AS $$
DECLARE
  version_environment "FeePolicyEnvironment";
  flag_key TEXT;
  flag_enabled BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'PUBLISHED' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."status" <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;

  SELECT "environment" INTO version_environment
  FROM "FeeCalculationPolicyVersion"
  WHERE "id" = NEW."feePolicyVersionId";

  flag_key := CASE version_environment
    WHEN 'STAGING' THEN 'walking_fee_policy.staging_publish'
    ELSE 'walking_fee_policy.publish'
  END;

  SELECT "enabled" INTO flag_enabled
  FROM "FeatureFlag"
  WHERE "key" = flag_key;

  IF flag_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Fee-calculation publication is disabled by feature flag %', flag_key;
  END IF;
  IF NEW."publishedById" IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "UserRole" ur
    JOIN "User" u ON u."id" = ur."userId"
    WHERE ur."userId" = NEW."publishedById"
      AND ur."role" = 'OWNER'
      AND u."active" = true
  ) THEN
    RAISE EXCEPTION 'Fee-calculation publication requires Owner approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_publication_publish_flag
BEFORE INSERT OR UPDATE OF "status" ON "FeeCalculationPolicyPublication"
FOR EACH ROW EXECUTE FUNCTION require_fee_calculation_publication_flag();

-- A publication must be an exact immutable projection of a PUBLISHED version.
CREATE FUNCTION validate_fee_calculation_publication() RETURNS trigger AS $$
DECLARE
  version_policy_id UUID;
  version_status "DeliveryPolicyStatus";
  version_environment "FeePolicyEnvironment";
  version_snapshot JSONB;
  version_digest VARCHAR(80);
  prior_policy_id UUID;
  prior_publication_number INTEGER;
  prior_schema_version VARCHAR(100);
BEGIN
  IF TG_OP = 'INSERT' AND NEW."status" <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'A fee-calculation publication must start PUBLISHED';
  END IF;

  SELECT
    "feeCalculationPolicyId", "status", "environment", "snapshot", "digest"
  INTO
    version_policy_id, version_status, version_environment,
    version_snapshot, version_digest
  FROM "FeeCalculationPolicyVersion"
  WHERE "id" = NEW."feePolicyVersionId";

  IF version_policy_id IS NULL THEN
    RAISE EXCEPTION 'Fee-calculation publication version does not exist';
  END IF;
  IF version_policy_id IS DISTINCT FROM NEW."feeCalculationPolicyId" THEN
    RAISE EXCEPTION 'Fee-calculation publication policy/version mismatch';
  END IF;
  IF version_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'Only a PUBLISHED fee version can be published';
  END IF;
  IF NEW."snapshot" IS DISTINCT FROM version_snapshot OR
     NEW."digest" IS DISTINCT FROM version_digest THEN
    RAISE EXCEPTION 'Publication snapshot and digest must match its fee version';
  END IF;

  IF NEW."rollbackOfPublicationId" IS NOT NULL THEN
    SELECT "feeCalculationPolicyId", "publicationNumber", "schemaVersion"
    INTO prior_policy_id, prior_publication_number, prior_schema_version
    FROM "FeeCalculationPolicyPublication"
    WHERE "id" = NEW."rollbackOfPublicationId";

    IF prior_policy_id IS NULL THEN
      RAISE EXCEPTION 'Fee-calculation rollback publication does not exist';
    END IF;
    IF prior_policy_id IS DISTINCT FROM NEW."feeCalculationPolicyId" OR
       prior_publication_number >= NEW."publicationNumber" OR
       prior_schema_version IS DISTINCT FROM NEW."schemaVersion" THEN
      RAISE EXCEPTION 'Invalid fee-calculation publication rollback target';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_publication_check
BEFORE INSERT OR UPDATE ON "FeeCalculationPolicyPublication"
FOR EACH ROW EXECUTE FUNCTION validate_fee_calculation_publication();

CREATE FUNCTION protect_fee_calculation_publication() RETURNS trigger AS $$
DECLARE
  old_payload JSONB;
  new_payload JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fee-calculation publications are immutable';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Archived fee-calculation publications are immutable';
  END IF;
  IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED') THEN
    RAISE EXCEPTION 'Invalid fee-calculation publication lifecycle';
  END IF;

  old_payload := TO_JSONB(OLD) - ARRAY['status', 'effectiveTo'];
  new_payload := TO_JSONB(NEW) - ARRAY['status', 'effectiveTo'];
  IF new_payload IS DISTINCT FROM old_payload THEN
    RAISE EXCEPTION 'Fee-calculation publication content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_publication_immutable
BEFORE UPDATE OR DELETE ON "FeeCalculationPolicyPublication"
FOR EACH ROW EXECUTE FUNCTION protect_fee_calculation_publication();

-- Quote writes are independently gated from administration and publication.
-- Keeping this off permits schema/configuration review without accepting PII.
CREATE FUNCTION require_walking_quote_write_flag() RETURNS trigger AS $$
DECLARE
  flag_enabled BOOLEAN;
BEGIN
  SELECT "enabled" INTO flag_enabled
  FROM "FeatureFlag"
  WHERE "key" = 'walking_delivery.quote_writes';

  IF flag_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Walking-delivery quote writes are disabled by feature flag';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_00_write_flag
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION require_walking_quote_write_flag();

-- Resolve the stable integration location ID, validate every versioned input,
-- and replace caller-provided snapshots with canonical database projections.
CREATE FUNCTION validate_and_snapshot_walking_delivery_quote() RETURNS trigger AS $$
DECLARE
  resolved_location_id UUID;
  resolved_location_type "LocationType";
  resolved_location_active BOOLEAN;
  resolved_location_time_zone VARCHAR(64);
  zone_status "WalkingZoneVersionStatus";
  zone_effective_from TIMESTAMP(3);
  zone_effective_to TIMESTAMP(3);
  candidate_fee_version_id UUID;
  candidate_slot_policy_id UUID;
  tier_version_id UUID;
  tier_key VARCHAR(80);
  tier_sequence INTEGER;
  tier_lower DECIMAL(12, 2);
  tier_upper DECIMAL(12, 2);
  tier_fee INTEGER;
  tier_automatic BOOLEAN;
  tier_reason "WalkingQuoteReasonCode";
  version_status "DeliveryPolicyStatus";
  version_environment "FeePolicyEnvironment";
  version_strategy "FeeCalculationStrategy";
  version_routing_profile VARCHAR(32);
  version_effective_from TIMESTAMP(3);
  version_effective_to TIMESTAMP(3);
  policy_code VARCHAR(80);
  slot_policy_status "DeliveryPolicyStatus";
  slot_active_days "WalkingWeekday"[];
  slot_lead_time_minutes INTEGER;
  slot_cutoff_minute INTEGER;
  slot_capacity_ref VARCHAR(120);
  slot_effective_from TIMESTAMP(3);
  slot_effective_to TIMESTAMP(3);
  canonical_fee_snapshot JSONB;
  canonical_tier_snapshot JSONB;
  canonical_slot_policy_snapshot JSONB;
  canonical_slot_snapshot JSONB;
BEGIN
  IF NEW."selectedLocationId" IS NOT NULL THEN
    SELECT "id", "type", "active", "timeZone"
    INTO
      resolved_location_id,
      resolved_location_type,
      resolved_location_active,
      resolved_location_time_zone
    FROM "OperationalLocation"
    WHERE "publicId" = NEW."selectedLocationId";

    IF resolved_location_id IS NULL OR
       resolved_location_type <> 'STORE' OR
       resolved_location_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Selected walking-delivery location is not an active store';
    END IF;
    IF NEW."selectedOperationalLocationId" IS NOT NULL AND
       NEW."selectedOperationalLocationId" IS DISTINCT FROM resolved_location_id THEN
      RAISE EXCEPTION 'Stable and internal selected location IDs do not match';
    END IF;
    NEW."selectedOperationalLocationId" := resolved_location_id;
  ELSIF NEW."selectedOperationalLocationId" IS NOT NULL THEN
    RAISE EXCEPTION 'Internal selected location requires its stable public ID';
  END IF;

  IF NEW."zoneVersionId" IS NOT NULL THEN
    SELECT "status", "effectiveFrom", "effectiveTo"
    INTO zone_status, zone_effective_from, zone_effective_to
    FROM "WalkingZoneVersion"
    WHERE "id" = NEW."zoneVersionId"
      AND (
        NEW."postalCode" IS NULL OR
        NEW."postalCode" = ANY("postalCodes")
      );

    IF zone_status IS DISTINCT FROM 'PUBLISHED' OR
       zone_effective_from IS NULL OR
       zone_effective_from > NEW."calculatedAt" OR
       (zone_effective_to IS NOT NULL AND zone_effective_to <= NEW."calculatedAt") THEN
      RAISE EXCEPTION 'Quote walking-zone version is not published and effective';
    END IF;
  ELSIF NEW."selectedLocationId" IS NOT NULL THEN
    RAISE EXCEPTION 'A selected store requires its walking-zone version';
  END IF;

  IF NEW."selectedLocationId" IS NOT NULL THEN
    SELECT f."calculationPolicyVersionId", c."slotPolicyId"
    INTO candidate_fee_version_id, candidate_slot_policy_id
    FROM "WalkingZoneCandidate" c
    LEFT JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
    WHERE c."walkingZoneVersionId" = NEW."zoneVersionId"
      AND c."locationId" = resolved_location_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected store is not a configured candidate for the zone';
    END IF;
    IF candidate_fee_version_id IS DISTINCT FROM NEW."feePolicyVersionId" THEN
      RAISE EXCEPTION 'Selected store does not use the quoted fee version';
    END IF;
  END IF;

  IF NEW."feePolicyVersionId" IS NOT NULL THEN
    SELECT
      v."status", v."environment", v."strategy", v."routingProfile",
      v."effectiveFrom", v."effectiveTo", p."code"
    INTO
      version_status, version_environment, version_strategy,
      version_routing_profile, version_effective_from, version_effective_to,
      policy_code
    FROM "FeeCalculationPolicyVersion" v
    JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
    WHERE v."id" = NEW."feePolicyVersionId";

    IF version_status IS DISTINCT FROM 'PUBLISHED' OR
       version_effective_from IS NULL OR
       version_effective_from > NEW."calculatedAt" OR
       (version_effective_to IS NOT NULL AND version_effective_to <= NEW."calculatedAt") THEN
      RAISE EXCEPTION 'Quoted fee-calculation version is not published and effective';
    END IF;
    IF policy_code <> 'WALKING_ROUTE_DISTANCE_STANDARD' OR
       version_strategy <> 'WALKING_ROUTE_DISTANCE' OR
       version_routing_profile <> NEW."routingProfile" THEN
      RAISE EXCEPTION 'Quote does not use the walking route-distance standard';
    END IF;
  END IF;

  IF NEW."tierId" IS NOT NULL THEN
    IF NEW."feePolicyVersionId" IS NULL OR NEW."distanceFeet" IS NULL THEN
      RAISE EXCEPTION 'A selected fee tier requires its version and route distance';
    END IF;

    SELECT
      "feePolicyVersionId", "tierKey", "sequence", "lowerExclusiveFeet",
      "upperInclusiveFeet", "feeCents", "automatic", "reasonCode"
    INTO
      tier_version_id, tier_key, tier_sequence, tier_lower,
      tier_upper, tier_fee, tier_automatic, tier_reason
    FROM "FeeCalculationTier"
    WHERE "id" = NEW."tierId";

    IF tier_version_id IS NULL OR
       tier_version_id IS DISTINCT FROM NEW."feePolicyVersionId" THEN
      RAISE EXCEPTION 'Quote tier does not belong to the quoted fee version';
    END IF;
    IF (tier_lower IS NOT NULL AND NEW."distanceFeet" <= tier_lower) OR
       (tier_upper IS NOT NULL AND NEW."distanceFeet" > tier_upper) THEN
      RAISE EXCEPTION 'Walking distance does not fall within the selected tier';
    END IF;
    IF NEW."feeCents" IS NOT NULL AND NEW."feeCents" IS DISTINCT FROM tier_fee THEN
      RAISE EXCEPTION 'Quote fee does not match the selected tier';
    END IF;

    IF NEW."reasonCode" IN ('ELIGIBLE', 'NO_AVAILABLE_SLOTS') THEN
      IF tier_automatic IS DISTINCT FROM true OR
         NEW."feeCents" IS DISTINCT FROM tier_fee THEN
        RAISE EXCEPTION 'Automatic quote outcome does not match its fee tier';
      END IF;
    ELSIF NEW."reasonCode" = 'MANAGER_REVIEW' THEN
      IF tier_automatic IS DISTINCT FROM false OR
         tier_reason <> 'MANAGER_REVIEW' OR
         NEW."feeCents" IS NOT NULL THEN
        RAISE EXCEPTION 'Manager-review outcome does not match its fee tier';
      END IF;
    END IF;
  ELSIF NEW."feeCents" IS NOT NULL THEN
    RAISE EXCEPTION 'A calculated fee requires its selected tier';
  END IF;

  IF NEW."reasonCode" IN ('ELIGIBLE', 'NO_AVAILABLE_SLOTS') THEN
    IF candidate_slot_policy_id IS NULL OR
       NEW."slotPolicyId" IS DISTINCT FROM candidate_slot_policy_id THEN
      RAISE EXCEPTION 'Slot-evaluated walking quotes require the candidate slot policy';
    END IF;
    IF NEW."slotSnapshot" IS NULL OR JSONB_TYPEOF(NEW."slotSnapshot") <> 'array' THEN
      RAISE EXCEPTION 'Slot-evaluated walking quotes require a slot array';
    END IF;
    IF NEW."reasonCode" = 'ELIGIBLE' AND
       JSONB_ARRAY_LENGTH(NEW."slotSnapshot") = 0 THEN
      RAISE EXCEPTION 'Eligible walking quotes require at least one available slot';
    END IF;
    IF NEW."reasonCode" = 'NO_AVAILABLE_SLOTS' AND
       JSONB_ARRAY_LENGTH(NEW."slotSnapshot") <> 0 THEN
      RAISE EXCEPTION 'NO_AVAILABLE_SLOTS must preserve an empty slot array';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(NEW."slotSnapshot") AS requested_slot
      WHERE JSONB_TYPEOF(requested_slot) <> 'object'
         OR JSONB_TYPEOF(requested_slot -> 'slotId') IS DISTINCT FROM 'string'
         OR JSONB_TYPEOF(requested_slot -> 'locationId') IS DISTINCT FROM 'string'
         OR JSONB_TYPEOF(requested_slot -> 'startsAt') IS DISTINCT FROM 'string'
         OR JSONB_TYPEOF(requested_slot -> 'endsAt') IS DISTINCT FROM 'string'
         OR (requested_slot ->> 'locationId') IS DISTINCT FROM NEW."selectedLocationId"
         OR COALESCE(BTRIM(requested_slot ->> 'slotId'), '') = ''
         OR COALESCE(BTRIM(requested_slot ->> 'startsAt'), '') = ''
         OR COALESCE(BTRIM(requested_slot ->> 'endsAt'), '') = ''
         OR CASE
              WHEN JSONB_TYPEOF(requested_slot -> 'remainingCapacity') = 'number'
                THEN (requested_slot ->> 'remainingCapacity')::NUMERIC <= 0 OR
                     TRUNC((requested_slot ->> 'remainingCapacity')::NUMERIC) <>
                       (requested_slot ->> 'remainingCapacity')::NUMERIC
              ELSE true
            END
    ) THEN
      RAISE EXCEPTION 'Quoted slots must be valid, available, and belong to the selected store';
    END IF;
    IF (
      SELECT COUNT(*) <> COUNT(DISTINCT (requested_slot ->> 'slotId'))
      FROM JSONB_ARRAY_ELEMENTS(NEW."slotSnapshot") AS requested_slot
    ) THEN
      RAISE EXCEPTION 'Quoted slot identifiers must be unique';
    END IF;
  ELSIF NEW."slotPolicyId" IS NOT NULL OR NEW."slotSnapshot" IS NOT NULL THEN
    RAISE EXCEPTION 'Non-eligible evaluations cannot promise delivery slots';
  END IF;

  IF NEW."reasonCode" IN ('ELIGIBLE', 'NO_AVAILABLE_SLOTS', 'MANAGER_REVIEW') AND
     NEW."walkingPublicationId" IS NULL THEN
    RAISE EXCEPTION 'Resolved walking quotes require publication lineage';
  END IF;

  IF NEW."walkingPublicationId" IS NOT NULL THEN
    IF NEW."zoneVersionId" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "WalkingPublication" wp
      WHERE wp."id" = NEW."walkingPublicationId"
        AND wp."status" = 'PUBLISHED'
        AND wp."effectiveFrom" <= NEW."calculatedAt"
        AND (wp."effectiveTo" IS NULL OR wp."effectiveTo" > NEW."calculatedAt")
        AND EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            CASE
              WHEN JSONB_TYPEOF(wp."snapshot" -> 'zones') = 'array'
                THEN wp."snapshot" -> 'zones'
              ELSE '[]'::JSONB
            END
          ) AS published_zone
          WHERE (published_zone ->> 'zoneVersionId') = NEW."zoneVersionId"::TEXT
        )
    ) THEN
      RAISE EXCEPTION 'Walking publication was not effective when the quote was calculated';
    END IF;
  END IF;

  SELECT JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.walking-route-distance-fee.v1',
    'policyId', p."id",
    'policyCode', p."code",
    'versionId', v."id",
    'versionKey', v."versionKey",
    'versionNumber', v."versionNumber",
    'revision', v."revision",
    'status', v."status",
    'environment', v."environment",
    'strategy', v."strategy",
    'currency', v."currency",
    'routingProfile', v."routingProfile",
    'digest', v."digest",
    'effectiveFrom', v."effectiveFrom",
    'effectiveTo', v."effectiveTo",
    'tiers', COALESCE((
      SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'id', t."id",
          'tierKey', t."tierKey",
          'sequence', t."sequence",
          'lowerExclusiveFeet', t."lowerExclusiveFeet",
          'upperInclusiveFeet', t."upperInclusiveFeet",
          'feeCents', t."feeCents",
          'automatic', t."automatic",
          'reasonCode', t."reasonCode"
        ) ORDER BY t."sequence"
      )
      FROM "FeeCalculationTier" t
      WHERE t."feePolicyVersionId" = v."id"
    ), '[]'::JSONB)
  )
  INTO canonical_fee_snapshot
  FROM "FeeCalculationPolicyVersion" v
  JOIN "FeeCalculationPolicy" p ON p."id" = v."feeCalculationPolicyId"
  WHERE v."id" = NEW."feePolicyVersionId";

  IF NEW."tierId" IS NOT NULL THEN
    canonical_tier_snapshot := JSONB_BUILD_OBJECT(
      'id', NEW."tierId",
      'tierKey', tier_key,
      'sequence', tier_sequence,
      'lowerExclusiveFeet', tier_lower,
      'upperInclusiveFeet', tier_upper,
      'feeCents', tier_fee,
      'automatic', tier_automatic,
      'reasonCode', tier_reason
    );
  ELSE
    canonical_tier_snapshot := NULL;
  END IF;

  IF NEW."slotPolicyId" IS NOT NULL THEN
    SELECT
      s."status",
      s."activeDays",
      s."leadTimeMinutes",
      s."cutoffMinuteOfDay",
      s."capacityPolicyRef",
      s."effectiveFrom",
      s."effectiveTo",
      JSONB_BUILD_OBJECT(
        'id', s."id",
        'policyKey', s."policyKey",
        'versionNumber', s."versionNumber",
        'locationId', s."locationId",
        'fulfillmentMode', s."fulfillmentMode",
        'status', s."status",
        'activeDays', s."activeDays",
        'leadTimeMinutes', s."leadTimeMinutes",
        'cutoffMinuteOfDay', s."cutoffMinuteOfDay",
        'capacityPolicyRef', s."capacityPolicyRef",
        'effectiveFrom', s."effectiveFrom",
        'effectiveTo', s."effectiveTo",
        'digest', s."digest"
      )
    INTO
      slot_policy_status,
      slot_active_days,
      slot_lead_time_minutes,
      slot_cutoff_minute,
      slot_capacity_ref,
      slot_effective_from,
      slot_effective_to,
      canonical_slot_policy_snapshot
    FROM "SlotPolicy" s
    WHERE s."id" = NEW."slotPolicyId";

    IF canonical_slot_policy_snapshot IS NULL THEN
      RAISE EXCEPTION 'Quote slot policy does not exist';
    END IF;
    IF slot_policy_status IS DISTINCT FROM 'PUBLISHED' OR
       CARDINALITY(slot_active_days) = 0 OR
       slot_lead_time_minutes IS NULL OR
       slot_cutoff_minute IS NULL OR
       slot_capacity_ref IS NULL OR BTRIM(slot_capacity_ref) = '' OR
       resolved_location_time_zone IS NULL OR BTRIM(resolved_location_time_zone) = '' OR
       slot_effective_from IS NULL OR slot_effective_from > NEW."calculatedAt" OR
       (slot_effective_to IS NOT NULL AND slot_effective_to <= NEW."calculatedAt") THEN
      RAISE EXCEPTION 'Quote slot policy is not published, complete, and effective';
    END IF;

    BEGIN
      IF EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(NEW."slotSnapshot") AS requested_slot
        WHERE NOT ISFINITE((requested_slot ->> 'startsAt')::TIMESTAMPTZ)
           OR NOT ISFINITE((requested_slot ->> 'endsAt')::TIMESTAMPTZ)
           OR ((requested_slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') >=
                ((requested_slot ->> 'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
           OR ((requested_slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') <
                NEW."calculatedAt"
           OR ((requested_slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') <
                NEW."calculatedAt" +
                  (slot_lead_time_minutes * INTERVAL '1 minute')
           OR ((requested_slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') <
                slot_effective_from
           OR (
             slot_effective_to IS NOT NULL AND
             ((requested_slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') >=
               slot_effective_to
           )
           OR (
             slot_effective_to IS NOT NULL AND
             ((requested_slot ->> 'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') >
               slot_effective_to
           )
           OR CASE EXTRACT(
                DOW FROM (
                  (requested_slot ->> 'startsAt')::TIMESTAMPTZ
                  AT TIME ZONE resolved_location_time_zone
                )
              )::INTEGER
                WHEN 0 THEN 'SUNDAY'::"WalkingWeekday"
                WHEN 1 THEN 'MONDAY'::"WalkingWeekday"
                WHEN 2 THEN 'TUESDAY'::"WalkingWeekday"
                WHEN 3 THEN 'WEDNESDAY'::"WalkingWeekday"
                WHEN 4 THEN 'THURSDAY'::"WalkingWeekday"
                WHEN 5 THEN 'FRIDAY'::"WalkingWeekday"
                WHEN 6 THEN 'SATURDAY'::"WalkingWeekday"
              END <> ALL(slot_active_days)
      ) THEN
        RAISE EXCEPTION 'Quoted slot timestamps are outside the active slot policy';
      END IF;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
        RAISE EXCEPTION 'Quoted slot timestamps/time zone must be valid';
    END;

    canonical_slot_snapshot := JSONB_BUILD_OBJECT(
      'policy', canonical_slot_policy_snapshot,
      'slots', NEW."slotSnapshot"
    );
  ELSE
    canonical_slot_policy_snapshot := NULL;
    canonical_slot_snapshot := NULL;
  END IF;

  NEW."feePolicySnapshot" := canonical_fee_snapshot;
  NEW."tierSnapshot" := canonical_tier_snapshot;
  NEW."slotSnapshot" := canonical_slot_snapshot;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_10_consistency
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION validate_and_snapshot_walking_delivery_quote();

-- A quote is evidence of the exact decision returned to a client. Corrections
-- create a new quote and use a new idempotency key; history is never rewritten.
CREATE FUNCTION reject_walking_delivery_quote_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WalkingDeliveryQuote is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_no_update
BEFORE UPDATE ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION reject_walking_delivery_quote_mutation();

CREATE TRIGGER walking_delivery_quote_no_delete
BEFORE DELETE ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION reject_walking_delivery_quote_mutation();

-- The append-only AuditEvent receives only operational decision metadata.
-- normalizedAddress, customerCoordinates, postalCode, clientId, and
-- idempotencyKey/requestHash are deliberately excluded; no quote outbox event
-- is emitted.
CREATE FUNCTION audit_walking_delivery_quote() RETURNS trigger AS $$
DECLARE
  location_code TEXT;
BEGIN
  SELECT "code" INTO location_code
  FROM "OperationalLocation"
  WHERE "id" = NEW."selectedOperationalLocationId";

  INSERT INTO "AuditEvent" (
    "id", "actorId", "action", "entityType", "entityId", "locationCode",
    "correlationId", "reason", "before", "after", "occurredAt"
  )
  VALUES (
    MD5('walking-delivery-quote:' || NEW."id"::TEXT)::UUID,
    NEW."createdById",
    'walking_delivery.quote.created',
    'WalkingDeliveryQuote',
    NEW."id"::TEXT,
    location_code,
    NEW."correlationId",
    NEW."reasonCode"::TEXT,
    NULL,
    JSONB_BUILD_OBJECT(
      'selectedLocationId', NEW."selectedLocationId",
      'zoneVersionId', NEW."zoneVersionId",
      'feePolicyVersionId', NEW."feePolicyVersionId",
      'tierId', NEW."tierId",
      'routingProvider', NEW."routingProvider",
      'routingProfile', NEW."routingProfile",
      'distanceFeet', NEW."distanceFeet",
      'durationSeconds', NEW."durationSeconds",
      'feeCents', NEW."feeCents",
      'reasonCode', NEW."reasonCode",
      'calculatedAt', NEW."calculatedAt"
    ),
    CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_audit
AFTER INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION audit_walking_delivery_quote();

-- Fee publication events contain hashes and stable IDs only. Publication
-- snapshots contain no customer data and AuditEvent is already append-only.
CREATE FUNCTION audit_fee_calculation_publication() RETURNS trigger AS $$
BEGIN
  INSERT INTO "AuditEvent" (
    "id", "actorId", "action", "entityType", "entityId", "correlationId",
    "reason", "before", "after", "occurredAt"
  )
  VALUES (
    MD5('fee-calculation-publication:' || NEW."id"::TEXT || ':' || TG_OP || ':' ||
      TXID_CURRENT()::TEXT || ':' || CLOCK_TIMESTAMP()::TEXT)::UUID,
    NEW."publishedById",
    CASE WHEN TG_OP = 'INSERT'
      THEN 'walking_fee_policy.published'
      ELSE 'walking_fee_policy.lifecycle_changed'
    END,
    'FeeCalculationPolicyPublication',
    NEW."id"::TEXT,
    'fee-publication:' || NEW."id"::TEXT,
    NEW."status"::TEXT,
    CASE WHEN TG_OP = 'UPDATE' THEN JSONB_BUILD_OBJECT(
      'status', OLD."status",
      'effectiveTo', OLD."effectiveTo"
    ) ELSE NULL END,
    JSONB_BUILD_OBJECT(
      'feeCalculationPolicyId', NEW."feeCalculationPolicyId",
      'feePolicyVersionId', NEW."feePolicyVersionId",
      'publicationNumber', NEW."publicationNumber",
      'schemaVersion', NEW."schemaVersion",
      'status', NEW."status",
      'digest', NEW."digest",
      'effectiveFrom', NEW."effectiveFrom",
      'effectiveTo', NEW."effectiveTo",
      'rollbackOfPublicationId', NEW."rollbackOfPublicationId"
    ),
    CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_calculation_publication_audit_insert
AFTER INSERT ON "FeeCalculationPolicyPublication"
FOR EACH ROW EXECUTE FUNCTION audit_fee_calculation_publication();

CREATE TRIGGER fee_calculation_publication_audit_lifecycle
AFTER UPDATE OF "status", "effectiveTo" ON "FeeCalculationPolicyPublication"
FOR EACH ROW EXECUTE FUNCTION audit_fee_calculation_publication();

-- Seed one shared pricing identity and an editable STAGING calibration draft.
-- No FeeCalculationPolicyPublication row is created by this migration.
INSERT INTO "FeeCalculationPolicy" (
  "id", "code", "name", "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8400-000000000001',
  'WALKING_ROUTE_DISTANCE_STANDARD',
  'Walking route-distance standard',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "FeeCalculationPolicyVersion" (
  "id", "feeCalculationPolicyId", "versionKey", "versionNumber", "revision",
  "status", "environment", "strategy", "currency", "routingProfile",
  "createdAt", "updatedAt"
)
VALUES (
  '00000000-0000-4000-8410-000000000001',
  '00000000-0000-4000-8400-000000000001',
  'DRAFT_CALIBRATION_V1',
  1,
  1,
  'DRAFT',
  'STAGING',
  'WALKING_ROUTE_DISTANCE',
  'USD',
  'walking',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "FeeCalculationTier" (
  "id", "feePolicyVersionId", "tierKey", "sequence",
  "lowerExclusiveFeet", "upperInclusiveFeet", "feeCents", "automatic",
  "reasonCode", "createdAt", "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8420-000000000001',
    '00000000-0000-4000-8410-000000000001',
    'UP_TO_1200_FT',
    1,
    NULL,
    1200.00,
    0,
    true,
    'ELIGIBLE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8420-000000000002',
    '00000000-0000-4000-8410-000000000001',
    'UP_TO_2300_FT',
    2,
    1200.00,
    2300.00,
    1000,
    true,
    'ELIGIBLE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8420-000000000003',
    '00000000-0000-4000-8410-000000000001',
    'UP_TO_3250_FT',
    3,
    2300.00,
    3250.00,
    1500,
    true,
    'ELIGIBLE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8420-000000000004',
    '00000000-0000-4000-8410-000000000001',
    'OVER_3250_FT_MANAGER_REVIEW',
    4,
    3250.00,
    NULL,
    NULL,
    false,
    'MANAGER_REVIEW',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

-- Flush the deferred partition validator before later ALTER TABLE ... ENABLE
-- ROW LEVEL SECURITY statements; PostgreSQL rejects ALTER TABLE while a table
-- still has pending deferred trigger events.
SET CONSTRAINTS fee_calculation_tier_partition_check IMMEDIATE;

-- Link the existing incomplete per-store draft shells to the shared versioned
-- standard. They remain DRAFT and are not production-active or historical.
UPDATE "FeePolicy"
SET
  "status" = 'DRAFT',
  "baseFeeCents" = NULL,
  "rateRules" = NULL,
  "exceptions" = NULL,
  "effectiveFrom" = NULL,
  "effectiveTo" = NULL,
  "digest" = NULL,
  "calculationPolicyVersionId" = '00000000-0000-4000-8410-000000000001',
  "publishedById" = NULL,
  "publishedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE ("id", "policyKey", "versionNumber", "serviceScope") IN (
  (
    '00000000-0000-4000-8100-000000000072'::UUID,
    'walking-fee-third-avenue',
    1,
    'GENERAL_LOCAL_DELIVERY'::"FeeServiceScope"
  ),
  (
    '00000000-0000-4000-8100-000000000086'::UUID,
    'walking-fee-86th-street',
    1,
    'GENERAL_LOCAL_DELIVERY'::"FeeServiceScope"
  )
);

DO $$
DECLARE
  linked_policy_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO linked_policy_count
  FROM "FeePolicy"
  WHERE "id" IN (
      '00000000-0000-4000-8100-000000000072'::UUID,
      '00000000-0000-4000-8100-000000000086'::UUID
    )
    AND "versionNumber" = 1
    AND "serviceScope" = 'GENERAL_LOCAL_DELIVERY'
    AND "status" = 'DRAFT'
    AND "baseFeeCents" IS NULL
    AND "rateRules" IS NULL
    AND "exceptions" IS NULL
    AND "calculationPolicyVersionId" =
      '00000000-0000-4000-8410-000000000001';

  IF linked_policy_count <> 2 THEN
    RAISE EXCEPTION 'Expected both store walking fee policies to use the standard';
  END IF;
END;
$$;

-- Draft administration and Owner-approved STAGING publication are available.
-- PRODUCTION publication, persistence, API access, and external delivery stay
-- independently disabled until their operational dependencies are certified.
INSERT INTO "FeatureFlag" ("key", "enabled", "description", "rules", "updatedAt")
VALUES
  (
    'walking_fee_policy.admin',
    true,
    'Allows administration of versioned walking route-distance fee drafts.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_fee_policy.staging_publish',
    true,
    'Allows only Owner-approved publication of STAGING walking fee policies.',
    NULL,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO UPDATE
SET
  "enabled" = EXCLUDED."enabled",
  "description" = EXCLUDED."description",
  "rules" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "FeatureFlag" ("key", "enabled", "description", "rules", "updatedAt")
VALUES
  (
    'walking_fee_policy.publish',
    false,
    'Allows Owner-approved PRODUCTION walking fee-policy publication.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_delivery.publish',
    false,
    'Allows production publication of walking-delivery zones and policies.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_delivery.quote_writes',
    false,
    'Allows server-side persistence of walking-delivery quote evaluations.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_quote.api',
    false,
    'Exposes the walking-delivery quote API after all dependencies are certified.',
    NULL,
    CURRENT_TIMESTAMP
  ),
  (
    'walking_quote.external_delivery',
    false,
    'Allows delivery of walking quotes to approved external clients.',
    NULL,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO UPDATE
SET
  "enabled" = false,
  "description" = EXCLUDED."description",
  "rules" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Supabase hardening: no direct browser role access. Trusted Prisma service
-- connections remain server-side, and quotes keep normalized address PII only
-- in this RLS-protected append-only table.
ALTER TABLE "FeeCalculationPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeeCalculationPolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeeCalculationTier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeeCalculationPolicyPublication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkingDeliveryQuote" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON
      "FeeCalculationPolicy",
      "FeeCalculationPolicyVersion",
      "FeeCalculationTier",
      "FeeCalculationPolicyPublication",
      "WalkingDeliveryQuote"
    FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON
      "FeeCalculationPolicy",
      "FeeCalculationPolicyVersion",
      "FeeCalculationTier",
      "FeeCalculationPolicyPublication",
      "WalkingDeliveryQuote"
    FROM authenticated;
  END IF;
END;
$$;

COMMIT;
