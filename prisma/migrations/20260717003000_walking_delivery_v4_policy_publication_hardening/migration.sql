BEGIN;

-- Keep the historical v1 matrix isolated while validating every v4 tier
-- predicate against the version row currently crossing the state boundary.
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

  SELECT p."code", p."externalPolicyId"
  INTO parent_policy_code, parent_external_policy_id
  FROM "FeeCalculationPolicy" p
  WHERE p."id" = NEW."feeCalculationPolicyId";

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE t."upperInclusiveFeet" IS NULL)
  INTO tier_count, open_tier_count
  FROM "FeeCalculationTier" t
  WHERE t."feePolicyVersionId" = NEW."id";

  IF tier_count = 0 OR open_tier_count <> 1 THEN
    RAISE EXCEPTION 'Validated fee-calculation versions require one complete open tier partition';
  END IF;

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
        FROM "FeeCalculationTier" t
        WHERE t."feePolicyVersionId" = NEW."id"
      ), '[]'::JSONB)
    ) INTO canonical_snapshot;
  ELSIF parent_policy_code = 'WALKING_ROUTE_DISTANCE_V4_BASE_10' THEN
    IF parent_external_policy_id IS DISTINCT FROM 'walking-route-distance-v4-base-10' OR
       NEW."externalVersionId" IS DISTINCT FROM 'walking-route-distance-v4-base-10-2026-07-16' OR
       NEW."versionKey" IS DISTINCT FROM 'walking-route-distance-v4-base-10-2026-07-16' OR
       NEW."currency" IS DISTINCT FROM 'USD' OR
       NEW."routingProfile" IS DISTINCT FROM 'walking' OR
       NEW."distanceBasis" IS DISTINCT FROM 'ONE_WAY_FROM_SELECTED_STORE' OR
       NEW."quoteTtlSeconds" IS NULL OR NEW."quoteTtlSeconds" <= 0 OR
       NEW."holdTtlSeconds" IS NULL OR NEW."holdTtlSeconds" <= 0 OR
       NEW."preparationBufferSeconds" IS NULL OR NEW."preparationBufferSeconds" < 0 OR
       NEW."handoffBufferSeconds" IS NULL OR NEW."handoffBufferSeconds" < 0 THEN
      RAISE EXCEPTION 'Walking fee v4 external identity or route basis is invalid';
    END IF;

    -- Parentheses are intentional: every mismatch predicate is scoped to
    -- NEW.id, so legacy v1 tiers can never contaminate v4 validation.
    SELECT COUNT(*) INTO mismatch_count
    FROM "FeeCalculationTier" t
    WHERE t."feePolicyVersionId" = NEW."id"
      AND (
        NOT (
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
        ) OR
        t."automatic" IS DISTINCT FROM true OR
        t."reasonCode" IS DISTINCT FROM 'ELIGIBLE'
      );

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
        FROM "FeeCalculationTier" t
        WHERE t."feePolicyVersionId" = NEW."id"
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

-- Delegated v4 shells intentionally have no legacy base fee. Preserve legacy
-- completeness while allowing an exact delegated calculation version.
ALTER TABLE "FeePolicy"
  DROP CONSTRAINT "FeePolicy_published_complete",
  ADD CONSTRAINT "FeePolicy_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      CARDINALITY("activeDays") > 0 AND
      "effectiveFrom" IS NOT NULL AND
      "digest" IS NOT NULL AND
      "publishedAt" IS NOT NULL AND (
        (
          "calculationPolicyVersionId" IS NULL AND
          "baseFeeCents" IS NOT NULL
        ) OR (
          "calculationPolicyVersionId" IS NOT NULL AND
          "baseFeeCents" IS NULL AND
          "rateRules" IS NULL AND
          "exceptions" IS NULL
        )
      )
    )
  );

-- Canonical internal snapshot for the versioned set. Every value is rebuilt
-- from relational source-of-truth rows; callers cannot smuggle extra fields or
-- stale topology into a VALIDATED/PUBLISHED set.
CREATE FUNCTION build_walking_zone_set_v4_snapshot(
  set_id UUID,
  external_version_id VARCHAR(120),
  set_revision INTEGER,
  set_environment "FeePolicyEnvironment"
) RETURNS JSONB AS $$
  SELECT JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.walking-zone-set.v1',
    'externalVersionId', external_version_id,
    'revision', set_revision,
    'environment', set_environment,
    'locations', COALESCE((
      SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'id', i."externalLocationId",
        'localDeliveryLocationIdentityId', i."id",
        'operationalLocationId', o."id",
        'code', o."code",
        'publicId', o."publicId",
        'name', i."displayName",
        'addressLine1', i."addressLine1",
        'addressLine2', i."addressLine2",
        'city', i."city",
        'regionCode', i."regionCode",
        'postalCode', i."postalCode",
        'countryCode', i."countryCode",
        'latitude', i."latitude",
        'longitude', i."longitude",
        'locationPriority', i."locationPriority"
      ) ORDER BY i."externalLocationId")
      FROM "LocalDeliveryLocationIdentity" i
      JOIN "OperationalLocation" o ON o."id" = i."operationalLocationId"
      WHERE i."externalLocationId" IN ('third_avenue', 'east_86th_street')
    ), '[]'::JSONB),
    'zones', COALESCE((
      SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'id', z."slug",
        'zoneVersionId', v."id",
        'name', z."name",
        'postalCodes', TO_JSONB(v."postalCodes"),
        'priority', v."priority",
        'serviceMode', v."serviceMode",
        'assignmentStrategy', v."assignmentStrategy",
        'locationIds', COALESCE((
          SELECT JSONB_AGG(i."externalLocationId" ORDER BY i."externalLocationId")
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '[]'::JSONB),
        'geometry', v."geometry",
        'activeDays', TO_JSONB(v."activeDays"),
        'maxDistanceMiles', v."maxDistanceMiles",
        'maxRouteMinutes', v."maxRouteMinutes",
        'minimumOrderCents', v."minimumOrderCents",
        'zoneDigest', v."digest",
        'feePolicyVersionIdByLocation', COALESCE((
          SELECT JSONB_OBJECT_AGG(
            i."externalLocationId", cv."externalVersionId"
            ORDER BY i."externalLocationId"
          )
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
          JOIN "FeeCalculationPolicyVersion" cv
            ON cv."id" = f."calculationPolicyVersionId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '{}'::JSONB),
        'feePolicyShellIdByLocation', COALESCE((
          SELECT JSONB_OBJECT_AGG(
            i."externalLocationId", f."id"
            ORDER BY i."externalLocationId"
          )
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '{}'::JSONB),
        'feePolicyShellDigestByLocation', COALESCE((
          SELECT JSONB_OBJECT_AGG(
            i."externalLocationId", f."digest"
            ORDER BY i."externalLocationId"
          )
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '{}'::JSONB),
        'slotPolicyVersionIdByLocation', COALESCE((
          SELECT JSONB_OBJECT_AGG(
            i."externalLocationId", s."id"
            ORDER BY i."externalLocationId"
          )
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          JOIN "SlotPolicy" s ON s."id" = c."slotPolicyId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '{}'::JSONB),
        'slotPolicyDigestByLocation', COALESCE((
          SELECT JSONB_OBJECT_AGG(
            i."externalLocationId", s."digest"
            ORDER BY i."externalLocationId"
          )
          FROM "WalkingZoneCandidate" c
          JOIN "LocalDeliveryLocationIdentity" i
            ON i."operationalLocationId" = c."locationId"
          JOIN "SlotPolicy" s ON s."id" = c."slotPolicyId"
          WHERE c."walkingZoneVersionId" = v."id"
        ), '{}'::JSONB)
      ) ORDER BY v."postalCodes"[1], v."id")
      FROM "WalkingZoneVersion" v
      JOIN "WalkingZone" z ON z."id" = v."walkingZoneId"
      WHERE v."zoneSetVersionId" = set_id
    ), '[]'::JSONB)
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION validate_walking_zone_set_version_state() RETURNS trigger AS $$
DECLARE
  zone_count INTEGER;
  zone_priority_count INTEGER;
  invalid_zone_count INTEGER;
  identity_count INTEGER;
  identity_priority_count INTEGER;
  invalid_identity_count INTEGER;
  candidate_count INTEGER;
  invalid_candidate_count INTEGER;
  canonical_snapshot JSONB;
  expected_digest TEXT;
  publish_enabled BOOLEAN;
  v4_publish_enabled BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND
     NEW."externalVersionId" IS DISTINCT FROM OLD."externalVersionId" THEN
    RAISE EXCEPTION 'External walking-zone set identity is immutable';
  END IF;

  IF NEW."status" = 'ARCHIVED' THEN
    IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'A walking-zone set can archive only from PUBLISHED';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "WalkingPublication" wp
      WHERE wp."zoneSetVersionId" = NEW."id" AND wp."status" = 'PUBLISHED'
    ) THEN
      RAISE EXCEPTION 'A walking-zone set with an active publication cannot be archived';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('VALIDATED', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  IF NEW."externalVersionId" IS DISTINCT FROM 'upper-east-side-walking-zones-v1' OR
     NEW."environment" IS DISTINCT FROM 'STAGING' THEN
    RAISE EXCEPTION 'Walking-zone set external identity or environment is invalid';
  END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT v."priority"),
    COUNT(*) FILTER (WHERE NOT (
      v."serviceMode" = 'WALKING' AND
      v."geometry" IS NOT NULL AND CARDINALITY(v."activeDays") > 0 AND
      v."priority" IS NOT NULL AND
      v."maxDistanceMiles" IS NULL AND v."maxRouteMinutes" IS NULL AND
      v."minimumOrderCents" IS NULL AND z."archivedAt" IS NULL AND
      (
        (v."id" = '20021000-0000-4000-8000-000000000101' AND z."id" = '20021000-0000-4000-8000-000000000001' AND z."slug" = 'local-v4-walking-10021' AND v."postalCodes" = ARRAY['10021']::TEXT[] AND v."assignmentStrategy" = 'FIXED') OR
        (v."id" = '20065000-0000-4000-8000-000000000101' AND z."id" = '20065000-0000-4000-8000-000000000001' AND z."slug" = 'local-v4-walking-10065' AND v."postalCodes" = ARRAY['10065']::TEXT[] AND v."assignmentStrategy" = 'FIXED') OR
        (v."id" = '20028000-0000-4000-8000-000000000101' AND z."id" = '20028000-0000-4000-8000-000000000001' AND z."slug" = 'local-v4-walking-10028' AND v."postalCodes" = ARRAY['10028']::TEXT[] AND v."assignmentStrategy" = 'FIXED') OR
        (v."id" = '20128000-0000-4000-8000-000000000101' AND z."id" = '20128000-0000-4000-8000-000000000001' AND z."slug" = 'local-v4-walking-10128' AND v."postalCodes" = ARRAY['10128']::TEXT[] AND v."assignmentStrategy" = 'FIXED') OR
        (v."id" = '20075000-0000-4000-8000-000000000101' AND z."id" = '20075000-0000-4000-8000-000000000001' AND z."slug" = 'local-v4-walking-10075' AND v."postalCodes" = ARRAY['10075']::TEXT[] AND v."assignmentStrategy" = 'NEAREST_WALKING_ROUTE')
      ) AND
      (
        (NEW."status" = 'VALIDATED' AND v."status" IN ('VALIDATED', 'PUBLISHED')) OR
        (NEW."status" = 'PUBLISHED' AND v."status" = 'PUBLISHED' AND
          v."effectiveFrom" IS NOT NULL AND v."effectiveFrom" <= NEW."effectiveFrom" AND
          (v."effectiveTo" IS NULL OR
            (NEW."effectiveTo" IS NOT NULL AND v."effectiveTo" >= NEW."effectiveTo")))
      )
    ))
  INTO zone_count, zone_priority_count, invalid_zone_count
  FROM "WalkingZoneVersion" v
  JOIN "WalkingZone" z ON z."id" = v."walkingZoneId"
  WHERE v."zoneSetVersionId" = NEW."id";

  IF zone_count <> 5 OR zone_priority_count <> 5 OR invalid_zone_count <> 0 THEN
    RAISE EXCEPTION 'Walking-zone set requires the five exact complete postal polygons without distance cutoffs';
  END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT i."locationPriority"),
    COUNT(*) FILTER (WHERE NOT (
      i."active" = true AND i."locationPriority" IS NOT NULL AND i."locationPriority" > 0 AND
      o."active" = true AND o."type" = 'STORE' AND o."timeZone" = 'America/New_York' AND
      (o."latitude" IS NULL OR o."latitude" = ROUND(i."latitude", 6)) AND
      (o."longitude" IS NULL OR o."longitude" = ROUND(i."longitude", 6)) AND (
        (
          i."id" = '00000000-0000-4000-8610-000000000072' AND
          i."externalLocationId" = 'third_avenue' AND
          i."operationalLocationId" = '00000000-0000-4000-8000-000000000072' AND
          i."displayName" = '3rd Avenue Store' AND i."addressLine1" = '1243 3rd Ave' AND
          i."addressLine2" IS NULL AND i."city" = 'New York' AND i."regionCode" = 'NY' AND
          i."postalCode" = '10021' AND i."countryCode" = 'US' AND
          i."latitude" = 40.769473514641 AND i."longitude" = -73.960715741688 AND
          o."id" = '00000000-0000-4000-8000-000000000072' AND o."code" = 'ST72' AND
          o."publicId" = 'store-3rd-avenue' AND o."name" = '3rd Avenue Store' AND
          o."addressLine1" = '1243 3rd Ave' AND o."addressLine2" IS NULL AND
          o."city" = 'New York' AND o."regionCode" = 'NY' AND o."postalCode" = '10021' AND
          o."countryCode" = 'US'
        ) OR (
          i."id" = '00000000-0000-4000-8610-000000000086' AND
          i."externalLocationId" = 'east_86th_street' AND
          i."operationalLocationId" = '00000000-0000-4000-8000-000000000086' AND
          i."displayName" = '86th Street Store' AND i."addressLine1" = '112 E 86th St' AND
          i."addressLine2" IS NULL AND i."city" = 'New York' AND i."regionCode" = 'NY' AND
          i."postalCode" = '10028' AND i."countryCode" = 'US' AND
          i."latitude" = 40.779922307507 AND i."longitude" = -73.956748615355 AND
          o."id" = '00000000-0000-4000-8000-000000000086' AND o."code" = 'ST86' AND
          o."publicId" = 'store-86th-street' AND o."name" = '86th Street Store' AND
          o."addressLine1" = '112 E 86th St' AND o."addressLine2" IS NULL AND
          o."city" = 'New York' AND o."regionCode" = 'NY' AND o."postalCode" = '10028' AND
          o."countryCode" = 'US'
        )
      )
    ))
  INTO identity_count, identity_priority_count, invalid_identity_count
  FROM "LocalDeliveryLocationIdentity" i
  JOIN "OperationalLocation" o ON o."id" = i."operationalLocationId"
  WHERE i."externalLocationId" IN ('third_avenue', 'east_86th_street');

  IF identity_count <> 2 OR identity_priority_count <> 2 OR invalid_identity_count <> 0 THEN
    RAISE EXCEPTION 'Walking-zone set requires the two exact active store aliases and distinct positive priorities';
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE NOT (
      (
        (v."id" IN ('20021000-0000-4000-8000-000000000101', '20065000-0000-4000-8000-000000000101') AND c."locationId" = '00000000-0000-4000-8000-000000000072' AND c."feePolicyId" = '00000000-0000-4000-8100-000000000172' AND c."slotPolicyId" = '00000000-0000-4000-8200-000000000072') OR
        (v."id" IN ('20028000-0000-4000-8000-000000000101', '20128000-0000-4000-8000-000000000101') AND c."locationId" = '00000000-0000-4000-8000-000000000086' AND c."feePolicyId" = '00000000-0000-4000-8100-000000000186' AND c."slotPolicyId" = '00000000-0000-4000-8200-000000000086') OR
        (v."id" = '20075000-0000-4000-8000-000000000101' AND c."locationId" = '00000000-0000-4000-8000-000000000072' AND c."feePolicyId" = '00000000-0000-4000-8100-000000000172' AND c."slotPolicyId" = '00000000-0000-4000-8200-000000000072') OR
        (v."id" = '20075000-0000-4000-8000-000000000101' AND c."locationId" = '00000000-0000-4000-8000-000000000086' AND c."feePolicyId" = '00000000-0000-4000-8100-000000000186' AND c."slotPolicyId" = '00000000-0000-4000-8200-000000000086')
      ) AND
      f."versionNumber" = 2 AND f."serviceScope" = 'GENERAL_LOCAL_DELIVERY' AND
      f."currency" = 'USD' AND f."baseFeeCents" IS NULL AND f."rateRules" IS NULL AND
      f."exceptions" IS NULL AND CARDINALITY(f."activeDays") > 0 AND f."digest" IS NOT NULL AND
      ((c."locationId" = '00000000-0000-4000-8000-000000000072' AND f."policyKey" = 'walking-fee-third-avenue') OR
       (c."locationId" = '00000000-0000-4000-8000-000000000086' AND f."policyKey" = 'walking-fee-86th-street')) AND
      cv."id" = '00000000-0000-4000-8510-000000000001' AND
      cv."externalVersionId" = 'walking-route-distance-v4-base-10-2026-07-16' AND
      cv."strategy" = 'WALKING_ROUTE_DISTANCE' AND cv."routingProfile" = 'walking' AND
      cv."distanceBasis" = 'ONE_WAY_FROM_SELECTED_STORE' AND
      cv."quoteTtlSeconds" IS NOT NULL AND cv."holdTtlSeconds" IS NOT NULL AND
      cv."preparationBufferSeconds" IS NOT NULL AND cv."handoffBufferSeconds" IS NOT NULL AND
      cp."code" = 'WALKING_ROUTE_DISTANCE_V4_BASE_10' AND
      cp."externalPolicyId" = 'walking-route-distance-v4-base-10' AND
      s."versionNumber" = 1 AND s."fulfillmentMode" = 'WALKING_LOCAL_DELIVERY' AND
      CARDINALITY(s."activeDays") > 0 AND s."leadTimeMinutes" IS NOT NULL AND
      s."cutoffMinuteOfDay" IS NOT NULL AND s."capacityPolicyRef" IS NOT NULL AND
      BTRIM(s."capacityPolicyRef") <> '' AND s."digest" IS NOT NULL AND
      ((c."locationId" = '00000000-0000-4000-8000-000000000072' AND s."policyKey" = 'walking-slots-third-avenue') OR
       (c."locationId" = '00000000-0000-4000-8000-000000000086' AND s."policyKey" = 'walking-slots-86th-street')) AND
      (
        (NEW."status" = 'VALIDATED' AND f."status" IN ('VALIDATED', 'PUBLISHED') AND
          s."status" IN ('VALIDATED', 'PUBLISHED') AND cv."status" IN ('VALIDATED', 'PUBLISHED')) OR
        (NEW."status" = 'PUBLISHED' AND f."status" = 'PUBLISHED' AND
          s."status" = 'PUBLISHED' AND cv."status" = 'PUBLISHED' AND
          f."effectiveFrom" IS NOT NULL AND f."effectiveFrom" <= NEW."effectiveFrom" AND
          s."effectiveFrom" IS NOT NULL AND s."effectiveFrom" <= NEW."effectiveFrom" AND
          cv."effectiveFrom" IS NOT NULL AND cv."effectiveFrom" <= NEW."effectiveFrom" AND
          (f."effectiveTo" IS NULL OR (NEW."effectiveTo" IS NOT NULL AND f."effectiveTo" >= NEW."effectiveTo")) AND
          (s."effectiveTo" IS NULL OR (NEW."effectiveTo" IS NOT NULL AND s."effectiveTo" >= NEW."effectiveTo")) AND
          (cv."effectiveTo" IS NULL OR (NEW."effectiveTo" IS NOT NULL AND cv."effectiveTo" >= NEW."effectiveTo")))
      )
    ))
  INTO candidate_count, invalid_candidate_count
  FROM "WalkingZoneVersion" v
  JOIN "WalkingZoneCandidate" c ON c."walkingZoneVersionId" = v."id"
  LEFT JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
  LEFT JOIN "FeeCalculationPolicyVersion" cv ON cv."id" = f."calculationPolicyVersionId"
  LEFT JOIN "FeeCalculationPolicy" cp ON cp."id" = cv."feeCalculationPolicyId"
  LEFT JOIN "SlotPolicy" s ON s."id" = c."slotPolicyId"
  WHERE v."zoneSetVersionId" = NEW."id";

  IF candidate_count <> 6 OR invalid_candidate_count <> 0 THEN
    RAISE EXCEPTION 'Walking-zone set candidate topology or delegated fee/slot policy lineage is invalid';
  END IF;

  canonical_snapshot := build_walking_zone_set_v4_snapshot(
    NEW."id", NEW."externalVersionId", NEW."revision", NEW."environment"
  );
  IF NEW."snapshot" IS DISTINCT FROM canonical_snapshot THEN
    RAISE EXCEPTION 'Walking-zone set snapshot does not match its exact canonical topology';
  END IF;

  expected_digest := 'sha256:' || ENCODE(
    SHA256(CONVERT_TO(canonical_fee_policy_json(NEW."snapshot"), 'UTF8')),
    'hex'
  );
  IF NEW."digest" IS DISTINCT FROM expected_digest THEN
    RAISE EXCEPTION 'Walking-zone set digest does not match its canonical snapshot';
  END IF;

  IF NEW."status" = 'PUBLISHED' THEN
    SELECT "enabled" INTO publish_enabled FROM "FeatureFlag"
    WHERE "key" = 'walking_delivery.publish';
    SELECT "enabled" INTO v4_publish_enabled FROM "FeatureFlag"
    WHERE "key" = 'local_delivery_v4.publish';
    IF publish_enabled IS DISTINCT FROM true OR v4_publish_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Walking-zone v4 publication is disabled by feature flags';
    END IF;
    IF NEW."publishedById" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "UserRole" ur
      JOIN "User" u ON u."id" = ur."userId"
      WHERE ur."userId" = NEW."publishedById" AND ur."role" = 'OWNER' AND u."active" = true
    ) THEN
      RAISE EXCEPTION 'Walking-zone set publication requires active Owner approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION build_walking_publication_v4_snapshot(
  publication_id UUID,
  publication_number INTEGER,
  publication_effective_from TIMESTAMP(3),
  publication_effective_to TIMESTAMP(3),
  zone_set_version_id UUID
) RETURNS JSONB AS $$
  SELECT JSONB_BUILD_OBJECT(
    'schemaVersion', 'orderpro.walking-zones.v1',
    'publicationId', publication_id,
    'versionNumber', publication_number,
    'effectiveFrom', TO_CHAR(
      publication_effective_from,
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'effectiveTo', CASE WHEN publication_effective_to IS NULL THEN NULL ELSE TO_CHAR(
      publication_effective_to,
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) END,
    -- This is the digest of the exact source configuration. The publication
    -- row digest below separately authenticates this whole envelope.
    'digest', s."digest",
    'zones', COALESCE((
      SELECT JSONB_AGG(
        zone - ARRAY[
          'zoneDigest',
          'feePolicyShellIdByLocation',
          'feePolicyShellDigestByLocation',
          'slotPolicyDigestByLocation'
        ]::TEXT[]
        ORDER BY zone ->> 'id'
      )
      FROM JSONB_ARRAY_ELEMENTS(s."snapshot" -> 'zones') zone
    ), '[]'::JSONB)
  )
  FROM "WalkingZoneSetVersion" s
  WHERE s."id" = zone_set_version_id;
$$ LANGUAGE sql STABLE;

-- Publication is a separately audited step. It may only expose the exact
-- already-published v4 set, with the same active Owner as approver.
CREATE FUNCTION validate_walking_publication_v4_hardening() RETURNS trigger AS $$
DECLARE
  set_external_id VARCHAR(120);
  set_status "WalkingZoneVersionStatus";
  set_environment "FeePolicyEnvironment";
  set_effective_from TIMESTAMP(3);
  set_effective_to TIMESTAMP(3);
  set_published_by UUID;
  canonical_snapshot JSONB;
  expected_digest TEXT;
  v4_publish_enabled BOOLEAN;
BEGIN
  IF NEW."status" <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;

  IF NEW."publishedById" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "UserRole" ur
    JOIN "User" u ON u."id" = ur."userId"
    WHERE ur."userId" = NEW."publishedById" AND ur."role" = 'OWNER' AND u."active" = true
  ) THEN
    RAISE EXCEPTION 'Walking publication requires active Owner approval';
  END IF;

  IF NEW."zoneSetVersionId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s."externalVersionId", s."status", s."environment", s."effectiveFrom",
         s."effectiveTo", s."publishedById"
  INTO set_external_id, set_status, set_environment, set_effective_from,
       set_effective_to, set_published_by
  FROM "WalkingZoneSetVersion" s
  WHERE s."id" = NEW."zoneSetVersionId";

  IF set_external_id IS DISTINCT FROM 'upper-east-side-walking-zones-v1' OR
     set_status IS DISTINCT FROM 'PUBLISHED' OR set_environment IS DISTINCT FROM 'STAGING' OR
     set_effective_from IS NULL OR set_effective_from > NEW."effectiveFrom" OR
     (set_effective_to IS NOT NULL AND
       (NEW."effectiveTo" IS NULL OR NEW."effectiveTo" > set_effective_to)) OR
     set_published_by IS DISTINCT FROM NEW."publishedById" OR
     NEW."schemaVersion" IS DISTINCT FROM 'orderpro.walking-zones.v1' THEN
    RAISE EXCEPTION 'Walking publication does not reference the exact published v4 zone set and approver';
  END IF;

  SELECT "enabled" INTO v4_publish_enabled FROM "FeatureFlag"
  WHERE "key" = 'local_delivery_v4.publish';
  IF v4_publish_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Local Walking Delivery v4 publication is disabled';
  END IF;

  canonical_snapshot := build_walking_publication_v4_snapshot(
    NEW."id", NEW."versionNumber", NEW."effectiveFrom", NEW."effectiveTo",
    NEW."zoneSetVersionId"
  );
  IF NEW."snapshot" IS DISTINCT FROM canonical_snapshot THEN
    RAISE EXCEPTION 'Walking publication snapshot does not match the exact published zone set';
  END IF;

  expected_digest := 'sha256:' || ENCODE(
    SHA256(CONVERT_TO(canonical_fee_policy_json(NEW."snapshot"), 'UTF8')),
    'hex'
  );
  IF NEW."digest" IS DISTINCT FROM expected_digest THEN
    RAISE EXCEPTION 'Walking publication digest does not match its canonical snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_publication_v4_hardening
BEFORE INSERT OR UPDATE ON "WalkingPublication"
FOR EACH ROW EXECUTE FUNCTION validate_walking_publication_v4_hardening();

-- A published zone/set must never silently start pointing at an archived or
-- shortened delegated shell. Archive the publication and topology first.
CREATE FUNCTION protect_v4_candidate_fee_policy_lifecycle() RETURNS trigger AS $$
BEGIN
  IF (
    NEW."status" IS DISTINCT FROM OLD."status" OR
    NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom" OR
    NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
  ) AND EXISTS (
    SELECT 1
    FROM "WalkingZoneCandidate" c
    JOIN "WalkingZoneVersion" v ON v."id" = c."walkingZoneVersionId"
    LEFT JOIN "WalkingZoneSetVersion" s ON s."id" = v."zoneSetVersionId"
    WHERE c."feePolicyId" = OLD."id"
      AND (v."status" = 'PUBLISHED' OR s."status" = 'PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'FeePolicy lifecycle is locked while referenced by a published walking zone or set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_policy_v4_published_zone_reference_guard
BEFORE UPDATE OF "status", "effectiveFrom", "effectiveTo" ON "FeePolicy"
FOR EACH ROW EXECUTE FUNCTION protect_v4_candidate_fee_policy_lifecycle();

CREATE FUNCTION protect_v4_candidate_slot_policy_lifecycle() RETURNS trigger AS $$
BEGIN
  IF (
    NEW."status" IS DISTINCT FROM OLD."status" OR
    NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom" OR
    NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
  ) AND EXISTS (
    SELECT 1
    FROM "WalkingZoneCandidate" c
    JOIN "WalkingZoneVersion" v ON v."id" = c."walkingZoneVersionId"
    LEFT JOIN "WalkingZoneSetVersion" s ON s."id" = v."zoneSetVersionId"
    WHERE c."slotPolicyId" = OLD."id"
      AND (v."status" = 'PUBLISHED' OR s."status" = 'PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'SlotPolicy lifecycle is locked while referenced by a published walking zone or set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER slot_policy_v4_published_zone_reference_guard
BEFORE UPDATE OF "status", "effectiveFrom", "effectiveTo" ON "SlotPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_v4_candidate_slot_policy_lifecycle();

-- CHECK-level completeness applies after the v4 canonicalizing trigger and is
-- deliberately scoped away from every historical quote schema.
ALTER TABLE "WalkingDeliveryQuote"
  ADD CONSTRAINT "WalkingDeliveryQuote_v2_priced_complete_hardened" CHECK (
    "schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR
    "externalFeePolicyVersionId" IS NULL OR (
      "externalFeePolicyVersionId" = 'walking-route-distance-v4-base-10-2026-07-16' AND
      "postalCode" IN ('10021', '10028', '10065', '10075', '10128') AND
      "normalizedAddressStructured" IS NOT NULL AND
      JSONB_TYPEOF("normalizedAddressStructured") = 'object' AND
      "normalizedAddressStructured" ->> 'postalCode' IS NOT NULL AND
      "normalizedAddressStructured" ->> 'postalCode' = "postalCode" AND
      "customerCoordinates" IS NOT NULL AND
      "selectedLocationId" IS NOT NULL AND "externalSelectedLocationId" IS NOT NULL AND
      "selectedOperationalLocationId" IS NOT NULL AND
      "selectedLocalDeliveryLocationId" IS NOT NULL AND
      "zoneVersionId" IS NOT NULL AND "zoneSetVersionId" IS NOT NULL AND
      "externalZoneVersionId" = 'upper-east-side-walking-zones-v1' AND
      "feePolicyVersionId" IS NOT NULL AND "feePolicySnapshot" IS NOT NULL AND
      "routingProvider" IS NOT NULL AND BTRIM("routingProvider") <> '' AND
      "routingProfile" = 'walking' AND
      "distanceBasis" = 'ONE_WAY_FROM_SELECTED_STORE' AND
      "distanceFeet" IS NOT NULL AND "durationSeconds" IS NOT NULL AND
      "roundTripDistanceFeet" IS NOT NULL AND
      "estimatedRoundTripDurationSeconds" IS NOT NULL AND
      "capacityRequiredSeconds" IS NOT NULL AND
      "feeCents" IS NOT NULL AND "tierId" IS NOT NULL AND "tierSnapshot" IS NOT NULL AND
      "currency" = 'USD' AND "routeCalculatedAt" IS NOT NULL AND
      "expiresAt" IS NOT NULL AND "walkingPublicationId" IS NOT NULL AND
      "bookable" IS NOT NULL AND
      ("reasonCode" <> 'ELIGIBLE' OR "inventoryReadinessStatus" = 'READY') AND
      ("reasonCode" <> 'TRANSFER_REQUIRED' OR
        ("inventoryReadinessStatus" = 'TRANSFER_REQUIRED' AND "inventoryReadyAt" IS NOT NULL)) AND
      ("inventoryReadinessStatus" <> 'TRANSFER_REQUIRED' OR "reasonCode" = 'TRANSFER_REQUIRED') AND
      ("bookable" = false OR
        ("reasonCode" = 'ELIGIBLE' AND "inventoryReadinessStatus" = 'READY') OR
        ("reasonCode" = 'TRANSFER_REQUIRED' AND "inventoryReadinessStatus" = 'TRANSFER_REQUIRED'))
    )
  );

-- This trigger runs after walking_delivery_quote_10_consistency_v4 and checks
-- the still-live per-location shell rather than trusting only its foreign key.
CREATE FUNCTION validate_walking_delivery_quote_v4_policy_hardening() RETURNS trigger AS $$
DECLARE
  shell_id UUID;
  shell_key VARCHAR(80);
  shell_version INTEGER;
  shell_location_id UUID;
  shell_scope "FeeServiceScope";
  shell_status "DeliveryPolicyStatus";
  shell_effective_from TIMESTAMP(3);
  shell_effective_to TIMESTAMP(3);
  shell_calculation_version_id UUID;
  identity_external_id VARCHAR(64);
  identity_location_id UUID;
BEGIN
  IF NEW."schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR
     NEW."externalFeePolicyVersionId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i."externalLocationId", i."operationalLocationId"
  INTO identity_external_id, identity_location_id
  FROM "LocalDeliveryLocationIdentity" i
  JOIN "OperationalLocation" o ON o."id" = i."operationalLocationId"
  WHERE i."id" = NEW."selectedLocalDeliveryLocationId" AND i."active" = true AND
    o."active" = true AND o."type" = 'STORE' AND (
      (i."externalLocationId" = 'third_avenue' AND i."operationalLocationId" = '00000000-0000-4000-8000-000000000072' AND
       i."latitude" = 40.769473514641 AND i."longitude" = -73.960715741688 AND
       o."code" = 'ST72' AND o."publicId" = 'store-3rd-avenue' AND o."addressLine1" = '1243 3rd Ave') OR
      (i."externalLocationId" = 'east_86th_street' AND i."operationalLocationId" = '00000000-0000-4000-8000-000000000086' AND
       i."latitude" = 40.779922307507 AND i."longitude" = -73.956748615355 AND
       o."code" = 'ST86' AND o."publicId" = 'store-86th-street' AND o."addressLine1" = '112 E 86th St')
    );

  IF identity_external_id IS NULL OR
     identity_external_id IS DISTINCT FROM NEW."externalSelectedLocationId" OR
     identity_location_id IS DISTINCT FROM NEW."selectedOperationalLocationId" THEN
    RAISE EXCEPTION 'Priced walking quote does not use an exact canonical store identity';
  END IF;

  SELECT f."id", f."policyKey", f."versionNumber", f."locationId", f."serviceScope",
         f."status", f."effectiveFrom", f."effectiveTo", f."calculationPolicyVersionId"
  INTO shell_id, shell_key, shell_version, shell_location_id, shell_scope,
       shell_status, shell_effective_from, shell_effective_to,
       shell_calculation_version_id
  FROM "WalkingZoneCandidate" c
  JOIN "FeePolicy" f ON f."id" = c."feePolicyId"
  WHERE c."walkingZoneVersionId" = NEW."zoneVersionId"
    AND c."locationId" = NEW."selectedOperationalLocationId";

  IF shell_id IS NULL OR shell_status IS DISTINCT FROM 'PUBLISHED' OR
     shell_effective_from IS NULL OR shell_effective_from > NEW."calculatedAt" OR
     (shell_effective_to IS NOT NULL AND shell_effective_to <= NEW."calculatedAt") OR
     shell_calculation_version_id IS DISTINCT FROM NEW."feePolicyVersionId" OR
     shell_location_id IS DISTINCT FROM NEW."selectedOperationalLocationId" OR
     shell_scope IS DISTINCT FROM 'GENERAL_LOCAL_DELIVERY' OR shell_version <> 2 OR
     NOT (
       (identity_external_id = 'third_avenue' AND shell_id = '00000000-0000-4000-8100-000000000172' AND shell_key = 'walking-fee-third-avenue') OR
       (identity_external_id = 'east_86th_street' AND shell_id = '00000000-0000-4000-8100-000000000186' AND shell_key = 'walking-fee-86th-street')
     ) THEN
    RAISE EXCEPTION 'Priced walking quote requires the exact published effective FeePolicy shell';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_11_v4_policy_hardening
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW
WHEN (NEW."schemaVersion" = 'orderpro.walking-delivery-quote.v2')
EXECUTE FUNCTION validate_walking_delivery_quote_v4_policy_hardening();

COMMIT;
