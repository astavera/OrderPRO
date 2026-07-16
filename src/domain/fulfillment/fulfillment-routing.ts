export const fulfillmentModes = ["WALKING_LOCAL", "WAREHOUSE_SHIPPING"] as const;

export type FulfillmentMode = (typeof fulfillmentModes)[number];

export type FulfillmentRoutingInput = {
  mode: FulfillmentMode;
  originLocationId: string;
  originLocationType: "STORE" | "WAREHOUSE";
  selectedWalkingStoreId?: string;
  consolidationWarehouseId?: string;
  storeRetrievalBusinessDays?: number;
};

export type FulfillmentRoutingResult =
  | {
      eligible: true;
      mode: FulfillmentMode;
      path: string[];
      addedBusinessDays: number;
      requiresStoreRetrieval: boolean;
      promiseBasis: "LOCAL_SLOT" | "CARRIER_ETA";
    }
  | {
      eligible: false;
      mode: FulfillmentMode;
      reasonCode: "INVALID_FULFILLMENT_CONFIGURATION";
    };

/**
 * Resolves the physical fulfillment path without calculating a calendar date.
 * Cutoffs, pickup cadence and holidays are deliberately applied by a separate,
 * versioned business-calendar policy once those commercial inputs are approved.
 */
export function resolveFulfillmentRouting(input: FulfillmentRoutingInput): FulfillmentRoutingResult {
  if (!input.originLocationId.trim()) {
    return { eligible: false, mode: input.mode, reasonCode: "INVALID_FULFILLMENT_CONFIGURATION" };
  }

  if (input.mode === "WALKING_LOCAL") {
    if (
      input.originLocationType !== "STORE" ||
      !input.selectedWalkingStoreId ||
      input.selectedWalkingStoreId !== input.originLocationId
    ) {
      return { eligible: false, mode: input.mode, reasonCode: "INVALID_FULFILLMENT_CONFIGURATION" };
    }

    return {
      eligible: true,
      mode: input.mode,
      path: [input.originLocationId, "CUSTOMER"],
      addedBusinessDays: 0,
      requiresStoreRetrieval: false,
      promiseBasis: "LOCAL_SLOT",
    };
  }

  if (input.originLocationType === "WAREHOUSE") {
    return {
      eligible: true,
      mode: input.mode,
      path: [input.originLocationId, "CARRIER", "CUSTOMER"],
      addedBusinessDays: 0,
      requiresStoreRetrieval: false,
      promiseBasis: "CARRIER_ETA",
    };
  }

  if (
    !input.consolidationWarehouseId ||
    input.consolidationWarehouseId === input.originLocationId ||
    !Number.isInteger(input.storeRetrievalBusinessDays) ||
    (input.storeRetrievalBusinessDays ?? -1) < 0
  ) {
    return { eligible: false, mode: input.mode, reasonCode: "INVALID_FULFILLMENT_CONFIGURATION" };
  }

  return {
    eligible: true,
    mode: input.mode,
    path: [input.originLocationId, input.consolidationWarehouseId, "CARRIER", "CUSTOMER"],
    addedBusinessDays: input.storeRetrievalBusinessDays!,
    requiresStoreRetrieval: true,
    promiseBasis: "CARRIER_ETA",
  };
}

export type OnlineAvailabilityGateState =
  | "UNAVAILABLE"
  | "STAGED"
  | "IN_TRANSIT"
  | "RECEIVED_PENDING_ACTIVATION"
  | "AVAILABLE_ONLINE"
  | "RESERVED"
  | "ALLOCATED"
  | "PICKED"
  | "SOLD"
  | "QUARANTINED"
  | "RETURN_STAGED";

export function canOfferOnline(state: OnlineAvailabilityGateState) {
  return state === "AVAILABLE_ONLINE";
}

export function onlineSellableQuantity(input: { onHand: number; reserved: number; safetyStock: number }) {
  for (const value of [input.onHand, input.reserved, input.safetyStock]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_INVENTORY_QUANTITY");
  }
  return Math.max(0, input.onHand - input.reserved - input.safetyStock);
}
