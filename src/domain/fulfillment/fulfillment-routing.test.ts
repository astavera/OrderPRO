import { describe, expect, it } from "vitest";
import { canOfferOnline, onlineSellableQuantity, resolveFulfillmentRouting } from "./fulfillment-routing";

describe("fulfillment routing", () => {
  it("routes walking delivery directly from the selected store with no retrieval days", () => {
    expect(
      resolveFulfillmentRouting({
        mode: "WALKING_LOCAL",
        originLocationId: "store-3rd-avenue",
        originLocationType: "STORE",
        selectedWalkingStoreId: "store-3rd-avenue",
        consolidationWarehouseId: "warehouse-englewood",
        storeRetrievalBusinessDays: 2,
      }),
    ).toEqual({
      eligible: true,
      mode: "WALKING_LOCAL",
      path: ["store-3rd-avenue", "CUSTOMER"],
      addedBusinessDays: 0,
      requiresStoreRetrieval: false,
      promiseBasis: "LOCAL_SLOT",
    });
  });

  it("adds two business days when parcel inventory is retrieved from a store through Englewood", () => {
    expect(
      resolveFulfillmentRouting({
        mode: "WAREHOUSE_SHIPPING",
        originLocationId: "store-86th-street",
        originLocationType: "STORE",
        consolidationWarehouseId: "warehouse-englewood",
        storeRetrievalBusinessDays: 2,
      }),
    ).toEqual({
      eligible: true,
      mode: "WAREHOUSE_SHIPPING",
      path: ["store-86th-street", "warehouse-englewood", "CARRIER", "CUSTOMER"],
      addedBusinessDays: 2,
      requiresStoreRetrieval: true,
      promiseBasis: "CARRIER_ETA",
    });
  });

  it("does not add retrieval time to inventory already at the warehouse", () => {
    const result = resolveFulfillmentRouting({
      mode: "WAREHOUSE_SHIPPING",
      originLocationId: "warehouse-englewood",
      originLocationType: "WAREHOUSE",
    });
    expect(result.eligible && result.addedBusinessDays).toBe(0);
  });

  it("rejects walking fulfillment from a different origin store", () => {
    expect(
      resolveFulfillmentRouting({
        mode: "WALKING_LOCAL",
        originLocationId: "store-86th-street",
        originLocationType: "STORE",
        selectedWalkingStoreId: "store-3rd-avenue",
      }),
    ).toMatchObject({ eligible: false, reasonCode: "INVALID_FULFILLMENT_CONFIGURATION" });
  });
});

describe("online availability", () => {
  it("offers inventory only after it is explicitly activated", () => {
    expect(canOfferOnline("IN_TRANSIT")).toBe(false);
    expect(canOfferOnline("RECEIVED_PENDING_ACTIVATION")).toBe(false);
    expect(canOfferOnline("AVAILABLE_ONLINE")).toBe(true);
    expect(canOfferOnline("RESERVED")).toBe(false);
  });

  it("subtracts reservations and safety stock without going below zero", () => {
    expect(onlineSellableQuantity({ onHand: 12, reserved: 3, safetyStock: 2 })).toBe(7);
    expect(onlineSellableQuantity({ onHand: 2, reserved: 2, safetyStock: 3 })).toBe(0);
  });
});
