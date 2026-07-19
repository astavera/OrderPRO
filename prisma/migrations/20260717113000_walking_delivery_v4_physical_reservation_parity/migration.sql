-- A hold may allocate a lot/balance only at acquisition time, under row locks,
-- but it must preserve the immutable physical box/bin and transfer evidence
-- that was certified by the quote. Compare null-safe physical tuples so a
-- reservation cannot silently substitute inventory from another container.
-- The current contract is one certified balance per quote line; lineNumber is
-- therefore preserved exactly instead of splitting a line across lots.
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
    SELECT 1
    FROM (
      SELECT ql.*
      FROM "WalkingDeliveryQuoteInventoryLine" ql
      WHERE ql."quoteId" = hold_quote_id
    ) q
    FULL JOIN (
      SELECT rl.*
      FROM "WalkingInventoryReservationLine" rl
      JOIN "WalkingInventoryReservation" reservation
        ON reservation."id" = rl."reservationId"
      WHERE reservation."capacityHoldId" = target_hold_id
    ) r
      ON r."lineNumber" = q."lineNumber"
    WHERE (
        q."lineNumber" IS DISTINCT FROM r."lineNumber" OR
        q."variantId" IS DISTINCT FROM r."variantId" OR
        q."productId" IS DISTINCT FROM r."productId" OR
        q."quantity"::DECIMAL(18, 3) IS DISTINCT FROM r."quantity" OR
        q."inventoryOwnerLocationId" IS DISTINCT FROM r."inventoryOwnerLocationId" OR
        q."inventoryNodeId" IS DISTINCT FROM r."inventoryNodeId" OR
        q."containerId" IS DISTINCT FROM r."containerId" OR
        q."storageLocationId" IS DISTINCT FROM r."storageLocationId" OR
        q."transferStatus" IS DISTINCT FROM r."transferStatus"
      )
  ) THEN
    RAISE EXCEPTION 'Reserved inventory must exactly match quoted physical and transfer evidence';
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
