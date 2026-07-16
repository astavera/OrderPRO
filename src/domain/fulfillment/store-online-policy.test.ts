import { describe, expect, it } from "vitest";
import { canActivateStoreOnlineFulfillment, validateStoreOnlineFulfillmentPolicy } from "./store-online-policy";

describe("store-backed online fulfillment policy", () => {
  const completePolicy = {
    sourceLocationId: "store-3rd-avenue",
    consolidationLocationId: "warehouse-englewood",
    onlineSalesEnabled: true,
    availableOnlyAfterStoreActivation: true,
    addedBusinessDays: 2,
    businessCalendarCode: "US-NY-BUSINESS-DAYS",
    cutoffLocalTime: "14:00",
    pickupWeekdays: [1, 2, 3, 4, 5],
  } as const;

  it("accepts the approved two-day retrieval shape when its calendar inputs are present", () => {
    expect(validateStoreOnlineFulfillmentPolicy(completePolicy)).toEqual([]);
    expect(canActivateStoreOnlineFulfillment(completePolicy)).toBe(true);
  });

  it("keeps the current policy incomplete while calendar, cutoff and cadence are unknown", () => {
    const blockers = validateStoreOnlineFulfillmentPolicy({
      ...completePolicy,
      onlineSalesEnabled: false,
      businessCalendarCode: null,
      cutoffLocalTime: null,
      pickupWeekdays: [],
    });
    expect(blockers).toEqual([
      "BUSINESS_CALENDAR_REQUIRED",
      "CUTOFF_REQUIRED",
      "PICKUP_SCHEDULE_REQUIRED",
    ]);
  });

  it("requires inventory to be activated at the store before it can be offered online", () => {
    expect(
      validateStoreOnlineFulfillmentPolicy({ ...completePolicy, availableOnlyAfterStoreActivation: false }),
    ).toContain("ACTIVATION_GATE_REQUIRED");
  });
});
