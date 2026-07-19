BEGIN;

-- This migration follows the temporary weakened validator introduced at 12:00.
-- It is only safe to proceed automatically when no schema-v2 inventory evidence
-- could have been accepted during that window. Any such row requires an explicit
-- operator audit before this migration may be retried.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "WalkingDeliveryQuoteInventoryLine" line
    JOIN "WalkingDeliveryQuote" quote ON quote."id" = line."quoteId"
    WHERE quote."schemaVersion" = 'orderpro.walking-delivery-quote.v2'
  ) THEN
    RAISE EXCEPTION
      'V4_INVENTORY_VALIDATION_MANUAL_AUDIT_REQUIRED: existing schema-v2 quote inventory evidence may have been created under weakened validation';
  END IF;
END;
$$;

-- Acquire every certified balance lock for the quote in one global UUID order.
-- Group validation happens only after that phase and never acquires row locks,
-- eliminating cross-group lock-order inversions. A physical tuple still needs
-- one balance that can satisfy its complete quantity; lots are never summed.
CREATE OR REPLACE FUNCTION assert_walking_quote_inventory_availability(target_quote_id UUID)
RETURNS void AS $$
DECLARE
  requirement RECORD;
  has_sufficient_balance BOOLEAN;
BEGIN
  PERFORM balance."id"
  FROM "InventoryNodeBalance" balance
  JOIN "Product" product ON product."id" = balance."productId"
  JOIN "InventoryLedgerEntry" ledger ON ledger."sequence" = balance."ledgerSequence"
  WHERE product."active" = true
    AND ledger."productId" = balance."productId"
    AND ledger."inventoryLotId" = balance."inventoryLotId"
    AND ledger."containerId" IS NOT DISTINCT FROM balance."containerId"
    AND ledger."toLocationId" = balance."inventoryNodeId"
    AND ledger."toStorageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
    AND ledger."metadata" ->> 'inventoryNodeBalanceId' = balance."id"::TEXT
    AND EXISTS (
      SELECT 1
      FROM "WalkingDeliveryQuoteInventoryLine" line
      WHERE line."quoteId" = target_quote_id
        AND line."readinessStatus" IN ('READY', 'TRANSFER_REQUIRED')
        AND line."productId" = balance."productId"
        AND line."inventoryOwnerLocationId" = balance."inventoryOwnerLocationId"
        AND line."inventoryNodeId" = balance."inventoryNodeId"
        AND line."containerId" IS NOT DISTINCT FROM balance."containerId"
        AND line."storageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
    )
  ORDER BY balance."id"
  FOR SHARE OF balance;

  FOR requirement IN
    SELECT
      line."productId" AS product_id,
      line."inventoryOwnerLocationId" AS owner_id,
      line."inventoryNodeId" AS node_id,
      line."containerId" AS container_id,
      line."storageLocationId" AS storage_id,
      SUM(line."quantity")::DECIMAL(18, 3) AS required_quantity
    FROM "WalkingDeliveryQuoteInventoryLine" line
    WHERE line."quoteId" = target_quote_id
      AND line."readinessStatus" IN ('READY', 'TRANSFER_REQUIRED')
    GROUP BY
      line."productId", line."inventoryOwnerLocationId", line."inventoryNodeId",
      line."containerId", line."storageLocationId"
    ORDER BY
      line."productId", line."inventoryOwnerLocationId", line."inventoryNodeId",
      line."containerId" NULLS FIRST, line."storageLocationId" NULLS FIRST
  LOOP
    IF requirement.product_id IS NULL OR requirement.owner_id IS NULL OR
       requirement.node_id IS NULL OR
       (requirement.container_id IS NULL AND requirement.storage_id IS NULL) THEN
      RAISE EXCEPTION
        'Quote READY/TRANSFER_REQUIRED inventory requires complete certified physical evidence';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "InventoryNodeBalance" balance
      JOIN "Product" product ON product."id" = balance."productId"
      JOIN "InventoryLedgerEntry" ledger ON ledger."sequence" = balance."ledgerSequence"
      WHERE balance."productId" = requirement.product_id
        AND balance."inventoryOwnerLocationId" = requirement.owner_id
        AND balance."inventoryNodeId" = requirement.node_id
        AND balance."containerId" IS NOT DISTINCT FROM requirement.container_id
        AND balance."storageLocationId" IS NOT DISTINCT FROM requirement.storage_id
        AND balance."available" >= requirement.required_quantity
        AND product."active" = true
        AND ledger."productId" = balance."productId"
        AND ledger."inventoryLotId" = balance."inventoryLotId"
        AND ledger."containerId" IS NOT DISTINCT FROM balance."containerId"
        AND ledger."toLocationId" = balance."inventoryNodeId"
        AND ledger."toStorageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
        AND ledger."metadata" ->> 'inventoryNodeBalanceId' = balance."id"::TEXT
    ) INTO has_sufficient_balance;

    IF has_sufficient_balance IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Quote READY/TRANSFER_REQUIRED inventory requires one sufficient certified compatible balance';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Reservation lines lock their parent reservation first and the selected
-- certified balance second. Expiry is evaluated only after both blocking locks.
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
  validation_now TIMESTAMP(3);
BEGIN
  SELECT "enabled" INTO write_enabled FROM "FeatureFlag"
  WHERE "key" = 'local_delivery_v4.inventory_reservation_writes';
  IF write_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Local-delivery v4 inventory reservation writes are disabled';
  END IF;

  SELECT reservation."status", reservation."expiresAt", reservation."deliveryLocationId"
  INTO reservation_status, reservation_expires_at, delivery_location_id
  FROM "WalkingInventoryReservation" reservation
  WHERE reservation."id" = NEW."reservationId"
  FOR UPDATE;

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

  validation_now := clock_timestamp() AT TIME ZONE 'UTC';

  IF reservation_status IS DISTINCT FROM 'HELD' OR
     reservation_expires_at <= validation_now THEN
    RAISE EXCEPTION 'Inventory lines require an active HELD reservation';
  END IF;
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

-- The AFTER projection repeats the same parent->balance lock order. It captures
-- time after both locks so a transaction-start timestamp cannot revive an
-- allocation that expired while waiting.
CREATE OR REPLACE FUNCTION apply_walking_inventory_reservation_line_balance() RETURNS trigger AS $$
DECLARE
  reservation_status "WalkingInventoryReservationStatus";
  reservation_expires_at TIMESTAMP(3);
  reservation_correlation_id VARCHAR(120);
  balance "InventoryNodeBalance"%ROWTYPE;
  ledger_idempotency_key TEXT;
  ledger_sequence BIGINT;
  validation_now TIMESTAMP(3);
BEGIN
  SELECT reservation."status", reservation."expiresAt", reservation."correlationId"
  INTO reservation_status, reservation_expires_at, reservation_correlation_id
  FROM "WalkingInventoryReservation" reservation
  WHERE reservation."id" = NEW."reservationId"
  FOR UPDATE;

  SELECT node_balance.* INTO balance
  FROM "InventoryNodeBalance" node_balance
  WHERE node_balance."id" = NEW."inventoryNodeBalanceId"
  FOR UPDATE;

  validation_now := clock_timestamp() AT TIME ZONE 'UTC';

  IF reservation_status IS DISTINCT FROM 'HELD' OR
     reservation_expires_at <= validation_now THEN
    RAISE EXCEPTION 'Inventory allocation requires an active HELD reservation';
  END IF;
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
    "updatedAt" = validation_now
  WHERE "id" = NEW."inventoryNodeBalanceId"
    AND "available" >= NEW."quantity";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory reservation would oversubscribe certified physical stock';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Reservation lifecycle validation serializes on its parent capacity hold.
-- Wall-clock expiry is evaluated only after that lock has been acquired.
CREATE OR REPLACE FUNCTION validate_walking_inventory_reservation() RETURNS trigger AS $$
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
  validation_now TIMESTAMP(3);
  balance_update_now TIMESTAMP(3);
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

  SELECT quote."clientId", quote."selectedOperationalLocationId", quote."expiresAt"
  INTO quote_client_id, quote_location_id, quote_expires_at
  FROM "WalkingDeliveryQuote" quote WHERE quote."id" = NEW."quoteId";

  SELECT hold."quoteId", hold."status", hold."expiresAt"
  INTO hold_quote_id, hold_status, hold_expires_at
  FROM "WalkingCapacityHold" hold
  WHERE hold."id" = NEW."capacityHoldId"
  FOR UPDATE;

  validation_now := clock_timestamp() AT TIME ZONE 'UTC';

  IF quote_client_id IS NULL OR quote_client_id IS DISTINCT FROM NEW."clientId" OR
     quote_location_id IS DISTINCT FROM NEW."deliveryLocationId" OR
     quote_expires_at IS NULL OR NEW."expiresAt" > quote_expires_at THEN
    RAISE EXCEPTION 'Inventory reservation does not match its quote and delivery location';
  END IF;
  IF hold_quote_id IS DISTINCT FROM NEW."quoteId" OR
     NEW."expiresAt" IS DISTINCT FROM hold_expires_at OR
     hold_status::TEXT IS DISTINCT FROM NEW."status"::TEXT THEN
    RAISE EXCEPTION 'Inventory reservation requires the same active capacity hold';
  END IF;
  IF NEW."status" IN ('HELD', 'CONFIRMED') AND NEW."expiresAt" <= validation_now THEN
    RAISE EXCEPTION 'Cannot hold or confirm expired inventory';
  END IF;

  SELECT identity."externalLocationId" INTO order_external_id
  FROM "LocalDeliveryLocationIdentity" identity
  WHERE identity."operationalLocationId" = NEW."orderLocationId"
    AND identity."active" = true;
  SELECT identity."externalLocationId" INTO delivery_external_id
  FROM "LocalDeliveryLocationIdentity" identity
  WHERE identity."operationalLocationId" = NEW."deliveryLocationId"
    AND identity."active" = true;
  IF order_external_id IS NULL OR delivery_external_id IS NULL THEN
    RAISE EXCEPTION 'Order and delivery locations require active external identities';
  END IF;
  NEW."orderLocationExternalId" := order_external_id;
  NEW."deliveryLocationExternalId" := delivery_external_id;

  IF NEW."status" = 'CONFIRMED' AND NOT EXISTS (
    SELECT 1 FROM "WalkingInventoryReservationLine" line
    WHERE line."reservationId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Cannot confirm an empty inventory reservation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" IN ('RELEASED', 'EXPIRED') THEN
    FOR release_line IN
      SELECT line."inventoryNodeBalanceId", SUM(line."quantity") AS quantity
      FROM "WalkingInventoryReservationLine" line
      WHERE line."reservationId" = NEW."id"
      GROUP BY line."inventoryNodeBalanceId"
      ORDER BY line."inventoryNodeBalanceId"
    LOOP
      PERFORM 1 FROM "InventoryNodeBalance" balance
      WHERE balance."id" = release_line."inventoryNodeBalanceId"
      FOR UPDATE;
      SELECT balance.* INTO release_balance
      FROM "InventoryNodeBalance" balance
      WHERE balance."id" = release_line."inventoryNodeBalanceId";

      balance_update_now := clock_timestamp() AT TIME ZONE 'UTC';

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
        JSONB_BUILD_OBJECT(
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
        "updatedAt" = balance_update_now
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

-- The slot row is the serialization point for capacity. Capture real wall-clock
-- time only after acquiring that potentially blocking lock, then use the same
-- instant for quote, hold, slot, and active-capacity decisions.
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
  validation_now TIMESTAMP(3);
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
    quote."clientId", quote."selectedOperationalLocationId", quote."slotPolicyId",
    quote."slotSnapshot", quote."capacityRequiredSeconds", quote."expiresAt",
    quote."inventoryReadyAt", quote."bookable", version."holdTtlSeconds"
  INTO
    quote_client_id, quote_location_id, quote_slot_policy_id,
    quote_slot_snapshot, quote_capacity_seconds, quote_expires_at,
    quote_inventory_ready_at, quote_bookable, version_hold_ttl_seconds
  FROM "WalkingDeliveryQuote" quote
  JOIN "FeeCalculationPolicyVersion" version ON version."id" = quote."feePolicyVersionId"
  WHERE quote."id" = NEW."quoteId";

  SELECT
    slot."slotPolicyId", slot."slotKey", slot."operationalLocationId",
    slot."startsAt", slot."endsAt", slot."capacitySeconds", slot."status"
  INTO
    slot_policy_id, slot_key, slot_location_id,
    slot_starts_at, slot_ends_at, slot_capacity, slot_status
  FROM "WalkingCapacitySlot" slot
  WHERE slot."id" = NEW."capacitySlotId"
  FOR UPDATE;

  validation_now := clock_timestamp() AT TIME ZONE 'UTC';

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
     (NEW."expiresAt" <= validation_now OR quote_expires_at <= validation_now) THEN
    RAISE EXCEPTION 'Cannot hold or confirm expired quote capacity';
  END IF;

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
       slot_status IS DISTINCT FROM 'OPEN' OR slot_starts_at <= validation_now OR
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
        (hold."status" = 'HELD' AND hold."expiresAt" > validation_now)
      );
    IF active_capacity + NEW."reservedCapacitySeconds" > slot_capacity THEN
      RAISE EXCEPTION 'CAPACITY_HOLD_FAILED: slot capacity would be oversubscribed';
    END IF;
  END IF;

  IF NEW."status" = 'CONFIRMED' AND validation_now >= NEW."expiresAt" THEN
    RAISE EXCEPTION 'Cannot confirm an expired capacity hold';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
