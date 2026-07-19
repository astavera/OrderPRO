BEGIN;

-- PL/pgSQL resolves record fields used by a CASE expression even when another
-- branch wins. These trigger functions serve more than one table, so select
-- the target identifier with control flow that only touches the active
-- trigger row type.
CREATE OR REPLACE FUNCTION validate_walking_quote_candidate_routes() RETURNS trigger AS $$
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
  IF TG_TABLE_NAME = 'WalkingDeliveryQuote' THEN
    target_quote_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_quote_id := OLD."quoteId";
  ELSE
    target_quote_id := NEW."quoteId";
  END IF;

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

CREATE OR REPLACE FUNCTION validate_walking_hold_inventory_pair() RETURNS trigger AS $$
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
  IF TG_TABLE_NAME = 'WalkingCapacityHold' THEN
    target_hold_id := NEW."id";
  ELSE
    target_hold_id := NEW."capacityHoldId";
  END IF;

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
      SELECT
        ql."variantId", ql."productId", ql."inventoryOwnerLocationId",
        ql."inventoryNodeId", SUM(ql."quantity"::DECIMAL(18, 3)) AS quantity
      FROM "WalkingDeliveryQuoteInventoryLine" ql
      WHERE ql."quoteId" = hold_quote_id
      GROUP BY
        ql."variantId", ql."productId", ql."inventoryOwnerLocationId",
        ql."inventoryNodeId"
    ), reservation_totals AS (
      SELECT
        rl."variantId", rl."productId", rl."inventoryOwnerLocationId",
        rl."inventoryNodeId", SUM(rl."quantity") AS quantity
      FROM "WalkingInventoryReservationLine" rl
      JOIN "WalkingInventoryReservation" r ON r."id" = rl."reservationId"
      WHERE r."capacityHoldId" = target_hold_id
      GROUP BY
        rl."variantId", rl."productId", rl."inventoryOwnerLocationId",
        rl."inventoryNodeId"
    )
    SELECT 1 FROM quote_totals q
    FULL JOIN reservation_totals r USING (
      "variantId", "productId", "inventoryOwnerLocationId", "inventoryNodeId"
    )
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

CREATE OR REPLACE FUNCTION validate_walking_quote_inventory_evidence() RETURNS trigger AS $$
DECLARE
  target_quote_id UUID;
  quote_readiness "WalkingInventoryReadinessStatus";
  quote_ready_at TIMESTAMP(3);
  line_count INTEGER;
  mismatch_count INTEGER;
  latest_ready_at TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'WalkingDeliveryQuote' THEN
    target_quote_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_quote_id := OLD."quoteId";
  ELSE
    target_quote_id := NEW."quoteId";
  END IF;

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

CREATE FUNCTION validate_walking_quote_schema_reason() RETURNS trigger AS $$
BEGIN
  IF NEW."schemaVersion" = 'orderpro.walking-delivery-quote.v2' THEN
    IF NEW."reasonCode" NOT IN (
      'ELIGIBLE', 'NO_SLOTS_FOR_SELECTED_LOCATION', 'TRANSFER_REQUIRED',
      'CONTACT_STORE'
    ) THEN
      RAISE EXCEPTION 'Quote schema v2 stores only completed offers and CONTACT_STORE outcomes';
    END IF;
  ELSIF NEW."reasonCode" NOT IN (
    'INVALID_INPUT', 'INVALID_ADDRESS', 'GEOCODING_FAILED', 'AMBIGUOUS_ADDRESS',
    'OUTSIDE_WALKING_ZONE', 'NO_ACTIVE_ZONE', 'SERVICE_DAY_UNAVAILABLE',
    'INVALID_ZONE_CONFIGURATION', 'STORE_NOT_AVAILABLE', 'ROUTE_METRICS_REQUIRED',
    'DISTANCE_EXCEEDED', 'ROUTE_TIME_EXCEEDED', 'MINIMUM_ORDER_NOT_MET',
    'FEE_POLICY_INCOMPLETE', 'SLOT_POLICY_INCOMPLETE', 'NO_AVAILABLE_SLOTS',
    'ELIGIBLE', 'MANAGER_REVIEW'
  ) THEN
    RAISE EXCEPTION 'A v4 reason code cannot use the historical quote schema or write gate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_05_schema_reason_guard
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_schema_reason();

ALTER TABLE "WalkingDeliveryQuote"
  ADD CONSTRAINT "WalkingDeliveryQuote_v4_priced_evidence_complete"
  CHECK (
    "schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR
    "externalFeePolicyVersionId" IS NULL OR (
      "normalizedAddressStructured" IS NOT NULL AND
      "customerCoordinates" IS NOT NULL AND
      "postalCode" IN ('10021', '10028', '10065', '10075', '10128') AND
      "normalizedAddressStructured" ->> 'postalCode' = "postalCode" AND
      "normalizedAddressStructured" ->> 'city' = 'New York' AND
      "normalizedAddressStructured" ->> 'borough' = 'Manhattan' AND
      "normalizedAddressStructured" ->> 'state' = 'NY' AND
      "normalizedAddressStructured" ->> 'country' = 'US' AND
      "routingProvider" IS NOT NULL AND BTRIM("routingProvider") <> '' AND
      "distanceFeet" IS NOT NULL AND "durationSeconds" IS NOT NULL AND
      "feeCents" IS NOT NULL AND "tierId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "WalkingDeliveryQuote_v4_bookable_inventory_complete"
  CHECK (
    "schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR
    "bookable" IS DISTINCT FROM true OR
    "inventoryReadinessStatus" IN ('READY', 'TRANSFER_REQUIRED')
  ),
  ADD CONSTRAINT "WalkingDeliveryQuote_v4_reason_inventory_match"
  CHECK (
    "schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR (
      ("reasonCode" <> 'ELIGIBLE' OR "inventoryReadinessStatus" = 'READY') AND
      ("reasonCode" <> 'TRANSFER_REQUIRED' OR
        "inventoryReadinessStatus" = 'TRANSFER_REQUIRED')
    )
  );

CREATE OR REPLACE FUNCTION validate_walking_quote_inventory_line() RETURNS trigger AS $$
DECLARE
  quote_status "WalkingInventoryReadinessStatus";
  delivery_location_id UUID;
  product_variant_id TEXT;
  container_location_id UUID;
  container_storage_id UUID;
  storage_location_id UUID;
BEGIN
  SELECT q."inventoryReadinessStatus", q."selectedOperationalLocationId"
  INTO quote_status, delivery_location_id
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  IF quote_status IS NULL OR quote_status = 'NOT_EVALUATED' THEN
    RAISE EXCEPTION 'Inventory line requires an evaluated quote inventory status';
  END IF;

  IF quote_status IN ('READY', 'TRANSFER_REQUIRED') AND (
    NEW."productId" IS NULL OR NEW."inventoryOwnerLocationId" IS NULL OR
    NEW."inventoryNodeId" IS NULL OR
    (NEW."containerId" IS NULL AND NEW."storageLocationId" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Resolved quote inventory requires product, owner, node, and physical evidence';
  END IF;

  IF NEW."productId" IS NOT NULL THEN
    SELECT p."squareVariationId" INTO product_variant_id
    FROM "Product" p WHERE p."id" = NEW."productId" AND p."active" = true;
    IF product_variant_id IS NULL OR product_variant_id IS DISTINCT FROM NEW."variantId" THEN
      RAISE EXCEPTION 'Quote variant must match its active product identity';
    END IF;
  END IF;

  IF NEW."containerId" IS NOT NULL THEN
    SELECT c."currentLocationId", c."storageLocationId"
    INTO container_location_id, container_storage_id
    FROM "Container" c WHERE c."id" = NEW."containerId";
    IF NEW."inventoryNodeId" IS DISTINCT FROM container_location_id OR
       (NEW."storageLocationId" IS NOT NULL AND
        NEW."storageLocationId" IS DISTINCT FROM container_storage_id) THEN
      RAISE EXCEPTION 'Quote inventory physical node/container/bin references disagree';
    END IF;
  END IF;

  IF NEW."storageLocationId" IS NOT NULL THEN
    SELECT s."operationalLocationId" INTO storage_location_id
    FROM "StorageLocation" s WHERE s."id" = NEW."storageLocationId";
    IF storage_location_id IS DISTINCT FROM NEW."inventoryNodeId" THEN
      RAISE EXCEPTION 'Quote inventory bin does not belong to its physical node';
    END IF;
  END IF;

  IF NEW."inventoryNodeId" IS DISTINCT FROM delivery_location_id AND
     NEW."transferStatus" NOT IN (
       'TRANSFER_REQUIRED', 'REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'READY'
     ) THEN
    RAISE EXCEPTION 'Quote inventory outside the delivery store requires transfer evidence';
  END IF;
  IF NEW."inventoryNodeId" = delivery_location_id AND
     NEW."transferStatus" NOT IN ('NOT_REQUIRED', 'READY') THEN
    RAISE EXCEPTION 'Quote inventory at the delivery store cannot require transfer';
  END IF;
  IF NEW."readinessStatus" = 'TRANSFER_REQUIRED' AND NEW."earliestReadyAt" IS NULL THEN
    RAISE EXCEPTION 'Transfer-required quote inventory needs an earliest ready time';
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

CREATE FUNCTION validate_walking_reservation_variant_identity() RETURNS trigger AS $$
DECLARE
  product_variant_id TEXT;
BEGIN
  SELECT p."squareVariationId" INTO product_variant_id
  FROM "Product" p WHERE p."id" = NEW."productId" AND p."active" = true;
  IF product_variant_id IS NULL OR product_variant_id IS DISTINCT FROM NEW."variantId" THEN
    RAISE EXCEPTION 'Reserved variant must match its active product identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_inventory_reservation_line_05_variant_guard
BEFORE INSERT ON "WalkingInventoryReservationLine"
FOR EACH ROW EXECUTE FUNCTION validate_walking_reservation_variant_identity();

-- A quote may only expose stable slots that exist in the same published slot
-- policy and selected store. This trigger runs after the v4 canonicalizer (10),
-- so it validates the canonical { policy, slots } snapshot that is persisted.
CREATE FUNCTION validate_walking_quote_v4_capacity_slots() RETURNS trigger AS $$
DECLARE
  slots JSONB;
  canonical_slots JSONB;
  slot_count INTEGER;
  distinct_slot_count INTEGER;
BEGIN
  IF NEW."schemaVersion" <> 'orderpro.walking-delivery-quote.v2' OR
     NEW."reasonCode" NOT IN (
       'ELIGIBLE', 'TRANSFER_REQUIRED', 'NO_SLOTS_FOR_SELECTED_LOCATION'
     ) THEN
    RETURN NEW;
  END IF;

  slots := NEW."slotSnapshot" -> 'slots';
  IF JSONB_TYPEOF(slots) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'V4 quote requires a canonical capacity-slot snapshot';
  END IF;

  slot_count := JSONB_ARRAY_LENGTH(slots);
  SELECT COUNT(DISTINCT entry.slot ->> 'slotId')
  INTO distinct_slot_count
  FROM JSONB_ARRAY_ELEMENTS(slots) AS entry(slot);

  IF (NEW."reasonCode" = 'NO_SLOTS_FOR_SELECTED_LOCATION' AND slot_count <> 0) OR
     (NEW."reasonCode" IN ('ELIGIBLE', 'TRANSFER_REQUIRED') AND slot_count = 0) OR
     distinct_slot_count <> slot_count THEN
    RAISE EXCEPTION 'V4 quote slot set is empty, duplicated, or inconsistent with its outcome';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM JSONB_ARRAY_ELEMENTS(slots) AS entry(slot)
    WHERE JSONB_TYPEOF(entry.slot) IS DISTINCT FROM 'object'
       OR JSONB_TYPEOF(entry.slot -> 'slotId') IS DISTINCT FROM 'string'
       OR BTRIM(entry.slot ->> 'slotId') = ''
       OR LENGTH(entry.slot ->> 'slotId') > 160
       OR JSONB_TYPEOF(entry.slot -> 'locationId') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(entry.slot -> 'startsAt') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(entry.slot -> 'endsAt') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(entry.slot -> 'remainingCapacitySeconds') IS DISTINCT FROM 'number'
       OR (entry.slot ->> 'remainingCapacitySeconds') !~ '^[1-9][0-9]*$'
       OR (entry.slot ->> 'remainingCapacitySeconds')::NUMERIC < NEW."capacityRequiredSeconds"
       OR NOT EXISTS (
         SELECT 1
         FROM "WalkingCapacitySlot" capacity_slot
         JOIN "SlotPolicy" slot_policy
           ON slot_policy."id" = capacity_slot."slotPolicyId"
         JOIN "OperationalLocation" slot_location
           ON slot_location."id" = capacity_slot."operationalLocationId"
         WHERE capacity_slot."slotPolicyId" = NEW."slotPolicyId"
           AND capacity_slot."slotKey" = entry.slot ->> 'slotId'
           AND capacity_slot."operationalLocationId" = NEW."selectedOperationalLocationId"
           AND capacity_slot."status" = 'OPEN'
           AND slot_policy."status" = 'PUBLISHED'
           AND slot_location."timeZone" IS NOT NULL
           AND BTRIM(slot_location."timeZone") <> ''
           AND capacity_slot."startsAt" =
             ((entry.slot ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
           AND capacity_slot."endsAt" =
             ((entry.slot ->> 'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
           AND capacity_slot."startsAt" > NEW."calculatedAt"
           AND capacity_slot."startsAt" >=
             NEW."calculatedAt" + (slot_policy."leadTimeMinutes" * INTERVAL '1 minute')
           AND capacity_slot."startsAt" >= slot_policy."effectiveFrom"
           AND (
             slot_policy."effectiveTo" IS NULL OR
             capacity_slot."endsAt" <= slot_policy."effectiveTo"
           )
           AND CASE EXTRACT(
             DOW FROM (
               capacity_slot."startsAt" AT TIME ZONE 'UTC'
               AT TIME ZONE slot_location."timeZone"
             )
           )::INTEGER
             WHEN 0 THEN 'SUNDAY'::"WalkingWeekday"
             WHEN 1 THEN 'MONDAY'::"WalkingWeekday"
             WHEN 2 THEN 'TUESDAY'::"WalkingWeekday"
             WHEN 3 THEN 'WEDNESDAY'::"WalkingWeekday"
             WHEN 4 THEN 'THURSDAY'::"WalkingWeekday"
             WHEN 5 THEN 'FRIDAY'::"WalkingWeekday"
             WHEN 6 THEN 'SATURDAY'::"WalkingWeekday"
           END = ANY(slot_policy."activeDays")
           AND (
             (capacity_slot."startsAt" AT TIME ZONE 'UTC'
               AT TIME ZONE slot_location."timeZone")::DATE <>
             (NEW."calculatedAt" AT TIME ZONE 'UTC'
               AT TIME ZONE slot_location."timeZone")::DATE OR
             (
               EXTRACT(HOUR FROM (
                 NEW."calculatedAt" AT TIME ZONE 'UTC'
                 AT TIME ZONE slot_location."timeZone"
               ))::INTEGER * 60 +
               EXTRACT(MINUTE FROM (
                 NEW."calculatedAt" AT TIME ZONE 'UTC'
                 AT TIME ZONE slot_location."timeZone"
               ))::INTEGER
             ) <= slot_policy."cutoffMinuteOfDay"
           )
           AND capacity_slot."capacitySeconds" >= NEW."capacityRequiredSeconds"
           AND (entry.slot ->> 'remainingCapacitySeconds')::NUMERIC =
             capacity_slot."capacitySeconds" - COALESCE((
               SELECT SUM(active_hold."reservedCapacitySeconds")
               FROM "WalkingCapacityHold" active_hold
               WHERE active_hold."capacitySlotId" = capacity_slot."id"
                 AND (
                   active_hold."status" = 'CONFIRMED' OR
                   (
                     active_hold."status" = 'HELD' AND
                     active_hold."expiresAt" > CURRENT_TIMESTAMP
                   )
                 )
             ), 0)
           AND (
             NEW."reasonCode" <> 'TRANSFER_REQUIRED' OR
             capacity_slot."startsAt" >= NEW."inventoryReadyAt"
           )
       )
  ) THEN
    RAISE EXCEPTION 'V4 quote contains an invalid, unavailable, or foreign capacity slot';
  END IF;

  SELECT COALESCE(JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'slotId', capacity_slot."slotKey",
      'locationId', identity."externalLocationId",
      'startsAt', TO_CHAR(
        capacity_slot."startsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'endsAt', TO_CHAR(
        capacity_slot."endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'remainingCapacitySeconds',
        capacity_slot."capacitySeconds" - COALESCE((
          SELECT SUM(active_hold."reservedCapacitySeconds")
          FROM "WalkingCapacityHold" active_hold
          WHERE active_hold."capacitySlotId" = capacity_slot."id"
            AND (
              active_hold."status" = 'CONFIRMED' OR
              (
                active_hold."status" = 'HELD' AND
                active_hold."expiresAt" > CURRENT_TIMESTAMP
              )
            )
        ), 0)
    ) ORDER BY capacity_slot."startsAt", capacity_slot."endsAt", capacity_slot."slotKey"
  ), '[]'::JSONB)
  INTO canonical_slots
  FROM JSONB_ARRAY_ELEMENTS(slots) AS requested(slot)
  JOIN "WalkingCapacitySlot" capacity_slot
    ON capacity_slot."slotPolicyId" = NEW."slotPolicyId"
   AND capacity_slot."slotKey" = requested.slot ->> 'slotId'
   AND capacity_slot."operationalLocationId" = NEW."selectedOperationalLocationId"
  JOIN "LocalDeliveryLocationIdentity" identity
    ON identity."operationalLocationId" = capacity_slot."operationalLocationId"
   AND identity."active" = true;

  IF JSONB_ARRAY_LENGTH(canonical_slots) <> slot_count THEN
    RAISE EXCEPTION 'V4 quote canonical slot reconstruction is incomplete';
  END IF;
  NEW."slotSnapshot" := JSONB_BUILD_OBJECT(
    'policy', NEW."slotSnapshot" -> 'policy',
    'slots', canonical_slots
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_delivery_quote_20_v4_capacity_slot_guard
BEFORE INSERT ON "WalkingDeliveryQuote"
FOR EACH ROW
WHEN (NEW."schemaVersion" = 'orderpro.walking-delivery-quote.v2')
EXECUTE FUNCTION validate_walking_quote_v4_capacity_slots();

-- A future slot cannot be closed while it still owns capacity. The row lock
-- taken by UPDATE also serializes against new holds, whose validator locks the
-- same slot before checking availability.
CREATE OR REPLACE FUNCTION validate_walking_capacity_slot() RETURNS trigger AS $$
DECLARE
  policy_location_id UUID;
  policy_status "DeliveryPolicyStatus";
  policy_active_days "WalkingWeekday"[];
  policy_lead_time_minutes INTEGER;
  policy_effective_from TIMESTAMP(3);
  policy_effective_to TIMESTAMP(3);
  location_time_zone VARCHAR(64);
BEGIN
  SELECT
    policy."locationId", policy."status", policy."activeDays",
    policy."leadTimeMinutes", policy."effectiveFrom", policy."effectiveTo",
    location."timeZone"
  INTO
    policy_location_id, policy_status, policy_active_days,
    policy_lead_time_minutes, policy_effective_from, policy_effective_to,
    location_time_zone
  FROM "SlotPolicy" policy
  JOIN "OperationalLocation" location ON location."id" = policy."locationId"
  WHERE policy."id" = NEW."slotPolicyId";
  IF policy_location_id IS DISTINCT FROM NEW."operationalLocationId" THEN
    RAISE EXCEPTION 'Capacity slot location does not match its slot policy';
  END IF;
  IF NEW."status" = 'OPEN' AND policy_status IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'Open capacity slots require a published slot policy';
  END IF;
  IF NEW."status" = 'OPEN' AND
     (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'OPEN') AND (
       location_time_zone IS NULL OR BTRIM(location_time_zone) = '' OR
       policy_lead_time_minutes IS NULL OR policy_effective_from IS NULL OR
       NEW."startsAt" < CURRENT_TIMESTAMP +
         (policy_lead_time_minutes * INTERVAL '1 minute') OR
       NEW."startsAt" < policy_effective_from OR
       (policy_effective_to IS NOT NULL AND NEW."endsAt" > policy_effective_to) OR
       CASE EXTRACT(
         DOW FROM (
           NEW."startsAt" AT TIME ZONE 'UTC' AT TIME ZONE location_time_zone
         )
       )::INTEGER
         WHEN 0 THEN 'SUNDAY'::"WalkingWeekday"
         WHEN 1 THEN 'MONDAY'::"WalkingWeekday"
         WHEN 2 THEN 'TUESDAY'::"WalkingWeekday"
         WHEN 3 THEN 'WEDNESDAY'::"WalkingWeekday"
         WHEN 4 THEN 'THURSDAY'::"WalkingWeekday"
         WHEN 5 THEN 'FRIDAY'::"WalkingWeekday"
         WHEN 6 THEN 'SATURDAY'::"WalkingWeekday"
       END <> ALL(policy_active_days)
     ) THEN
    RAISE EXCEPTION 'Open capacity slot is outside its published temporal policy';
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
    IF OLD."status" = 'OPEN' AND NEW."status" IN ('CLOSED', 'CANCELLED') AND
       OLD."endsAt" > CURRENT_TIMESTAMP AND EXISTS (
         SELECT 1 FROM "WalkingCapacityHold" hold
         WHERE hold."capacitySlotId" = OLD."id"
           AND (
             hold."status" = 'CONFIRMED' OR
             (hold."status" = 'HELD' AND hold."expiresAt" > CURRENT_TIMESTAMP)
           )
       ) THEN
      RAISE EXCEPTION 'Cannot close or cancel a future capacity slot with active holds';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Holds are bound to the exact canonical slot shown by their quote. Availability
-- is required only while acquiring/confirming capacity; terminal release and
-- expiry remain possible after an operator closes a past slot.
CREATE OR REPLACE FUNCTION validate_walking_capacity_hold() RETURNS trigger AS $$
DECLARE
  write_enabled BOOLEAN;
  quote_client_id VARCHAR(120);
  quote_location_id UUID;
  quote_slot_policy_id UUID;
  quote_slot_snapshot JSONB;
  quote_capacity_seconds INTEGER;
  quote_expires_at TIMESTAMP(3);
  quote_inventory_ready_at TIMESTAMP(3);
  quote_bookable BOOLEAN;
  version_hold_ttl_seconds INTEGER;
  slot_policy_id UUID;
  slot_key VARCHAR(160);
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
    q."clientId", q."selectedOperationalLocationId", q."slotPolicyId",
    q."slotSnapshot", q."capacityRequiredSeconds", q."expiresAt",
    q."inventoryReadyAt", q."bookable", v."holdTtlSeconds"
  INTO
    quote_client_id, quote_location_id, quote_slot_policy_id,
    quote_slot_snapshot, quote_capacity_seconds, quote_expires_at,
    quote_inventory_ready_at, quote_bookable, version_hold_ttl_seconds
  FROM "WalkingDeliveryQuote" q
  JOIN "FeeCalculationPolicyVersion" v ON v."id" = q."feePolicyVersionId"
  WHERE q."id" = NEW."quoteId";

  IF quote_client_id IS NULL OR quote_client_id IS DISTINCT FROM NEW."clientId" OR
     quote_bookable IS DISTINCT FROM true OR quote_slot_policy_id IS NULL OR
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

  SELECT
    slot."slotPolicyId", slot."slotKey", slot."operationalLocationId",
    slot."startsAt", slot."endsAt", slot."capacitySeconds", slot."status"
  INTO
    slot_policy_id, slot_key, slot_location_id,
    slot_starts_at, slot_ends_at, slot_capacity, slot_status
  FROM "WalkingCapacitySlot" slot
  WHERE slot."id" = NEW."capacitySlotId"
  FOR UPDATE;

  IF slot_key IS NULL OR slot_policy_id IS DISTINCT FROM quote_slot_policy_id OR
     slot_location_id IS DISTINCT FROM quote_location_id OR NOT EXISTS (
       SELECT 1
       FROM JSONB_ARRAY_ELEMENTS(
         CASE
           WHEN JSONB_TYPEOF(quote_slot_snapshot -> 'slots') = 'array'
             THEN quote_slot_snapshot -> 'slots'
           ELSE '[]'::JSONB
         END
       ) AS offered(entry)
       WHERE offered.entry ->> 'slotId' = slot_key
         AND offered.entry ->> 'locationId' = (
           SELECT identity."externalLocationId"
           FROM "LocalDeliveryLocationIdentity" identity
           WHERE identity."operationalLocationId" = slot_location_id
             AND identity."active" = true
         )
         AND ((offered.entry ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') = slot_starts_at
         AND ((offered.entry ->> 'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC') = slot_ends_at
         AND (offered.entry ->> 'remainingCapacitySeconds')::NUMERIC >=
             NEW."reservedCapacitySeconds"
     ) THEN
    RAISE EXCEPTION 'Capacity hold must use the exact slot offered by its quote';
  END IF;

  IF NEW."status" IN ('HELD', 'CONFIRMED') AND (
       slot_status IS DISTINCT FROM 'OPEN' OR slot_starts_at <= CURRENT_TIMESTAMP OR
       (quote_inventory_ready_at IS NOT NULL AND slot_starts_at < quote_inventory_ready_at)
     ) THEN
    RAISE EXCEPTION 'Capacity slot is unavailable for the selected location or inventory readiness';
  END IF;

  IF NEW."status" IN ('HELD', 'CONFIRMED') THEN
    SELECT COALESCE(SUM(hold."reservedCapacitySeconds"), 0)
    INTO active_capacity
    FROM "WalkingCapacityHold" hold
    WHERE hold."capacitySlotId" = NEW."capacitySlotId"
      AND hold."id" <> NEW."id"
      AND (
        hold."status" = 'CONFIRMED' OR
        (hold."status" = 'HELD' AND hold."expiresAt" > CURRENT_TIMESTAMP)
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

-- The original BEFORE trigger mutated the balance before the reservation line
-- existed, which made a strong ledger-to-business-reference check impossible.
-- Keep validation/canonicalization in BEFORE and apply the ledger projection in
-- an AFTER trigger, where the immutable allocation line is already visible.
CREATE OR REPLACE FUNCTION validate_walking_inventory_reservation_line() RETURNS trigger AS $$
DECLARE
  write_enabled BOOLEAN;
  reservation_status "WalkingInventoryReservationStatus";
  reservation_expires_at TIMESTAMP(3);
  delivery_location_id UUID;
  balance_product_id UUID;
  balance_lot_id UUID;
  balance_owner_id UUID;
  balance_node_id UUID;
  balance_container_id UUID;
  balance_storage_id UUID;
  balance_available DECIMAL(18, 3);
  container_code VARCHAR(16);
  storage_code TEXT;
BEGIN
  SELECT "enabled" INTO write_enabled FROM "FeatureFlag"
  WHERE "key" = 'local_delivery_v4.inventory_reservation_writes';
  IF write_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Local-delivery v4 inventory reservation writes are disabled';
  END IF;

  SELECT r."status", r."expiresAt", r."deliveryLocationId"
  INTO reservation_status, reservation_expires_at, delivery_location_id
  FROM "WalkingInventoryReservation" r WHERE r."id" = NEW."reservationId"
  FOR UPDATE;
  IF reservation_status IS DISTINCT FROM 'HELD' OR
     reservation_expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Inventory lines require an active HELD reservation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" line
    WHERE line."id" = NEW."id" OR
          (line."reservationId" = NEW."reservationId" AND
           line."lineNumber" = NEW."lineNumber")
  ) THEN
    RAISE EXCEPTION 'Duplicate inventory reservation line rejected before stock mutation';
  END IF;

  SELECT
    balance."productId", balance."inventoryLotId",
    balance."inventoryOwnerLocationId", balance."inventoryNodeId",
    balance."containerId", balance."storageLocationId", balance."available"
  INTO
    balance_product_id, balance_lot_id, balance_owner_id, balance_node_id,
    balance_container_id, balance_storage_id, balance_available
  FROM "InventoryNodeBalance" balance
  WHERE balance."id" = NEW."inventoryNodeBalanceId"
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
    SELECT container."code" INTO container_code
    FROM "Container" container
    WHERE container."id" = NEW."containerId"
      AND container."currentLocationId" = NEW."inventoryNodeId";
    IF container_code IS NULL THEN
      RAISE EXCEPTION 'Inventory box does not belong to the physical inventory node';
    END IF;
  END IF;
  IF NEW."storageLocationId" IS NOT NULL THEN
    SELECT storage."code" INTO storage_code
    FROM "StorageLocation" storage
    WHERE storage."id" = NEW."storageLocationId"
      AND storage."operationalLocationId" = NEW."inventoryNodeId";
    IF storage_code IS NULL THEN
      RAISE EXCEPTION 'Inventory bin does not belong to the physical inventory node';
    END IF;
  END IF;
  NEW."warehouseBoxId" := container_code;
  NEW."binId" := storage_code;

  IF NEW."quantity" > balance_available THEN
    RAISE EXCEPTION 'Inventory reservation would oversubscribe certified physical stock';
  END IF;
  IF NEW."inventoryNodeId" IS DISTINCT FROM delivery_location_id AND
     NEW."transferStatus" NOT IN (
       'TRANSFER_REQUIRED', 'REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'READY'
     ) THEN
    RAISE EXCEPTION 'Inventory outside the delivery store must be marked for transfer';
  END IF;
  IF NEW."inventoryNodeId" = delivery_location_id AND
     NEW."transferStatus" NOT IN ('NOT_REQUIRED', 'READY') THEN
    RAISE EXCEPTION 'Inventory already at the delivery store cannot require transfer';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION apply_walking_inventory_reservation_line_balance() RETURNS trigger AS $$
DECLARE
  reservation_status "WalkingInventoryReservationStatus";
  reservation_expires_at TIMESTAMP(3);
  reservation_correlation_id VARCHAR(120);
  balance "InventoryNodeBalance"%ROWTYPE;
  ledger_idempotency_key TEXT;
  ledger_sequence BIGINT;
BEGIN
  SELECT reservation."status", reservation."expiresAt", reservation."correlationId"
  INTO reservation_status, reservation_expires_at, reservation_correlation_id
  FROM "WalkingInventoryReservation" reservation
  WHERE reservation."id" = NEW."reservationId"
  FOR UPDATE;
  IF reservation_status IS DISTINCT FROM 'HELD' OR
     reservation_expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Inventory allocation requires an active HELD reservation';
  END IF;

  SELECT node_balance.* INTO balance
  FROM "InventoryNodeBalance" node_balance
  WHERE node_balance."id" = NEW."inventoryNodeBalanceId"
  FOR UPDATE;
  IF balance."id" IS NULL OR balance."available" < NEW."quantity" OR
     balance."productId" IS DISTINCT FROM NEW."productId" OR
     balance."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId" OR
     balance."inventoryOwnerLocationId" IS DISTINCT FROM NEW."inventoryOwnerLocationId" OR
     balance."inventoryNodeId" IS DISTINCT FROM NEW."inventoryNodeId" OR
     balance."containerId" IS DISTINCT FROM NEW."containerId" OR
     balance."storageLocationId" IS DISTINCT FROM NEW."storageLocationId" THEN
    RAISE EXCEPTION 'Inventory allocation cannot mutate unavailable or mismatched stock';
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
    JSONB_BUILD_OBJECT(
      'reservationId', NEW."reservationId",
      'inventoryNodeBalanceId', NEW."inventoryNodeBalanceId",
      'availableBefore', balance."available",
      'availableAfter', balance."available" - NEW."quantity",
      'reservedBefore', balance."reserved",
      'reservedAfter', balance."reserved" + NEW."quantity"
    ),
    NEW."createdAt"
  ) RETURNING "sequence" INTO ledger_sequence;

  UPDATE "InventoryNodeBalance"
  SET
    "available" = "available" - NEW."quantity",
    "reserved" = "reserved" + NEW."quantity",
    "ledgerSequence" = ledger_sequence,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."inventoryNodeBalanceId"
    AND "available" >= NEW."quantity";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory reservation would oversubscribe certified physical stock';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_inventory_reservation_line_20_apply_balance
AFTER INSERT ON "WalkingInventoryReservationLine"
FOR EACH ROW EXECUTE FUNCTION apply_walking_inventory_reservation_line_balance();

-- InventoryNodeBalance is a certified projection, not an independently mutable
-- stock table. Each initial state and each delta must point to the exact ledger
-- entry that created it.
CREATE OR REPLACE FUNCTION validate_inventory_node_balance() RETURNS trigger AS $$
DECLARE
  lot_product_id UUID;
  lot_owner_id UUID;
  container_node_id UUID;
  container_storage_id UUID;
  storage_node_id UUID;
  ledger "InventoryLedgerEntry"%ROWTYPE;
  available_delta DECIMAL(18, 3);
  reserved_delta DECIMAL(18, 3);
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

  SELECT entry.* INTO ledger
  FROM "InventoryLedgerEntry" entry
  WHERE entry."sequence" = NEW."ledgerSequence";
  IF ledger."id" IS NULL OR
     ledger."productId" IS DISTINCT FROM NEW."productId" OR
     ledger."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId" OR
     ledger."containerId" IS DISTINCT FROM NEW."containerId" OR
     ledger."toLocationId" IS DISTINCT FROM NEW."inventoryNodeId" OR
     ledger."toStorageLocationId" IS DISTINCT FROM NEW."storageLocationId" OR
     ledger."metadata" ->> 'inventoryNodeBalanceId' IS DISTINCT FROM NEW."id"::TEXT THEN
    RAISE EXCEPTION 'Inventory-node balance must reference its exact physical ledger event';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF ledger."eventType" IS DISTINCT FROM 'OPENING_BALANCE' OR
       ledger."fromAvailabilityState" IS NOT NULL OR
       ledger."toAvailabilityState" IS DISTINCT FROM 'AVAILABLE_ONLINE' OR
       ledger."businessReferenceType" IS DISTINCT FROM 'InventoryNodeBalance' OR
       ledger."businessReferenceId" IS DISTINCT FROM NEW."id"::TEXT OR
       ledger."fromLocationId" IS NOT NULL OR
       ledger."fromStorageLocationId" IS NOT NULL OR
       ledger."quantity" IS DISTINCT FROM NEW."onHand" OR
       NEW."available" IS DISTINCT FROM NEW."onHand" OR
       NEW."reserved" <> 0 OR NEW."damaged" <> 0 OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'Initial inventory-node balance requires a matching opening-balance ledger event';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."productId" IS DISTINCT FROM OLD."productId" OR
     NEW."inventoryLotId" IS DISTINCT FROM OLD."inventoryLotId" OR
     NEW."inventoryOwnerLocationId" IS DISTINCT FROM OLD."inventoryOwnerLocationId" OR
     NEW."inventoryNodeId" IS DISTINCT FROM OLD."inventoryNodeId" OR
     NEW."containerId" IS DISTINCT FROM OLD."containerId" OR
     NEW."storageLocationId" IS DISTINCT FROM OLD."storageLocationId" THEN
    RAISE EXCEPTION 'Inventory-node balance identity is immutable';
  END IF;
  IF NEW."version" <> OLD."version" + 1 OR
     NEW."ledgerSequence" <= OLD."ledgerSequence" THEN
    RAISE EXCEPTION 'Inventory-node balance update requires a newer ledger event and optimistic version';
  END IF;
  IF NEW."onHand" IS DISTINCT FROM OLD."onHand" OR
     NEW."damaged" IS DISTINCT FROM OLD."damaged" OR
     ledger."fromLocationId" IS DISTINCT FROM NEW."inventoryNodeId" OR
     ledger."fromStorageLocationId" IS DISTINCT FROM NEW."storageLocationId" THEN
    RAISE EXCEPTION 'Reservation ledger events cannot alter physical on-hand or damaged stock';
  END IF;

  available_delta := NEW."available" - OLD."available";
  reserved_delta := NEW."reserved" - OLD."reserved";
  IF ledger."eventType" = 'RESERVED' THEN
    IF ledger."fromAvailabilityState" IS DISTINCT FROM 'AVAILABLE_ONLINE' OR
       ledger."toAvailabilityState" IS DISTINCT FROM 'RESERVED' OR
       ledger."businessReferenceType" IS DISTINCT FROM 'WalkingInventoryReservationLine' OR
       ledger."idempotencyKey" IS DISTINCT FROM
         'walking-v4:reservation-line:' || ledger."businessReferenceId" || ':reserved' OR
       available_delta IS DISTINCT FROM -ledger."quantity" OR
       reserved_delta IS DISTINCT FROM ledger."quantity" OR
       NOT (ledger."metadata" @> JSONB_BUILD_OBJECT(
         'availableBefore', OLD."available",
         'availableAfter', NEW."available",
         'reservedBefore', OLD."reserved",
         'reservedAfter', NEW."reserved"
       )) OR NOT EXISTS (
         SELECT 1
         FROM "WalkingInventoryReservationLine" line
         JOIN "WalkingInventoryReservation" reservation
           ON reservation."id" = line."reservationId"
         WHERE line."id"::TEXT = ledger."businessReferenceId"
           AND line."inventoryNodeBalanceId" = NEW."id"
           AND line."productId" = NEW."productId"
           AND line."inventoryLotId" = NEW."inventoryLotId"
           AND line."containerId" IS NOT DISTINCT FROM NEW."containerId"
           AND line."storageLocationId" IS NOT DISTINCT FROM NEW."storageLocationId"
           AND line."quantity" = ledger."quantity"
           AND reservation."correlationId" = ledger."correlationId"
           AND ledger."metadata" ->> 'reservationId' = reservation."id"::TEXT
       ) THEN
      RAISE EXCEPTION 'Reserved balance delta does not match its ledger entry';
    END IF;
  ELSIF ledger."eventType" = 'RESERVATION_RELEASED' THEN
    IF ledger."fromAvailabilityState" IS DISTINCT FROM 'RESERVED' OR
       ledger."toAvailabilityState" IS DISTINCT FROM 'AVAILABLE_ONLINE' OR
       ledger."businessReferenceType" IS DISTINCT FROM 'WalkingInventoryReservation' OR
       ledger."idempotencyKey" IS DISTINCT FROM
         'walking-v4:reservation:' || ledger."businessReferenceId" ||
         ':balance:' || NEW."id"::TEXT || ':released' OR
       available_delta IS DISTINCT FROM ledger."quantity" OR
       reserved_delta IS DISTINCT FROM -ledger."quantity" OR
       NOT (ledger."metadata" @> JSONB_BUILD_OBJECT(
         'availableBefore', OLD."available",
         'availableAfter', NEW."available",
         'reservedBefore', OLD."reserved",
         'reservedAfter', NEW."reserved"
       )) OR NOT EXISTS (
         SELECT 1
         FROM "WalkingInventoryReservation" reservation
         WHERE reservation."id"::TEXT = ledger."businessReferenceId"
           AND reservation."correlationId" = ledger."correlationId"
           AND ledger."quantity" = (
             SELECT COALESCE(SUM(line."quantity"), 0)
             FROM "WalkingInventoryReservationLine" line
             WHERE line."reservationId" = reservation."id"
               AND line."inventoryNodeBalanceId" = NEW."id"
           )
       ) THEN
      RAISE EXCEPTION 'Released balance delta does not match its ledger entry';
    END IF;
  ELSE
    RAISE EXCEPTION 'Inventory-node balance accepts only certified reservation ledger deltas';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
