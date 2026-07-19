-- Preserve the external owner/node identities exactly as they were resolved
-- when inventory evidence was quoted. The internal UUIDs remain the canonical
-- foreign keys; these columns are immutable historical snapshots.
ALTER TABLE "WalkingDeliveryQuoteInventoryLine"
  ADD COLUMN "inventoryOwnerExternalLocationId" VARCHAR(64),
  ADD COLUMN "inventoryNodeExternalId" VARCHAR(64);

-- Existing evidence predates the explicit snapshot columns. Temporarily remove
-- only the update guard while the migration derives the same canonical external
-- identity precedence used by the application: local-delivery identity,
-- OperationalLocation.publicId, then the stable location code.
DROP TRIGGER walking_quote_inventory_line_no_update
  ON "WalkingDeliveryQuoteInventoryLine";

UPDATE "WalkingDeliveryQuoteInventoryLine" line
SET "inventoryOwnerExternalLocationId" =
  COALESCE(identity."externalLocationId", location."publicId", location."code")
FROM "OperationalLocation" location
LEFT JOIN "LocalDeliveryLocationIdentity" identity
  ON identity."operationalLocationId" = location."id"
WHERE line."inventoryOwnerLocationId" = location."id";

UPDATE "WalkingDeliveryQuoteInventoryLine" line
SET "inventoryNodeExternalId" =
  COALESCE(identity."externalLocationId", location."publicId", location."code")
FROM "OperationalLocation" location
LEFT JOIN "LocalDeliveryLocationIdentity" identity
  ON identity."operationalLocationId" = location."id"
WHERE line."inventoryNodeId" = location."id";

UPDATE "WalkingDeliveryQuoteInventoryLine"
SET "snapshot" = COALESCE("snapshot", '{}'::JSONB) || JSONB_BUILD_OBJECT(
  'inventoryOwnerExternalLocationId', "inventoryOwnerExternalLocationId",
  'inventoryNodeExternalId', "inventoryNodeExternalId"
);

CREATE TRIGGER walking_quote_inventory_line_no_update
BEFORE UPDATE ON "WalkingDeliveryQuoteInventoryLine"
FOR EACH ROW EXECUTE FUNCTION reject_walking_quote_inventory_line_mutation();

ALTER TABLE "WalkingDeliveryQuoteInventoryLine"
  ADD CONSTRAINT "WalkingQuoteInventoryLine_owner_external_pair"
    CHECK (
      ("inventoryOwnerLocationId" IS NULL AND
       "inventoryOwnerExternalLocationId" IS NULL) OR
      ("inventoryOwnerLocationId" IS NOT NULL AND
       "inventoryOwnerExternalLocationId" IS NOT NULL AND
       BTRIM("inventoryOwnerExternalLocationId") <> '')
    ),
  ADD CONSTRAINT "WalkingQuoteInventoryLine_node_external_pair"
    CHECK (
      ("inventoryNodeId" IS NULL AND "inventoryNodeExternalId" IS NULL) OR
      ("inventoryNodeId" IS NOT NULL AND "inventoryNodeExternalId" IS NOT NULL AND
       BTRIM("inventoryNodeExternalId") <> '')
    );

CREATE OR REPLACE FUNCTION validate_walking_quote_inventory_line() RETURNS trigger AS $$
DECLARE
  quote_status "WalkingInventoryReadinessStatus";
  owner_external_id VARCHAR(64);
  node_external_id VARCHAR(64);
  container_location_id UUID;
  container_storage_id UUID;
BEGIN
  SELECT q."inventoryReadinessStatus" INTO quote_status
  FROM "WalkingDeliveryQuote" q WHERE q."id" = NEW."quoteId";
  IF quote_status IS NULL OR quote_status = 'NOT_EVALUATED' THEN
    RAISE EXCEPTION 'Inventory line requires an evaluated quote inventory status';
  END IF;

  IF NEW."inventoryOwnerLocationId" IS NULL THEN
    IF NEW."inventoryOwnerExternalLocationId" IS NOT NULL THEN
      RAISE EXCEPTION 'Quote inventory owner external identity requires its canonical location';
    END IF;
  ELSE
    SELECT COALESCE(identity."externalLocationId", location."publicId", location."code")
    INTO owner_external_id
    FROM "OperationalLocation" location
    LEFT JOIN "LocalDeliveryLocationIdentity" identity
      ON identity."operationalLocationId" = location."id"
    WHERE location."id" = NEW."inventoryOwnerLocationId";

    IF owner_external_id IS NULL OR BTRIM(owner_external_id) = '' THEN
      RAISE EXCEPTION 'Quote inventory owner has no canonical external identity';
    END IF;
    IF NEW."inventoryOwnerExternalLocationId" IS NOT NULL AND
       NEW."inventoryOwnerExternalLocationId" IS DISTINCT FROM owner_external_id THEN
      RAISE EXCEPTION 'Quote inventory owner external identity does not match its canonical location';
    END IF;
    NEW."inventoryOwnerExternalLocationId" := owner_external_id;
  END IF;

  IF NEW."inventoryNodeId" IS NULL THEN
    IF NEW."inventoryNodeExternalId" IS NOT NULL THEN
      RAISE EXCEPTION 'Quote inventory node external identity requires its canonical location';
    END IF;
  ELSE
    SELECT COALESCE(identity."externalLocationId", location."publicId", location."code")
    INTO node_external_id
    FROM "OperationalLocation" location
    LEFT JOIN "LocalDeliveryLocationIdentity" identity
      ON identity."operationalLocationId" = location."id"
    WHERE location."id" = NEW."inventoryNodeId";

    IF node_external_id IS NULL OR BTRIM(node_external_id) = '' THEN
      RAISE EXCEPTION 'Quote inventory node has no canonical external identity';
    END IF;
    IF NEW."inventoryNodeExternalId" IS NOT NULL AND
       NEW."inventoryNodeExternalId" IS DISTINCT FROM node_external_id THEN
      RAISE EXCEPTION 'Quote inventory node external identity does not match its canonical location';
    END IF;
    NEW."inventoryNodeExternalId" := node_external_id;
  END IF;

  IF NEW."containerId" IS NOT NULL THEN
    SELECT container."currentLocationId", container."storageLocationId"
    INTO container_location_id, container_storage_id
    FROM "Container" container WHERE container."id" = NEW."containerId";
    IF NEW."inventoryNodeId" IS DISTINCT FROM container_location_id OR
       NEW."storageLocationId" IS DISTINCT FROM container_storage_id THEN
      RAISE EXCEPTION 'Quote inventory physical node/container/bin references disagree';
    END IF;
  END IF;

  NEW."snapshot" := JSONB_BUILD_OBJECT(
    'variantId', NEW."variantId", 'productId', NEW."productId",
    'quantity', NEW."quantity", 'readinessStatus', NEW."readinessStatus",
    'inventoryOwnerLocationId', NEW."inventoryOwnerLocationId",
    'inventoryOwnerExternalLocationId', NEW."inventoryOwnerExternalLocationId",
    'inventoryNodeId', NEW."inventoryNodeId",
    'inventoryNodeExternalId', NEW."inventoryNodeExternalId",
    'containerId', NEW."containerId", 'storageLocationId', NEW."storageLocationId",
    'transferStatus', NEW."transferStatus", 'earliestReadyAt', NEW."earliestReadyAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Check all READY/TRANSFER_REQUIRED lines as an aggregate per exact physical
-- tuple. A quote certifies sufficient available stock, but deliberately does
-- not choose a lot or InventoryNodeBalance; allocation remains a hold-time
-- decision under locks.
CREATE FUNCTION assert_walking_quote_inventory_availability(target_quote_id UUID)
RETURNS void AS $$
DECLARE
  requirement RECORD;
  available_quantity DECIMAL(18, 3);
BEGIN
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
  LOOP
    IF requirement.product_id IS NULL OR requirement.owner_id IS NULL OR
       requirement.node_id IS NULL OR
       (requirement.container_id IS NULL AND requirement.storage_id IS NULL) THEN
      RAISE EXCEPTION
        'Quote READY/TRANSFER_REQUIRED inventory requires complete certified physical evidence';
    END IF;

    -- Lock every compatible certified projection in deterministic order before
    -- calculating its aggregate availability. This closes the quote/reservation
    -- race without selecting a specific lot or balance for the quote.
    PERFORM balance."id"
    FROM "InventoryNodeBalance" balance
    JOIN "Product" product ON product."id" = balance."productId"
    JOIN "InventoryLedgerEntry" ledger ON ledger."sequence" = balance."ledgerSequence"
    WHERE balance."productId" = requirement.product_id
      AND balance."inventoryOwnerLocationId" = requirement.owner_id
      AND balance."inventoryNodeId" = requirement.node_id
      AND balance."containerId" IS NOT DISTINCT FROM requirement.container_id
      AND balance."storageLocationId" IS NOT DISTINCT FROM requirement.storage_id
      AND balance."available" > 0
      AND product."active" = true
      AND ledger."productId" = balance."productId"
      AND ledger."inventoryLotId" = balance."inventoryLotId"
      AND ledger."containerId" IS NOT DISTINCT FROM balance."containerId"
      AND ledger."toLocationId" = balance."inventoryNodeId"
      AND ledger."toStorageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
      AND ledger."metadata" ->> 'inventoryNodeBalanceId' = balance."id"::TEXT
    ORDER BY balance."id"
    FOR SHARE OF balance;

    SELECT COALESCE(SUM(balance."available"), 0)
    INTO available_quantity
    FROM "InventoryNodeBalance" balance
    JOIN "Product" product ON product."id" = balance."productId"
    JOIN "InventoryLedgerEntry" ledger ON ledger."sequence" = balance."ledgerSequence"
    WHERE balance."productId" = requirement.product_id
      AND balance."inventoryOwnerLocationId" = requirement.owner_id
      AND balance."inventoryNodeId" = requirement.node_id
      AND balance."containerId" IS NOT DISTINCT FROM requirement.container_id
      AND balance."storageLocationId" IS NOT DISTINCT FROM requirement.storage_id
      AND balance."available" > 0
      AND product."active" = true
      AND ledger."productId" = balance."productId"
      AND ledger."inventoryLotId" = balance."inventoryLotId"
      AND ledger."containerId" IS NOT DISTINCT FROM balance."containerId"
      AND ledger."toLocationId" = balance."inventoryNodeId"
      AND ledger."toStorageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
      AND ledger."metadata" ->> 'inventoryNodeBalanceId' = balance."id"::TEXT;

    IF available_quantity < requirement.required_quantity THEN
      RAISE EXCEPTION
        'Quote READY/TRANSFER_REQUIRED inventory requires sufficient certified compatible available balance';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_walking_quote_inventory_availability() RETURNS trigger AS $$
DECLARE
  target_quote_id UUID;
BEGIN
  target_quote_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."quoteId" ELSE NEW."quoteId" END;
  PERFORM assert_walking_quote_inventory_availability(target_quote_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER walking_quote_inventory_availability_check
AFTER INSERT OR UPDATE OR DELETE ON "WalkingDeliveryQuoteInventoryLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_walking_quote_inventory_availability();

-- Refuse to carry pre-migration quote evidence that would fail the new runtime
-- barrier. In a normal rollout this set is empty because v4 writes are gated.
DO $$
DECLARE
  quote_record RECORD;
BEGIN
  FOR quote_record IN
    SELECT DISTINCT line."quoteId" AS quote_id
    FROM "WalkingDeliveryQuoteInventoryLine" line
  LOOP
    PERFORM assert_walking_quote_inventory_availability(quote_record.quote_id);
  END LOOP;
END;
$$;

-- Persist the exact order-location decision used by the hold workflow. Existing
-- rows, if any, receive an explicit legacy marker rather than a fabricated
-- modern decision version.
ALTER TABLE "WalkingInventoryReservation"
  ADD COLUMN "orderLocationDecisionCode" VARCHAR(120) NOT NULL
    DEFAULT 'legacy_backfill',
  ADD COLUMN "orderLocationDecisionVersion" VARCHAR(120) NOT NULL
    DEFAULT 'legacy-unversioned-v0',
  ADD COLUMN "inventoryAllocationStrategyId" VARCHAR(120) NOT NULL
    DEFAULT 'legacy_backfill',
  ADD COLUMN "inventoryAllocationStrategyVersion" VARCHAR(120) NOT NULL
    DEFAULT 'legacy-unversioned-v0';

ALTER TABLE "WalkingInventoryReservation"
  ALTER COLUMN "orderLocationDecisionCode" DROP DEFAULT,
  ALTER COLUMN "orderLocationDecisionVersion" DROP DEFAULT,
  ALTER COLUMN "inventoryAllocationStrategyId" DROP DEFAULT,
  ALTER COLUMN "inventoryAllocationStrategyVersion" DROP DEFAULT,
  ADD CONSTRAINT "WalkingInventoryReservation_decision_nonempty"
    CHECK (
      BTRIM("orderLocationDecisionCode") <> '' AND
      BTRIM("orderLocationDecisionVersion") <> '' AND
      BTRIM("inventoryAllocationStrategyId") <> '' AND
      BTRIM("inventoryAllocationStrategyVersion") <> ''
    );

CREATE FUNCTION protect_walking_inventory_reservation_decision() RETURNS trigger AS $$
BEGIN
  IF BTRIM(NEW."orderLocationDecisionCode") = '' OR
     BTRIM(NEW."orderLocationDecisionVersion") = '' OR
     BTRIM(NEW."inventoryAllocationStrategyId") = '' OR
     BTRIM(NEW."inventoryAllocationStrategyVersion") = '' THEN
    RAISE EXCEPTION 'Inventory reservation requires versioned location and allocation decisions';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW."orderLocationDecisionCode" IS DISTINCT FROM OLD."orderLocationDecisionCode" OR
       NEW."orderLocationDecisionVersion" IS DISTINCT FROM OLD."orderLocationDecisionVersion" OR
       NEW."inventoryAllocationStrategyId" IS DISTINCT FROM OLD."inventoryAllocationStrategyId" OR
       NEW."inventoryAllocationStrategyVersion" IS DISTINCT FROM OLD."inventoryAllocationStrategyVersion"
     ) THEN
    RAISE EXCEPTION 'Inventory reservation location/allocation decisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER walking_inventory_reservation_decision_immutable
BEFORE INSERT OR UPDATE ON "WalkingInventoryReservation"
FOR EACH ROW EXECUTE FUNCTION protect_walking_inventory_reservation_decision();

CREATE OR REPLACE FUNCTION audit_walking_inventory_reservation_lifecycle() RETURNS trigger AS $$
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
    action_name, 'WalkingInventoryReservation', NEW."id"::TEXT, location."code",
    NEW."correlationId", COALESCE(NEW."releaseReason"::TEXT, NEW."status"::TEXT),
    CASE WHEN TG_OP = 'UPDATE' THEN JSONB_BUILD_OBJECT('status', OLD."status", 'version', OLD."version") ELSE NULL END,
    JSONB_BUILD_OBJECT(
      'quoteId', NEW."quoteId", 'capacityHoldId', NEW."capacityHoldId",
      'orderLocationId', NEW."orderLocationExternalId",
      'orderLocationDecisionCode', NEW."orderLocationDecisionCode",
      'orderLocationDecisionVersion', NEW."orderLocationDecisionVersion",
      'inventoryAllocationStrategyId', NEW."inventoryAllocationStrategyId",
      'inventoryAllocationStrategyVersion', NEW."inventoryAllocationStrategyVersion",
      'deliveryLocationId', NEW."deliveryLocationExternalId",
      'status', NEW."status", 'expiresAt', NEW."expiresAt",
      'confirmedOrderId', NEW."confirmedOrderId", 'version', NEW."version"
    ), CURRENT_TIMESTAMP
  FROM "OperationalLocation" location WHERE location."id" = NEW."deliveryLocationId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
