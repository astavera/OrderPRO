BEGIN;

-- Forward-only restoration: the external identity snapshot migration added
-- canonical owner/node evidence, but its function replacement inadvertently
-- omitted the stronger product, physical, transfer, and readiness checks from
-- the polymorphic-trigger correction. Preserve both sets of invariants here.
CREATE OR REPLACE FUNCTION validate_walking_quote_inventory_line() RETURNS trigger AS $$
DECLARE
  quote_status "WalkingInventoryReadinessStatus";
  delivery_location_id UUID;
  product_variant_id TEXT;
  owner_external_id VARCHAR(64);
  node_external_id VARCHAR(64);
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

  IF quote_status IN ('READY', 'TRANSFER_REQUIRED') AND (
    NEW."productId" IS NULL OR NEW."inventoryOwnerLocationId" IS NULL OR
    NEW."inventoryNodeId" IS NULL OR
    (NEW."containerId" IS NULL AND NEW."storageLocationId" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Resolved quote inventory requires product, owner, node, and physical evidence';
  END IF;

  IF NEW."productId" IS NOT NULL THEN
    SELECT product."squareVariationId" INTO product_variant_id
    FROM "Product" product
    WHERE product."id" = NEW."productId" AND product."active" = true;
    IF product_variant_id IS NULL OR product_variant_id IS DISTINCT FROM NEW."variantId" THEN
      RAISE EXCEPTION 'Quote variant must match its active product identity';
    END IF;
  END IF;

  IF NEW."containerId" IS NOT NULL THEN
    SELECT container."currentLocationId", container."storageLocationId"
    INTO container_location_id, container_storage_id
    FROM "Container" container WHERE container."id" = NEW."containerId";
    IF NEW."inventoryNodeId" IS DISTINCT FROM container_location_id OR
       (NEW."storageLocationId" IS NOT NULL AND
        NEW."storageLocationId" IS DISTINCT FROM container_storage_id) THEN
      RAISE EXCEPTION 'Quote inventory physical node/container/bin references disagree';
    END IF;
  END IF;

  IF NEW."storageLocationId" IS NOT NULL THEN
    SELECT storage."operationalLocationId" INTO storage_location_id
    FROM "StorageLocation" storage WHERE storage."id" = NEW."storageLocationId";
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
    'inventoryOwnerExternalLocationId', NEW."inventoryOwnerExternalLocationId",
    'inventoryNodeId', NEW."inventoryNodeId",
    'inventoryNodeExternalId', NEW."inventoryNodeExternalId",
    'containerId', NEW."containerId", 'storageLocationId', NEW."storageLocationId",
    'transferStatus', NEW."transferStatus", 'earliestReadyAt', NEW."earliestReadyAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Match the non-splitting quote/hold contract: all lines sharing an exact
-- physical tuple are grouped, and one certified balance must satisfy the whole
-- group. Multiple partial lots may not be summed to make a quote appear ready.
-- The qualifying balance is locked deterministically but is not persisted or
-- allocated until hold acquisition.
CREATE OR REPLACE FUNCTION assert_walking_quote_inventory_availability(target_quote_id UUID)
RETURNS void AS $$
DECLARE
  requirement RECORD;
  compatible_balance_id UUID;
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

    compatible_balance_id := NULL;
    SELECT balance."id"
    INTO compatible_balance_id
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
    ORDER BY balance."id"
    LIMIT 1
    FOR SHARE OF balance;

    IF compatible_balance_id IS NULL THEN
      RAISE EXCEPTION
        'Quote READY/TRANSFER_REQUIRED inventory requires one sufficient certified compatible balance';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMIT;
