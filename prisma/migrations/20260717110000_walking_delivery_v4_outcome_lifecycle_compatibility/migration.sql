-- Keep capacity and inventory lifecycle reasons symmetric so the deferred
-- atomic-pair constraint can represent either resource becoming unavailable.
ALTER TYPE "WalkingCapacityHoldReleaseReason"
  ADD VALUE IF NOT EXISTS 'CAPACITY_UNAVAILABLE';

ALTER TYPE "WalkingInventoryReservationReleaseReason"
  ADD VALUE IF NOT EXISTS 'INVENTORY_UNAVAILABLE';

-- A selected store may have transfer-ready inventory but no usable slots.
-- That outcome must remain NO_SLOTS_FOR_SELECTED_LOCATION (and must never
-- silently fall back to another store), while preserving transfer evidence.
ALTER TABLE "WalkingDeliveryQuote"
  DROP CONSTRAINT "WalkingDeliveryQuote_v2_priced_complete_hardened";

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
      ("inventoryReadinessStatus" <> 'TRANSFER_REQUIRED' OR (
        "reasonCode" IN ('TRANSFER_REQUIRED', 'NO_SLOTS_FOR_SELECTED_LOCATION') AND
        "inventoryReadyAt" IS NOT NULL
      )) AND
      ("bookable" = false OR
        ("reasonCode" = 'ELIGIBLE' AND "inventoryReadinessStatus" = 'READY') OR
        ("reasonCode" = 'TRANSFER_REQUIRED' AND "inventoryReadinessStatus" = 'TRANSFER_REQUIRED'))
    )
  );
