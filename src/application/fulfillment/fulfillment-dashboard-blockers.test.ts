import { describe, expect, it } from "vitest";
import {
  getStoreOnlinePolicyBlockers,
  getWalkingZoneRecordBlockers,
  getWalkingZoneVersionBlockers,
  type StoreOnlinePolicyReadinessInput,
  type WalkingZoneVersionReadinessInput,
} from "./fulfillment-dashboard-blockers";

const validGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-74, 40.7],
      [-73.9, 40.7],
      [-73.9, 40.8],
      [-74, 40.8],
      [-74, 40.7],
    ],
  ],
};

const store = {
  id: "store-id",
  type: "STORE",
  active: true,
  publicId: "store-3rd-avenue",
} as const;

const validCandidate = {
  location: store,
  feePolicy: {
    locationId: store.id,
    serviceScope: "GENERAL_LOCAL_DELIVERY",
    status: "VALIDATED",
    activeDays: ["MONDAY"],
  },
  slotPolicy: {
    locationId: store.id,
    fulfillmentMode: "WALKING_LOCAL_DELIVERY",
    status: "VALIDATED",
    activeDays: ["MONDAY"],
    leadTimeMinutes: 60,
    cutoffMinuteOfDay: 840,
    capacityPolicyRef: "walking-capacity-v1",
  },
} as const;

const validWalkingVersion: WalkingZoneVersionReadinessInput = {
  id: "zone-version-id",
  postalCodes: ["10028"],
  geometry: validGeometry,
  priority: 200,
  activeDays: ["MONDAY"],
  assignmentStrategy: "FIXED",
  candidates: [validCandidate],
};

const warehouse = {
  id: "warehouse-id",
  type: "WAREHOUSE",
  active: true,
  publicId: "warehouse-englewood",
} as const;

const validStoreOnlinePolicy: StoreOnlinePolicyReadinessInput = {
  id: "store-policy-id",
  status: "PUBLISHED",
  fulfillmentMode: "STORE_RETRIEVAL_SHIPPING",
  onlineSalesEnabled: true,
  availableOnlyAfterStoreActivation: true,
  addedBusinessDays: 2,
  timeZone: "America/New_York",
  pickupWeekdays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  retrievalCutoffMinuteOfDay: 840,
  businessCalendarRef: "US-NY-BUSINESS-DAYS",
  sourceLocation: store,
  consolidationLocation: warehouse,
};

function codes(blockers: readonly { code: string }[]) {
  return blockers.map(({ code }) => code);
}

describe("walking-zone dashboard blockers", () => {
  it("accepts a complete FIXED version", () => {
    expect(getWalkingZoneVersionBlockers(validWalkingVersion)).toEqual([]);
  });

  it("shows missing geometry, priority and service days separately", () => {
    expect(
      codes(
        getWalkingZoneVersionBlockers({
          ...validWalkingVersion,
          geometry: null,
          priority: null,
          activeDays: [],
        }),
      ),
    ).toEqual([
      "WALKING_GEOMETRY_REQUIRED",
      "WALKING_PRIORITY_REQUIRED",
      "WALKING_ACTIVE_DAYS_REQUIRED",
    ]);
  });

  it("rejects invalid strategy candidate counts", () => {
    expect(
      codes(
        getWalkingZoneVersionBlockers({
          ...validWalkingVersion,
          assignmentStrategy: "FIXED",
          candidates: [validCandidate, { ...validCandidate, location: { ...store, id: "store-2" } }],
        }),
      ),
    ).toContain("WALKING_FIXED_CANDIDATE_COUNT_INVALID");

    expect(
      codes(
        getWalkingZoneVersionBlockers({
          ...validWalkingVersion,
          assignmentStrategy: "NEAREST_WALKING_ROUTE",
        }),
      ),
    ).toContain("WALKING_NEAREST_CANDIDATE_COUNT_INVALID");
  });

  it("identifies balloon/incomplete fees and incomplete walking slots", () => {
    const blockers = getWalkingZoneVersionBlockers({
      ...validWalkingVersion,
      candidates: [
        {
          ...validCandidate,
          feePolicy: {
            ...validCandidate.feePolicy,
            serviceScope: "BALLOON_DELIVERY",
            status: "DRAFT_INCOMPLETE",
          },
          slotPolicy: {
            ...validCandidate.slotPolicy,
            status: "DRAFT_INCOMPLETE",
            activeDays: [],
            cutoffMinuteOfDay: null,
            capacityPolicyRef: null,
          },
        },
      ],
    });

    expect(codes(blockers)).toEqual([
      "WALKING_FEE_POLICY_SCOPE_INVALID",
      "WALKING_FEE_POLICY_INCOMPLETE",
      "WALKING_SLOT_POLICY_INCOMPLETE",
    ]);
    expect(blockers.at(-1)?.details).toEqual(["status", "activeDays", "cutoffMinuteOfDay", "capacityPolicyRef"]);
  });

  it("reports a missing current version without hiding an existing latest draft", () => {
    expect(
      codes(
        getWalkingZoneRecordBlockers({
          id: "zone-id",
          currentVersionNumber: 3,
          currentVersionId: null,
          latestVersionId: "latest-draft-id",
        }),
      ),
    ).toEqual(["WALKING_CURRENT_VERSION_MISSING"]);
  });
});

describe("store-online dashboard blockers", () => {
  it("accepts a complete published Englewood retrieval policy", () => {
    expect(getStoreOnlinePolicyBlockers(validStoreOnlinePolicy)).toEqual([]);
  });

  it("keeps customer promises blocked without calendar, cutoff and pickup cadence", () => {
    const blockers = getStoreOnlinePolicyBlockers({
      ...validStoreOnlinePolicy,
      businessCalendarRef: null,
      retrievalCutoffMinuteOfDay: null,
      pickupWeekdays: [],
    });

    expect(codes(blockers)).toEqual([
      "STORE_ONLINE_BUSINESS_CALENDAR_REQUIRED",
      "STORE_ONLINE_CUTOFF_REQUIRED",
      "STORE_ONLINE_PICKUP_CADENCE_REQUIRED",
    ]);
  });

  it("surfaces an incomplete disabled draft independently of schedule blockers", () => {
    const blockers = getStoreOnlinePolicyBlockers({
      ...validStoreOnlinePolicy,
      status: "DRAFT_INCOMPLETE",
      onlineSalesEnabled: false,
    });

    expect(codes(blockers)).toEqual(["STORE_ONLINE_POLICY_INCOMPLETE", "STORE_ONLINE_SALES_DISABLED"]);
  });
});
