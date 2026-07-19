import { describe, expect, it, vi } from "vitest";
import { InMemoryLocalDeliveryQuoteStore } from "../../infrastructure/local-delivery-v4/in-memory-stores";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
  LocalDeliveryApplicationError,
  LocalDeliveryRoutingError,
  type EvaluateLocalDeliveryQuoteCommand,
  type LocalDeliveryInventoryLineEvidence,
  type LocalDeliveryQuoteDependencies,
} from "./contracts";
import { evaluateLocalDeliveryQuote } from "./evaluate-local-delivery-quote";

const now = new Date("2026-07-16T16:00:00.000Z");
const thirdAvenue = {
  locationId: "third_avenue",
  name: "3rd Avenue Store",
  address: "1243 3rd Ave, New York, NY 10021",
  coordinates: { latitude: 40.769473514641, longitude: -73.960715741688 },
  priority: 1,
} as const;
const east86th = {
  locationId: "east_86th_street",
  name: "86th Street Store",
  address: "112 E 86th St, New York, NY 10028",
  coordinates: { latitude: 40.779922307507, longitude: -73.956748615355 },
  priority: 2,
} as const;

const thirdAvenueOperationalId = "00000000-0000-4000-8000-000000000072";
const englewoodOperationalId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000101";
const thirdAvenueContainerId = "00000000-0000-4000-8000-000000000201";
const englewoodContainerId = "00000000-0000-4000-8000-000000000202";

function inventoryLine(
  overrides: Partial<LocalDeliveryInventoryLineEvidence> = {},
): LocalDeliveryInventoryLineEvidence {
  return {
    lineNumber: 1,
    variantId: "variant-1",
    productId,
    quantity: 1,
    readinessStatus: "READY",
    inventoryOwnerLocationId: thirdAvenueOperationalId,
    inventoryOwnerExternalLocationId: thirdAvenue.locationId,
    inventoryNodeId: thirdAvenueOperationalId,
    inventoryNodeExternalId: thirdAvenue.locationId,
    containerId: thirdAvenueContainerId,
    storageLocationId: null,
    transferStatus: "NOT_REQUIRED",
    earliestReadyAt: null,
    ...overrides,
  };
}

const command: EvaluateLocalDeliveryQuoteCommand = {
  clientId: "storefront-staging",
  idempotencyKey: "quote-request-001",
  correlationId: "correlation-001",
  environment: "STAGING",
  address: {
    line1: "500 E 80th St",
    line2: null,
    city: "New York",
    state: "NY",
    postalCode: "10075",
    country: "US",
  },
  cartLines: [{ variantId: "variant-1", quantity: 1 }],
  requestedDate: "2026-07-20",
};

function dependencies(overrides: Partial<LocalDeliveryQuoteDependencies> = {}) {
  let quoteId = 0;
  const slots = vi.fn(async (input: { locationId: string }) => [{
    slotId: "slot-1",
    locationId: input.locationId,
    startsAt: "2026-07-20T14:00:00-04:00",
    endsAt: "2026-07-20T15:00:00-04:00",
    remainingCapacitySeconds: 20_000,
  }]);
  const result: LocalDeliveryQuoteDependencies = {
    now: () => now,
    quotes: new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteId}`),
    geocoder: {
      async geocodeExactAddress({ address }) {
        return {
          normalizedAddress: {
            ...address,
            borough: "Manhattan",
            postalCode: address.postalCode.slice(0, 5),
          },
          coordinates: { latitude: 40.775, longitude: -73.95 },
          postalCode: address.postalCode.slice(0, 5),
          exactAddress: true,
          ambiguous: false,
          isManhattan: true,
          provider: "geocoder",
        };
      },
    },
    policy: {
      async getPublishedPolicy() {
        return {
          policyId: "walking-route-distance-v4-base-10",
          feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
          zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
          environment: "STAGING",
          strategy: "WALKING_ROUTE_DISTANCE",
          distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
          distanceUnit: "FEET",
          routingMode: "WALKING",
          currency: "USD",
          routingProfile: "walking",
          quoteTtlSeconds: 900,
          holdTtlSeconds: 300,
          preparationBufferSeconds: 180,
          handoffBufferSeconds: 120,
        };
      },
      async getAssignment({ postalCode }) {
        if (postalCode === "10075") {
          return { rule: "NEAREST_WALKING_ROUTE", candidates: [thirdAvenue, east86th] };
        }
        return {
          rule: "FIXED_POSTAL_ZONE",
          candidates: [postalCode === "10021" || postalCode === "10065" ? thirdAvenue : east86th],
        };
      },
      async evaluateFee({ walkingDistanceFeet }) {
        return walkingDistanceFeet > 4_250
          ? { feeCents: 2_500, tierId: "whole-zone-25" }
          : { feeCents: 1_400, tierId: "extended-14" };
      },
    },
    zone: { async containsPoint() { return true; } },
    router: {
      async getWalkingRoute({ origin }) {
        const feet = origin.latitude === thirdAvenue.coordinates.latitude ? 4_261 : 4_490;
        return {
          provider: "walking-router",
          profile: "walking",
          distanceMeters: feet / 3.280839895013123,
          durationSeconds: feet === 4_261 ? 1_038 : 1_080,
        };
      },
    },
    inventory: {
      async assess() {
        return {
          status: "READY",
          earliestReadyAt: null,
          lines: [inventoryLine()],
        };
      },
    },
    slots: { getAvailableSlots: slots },
    ...overrides,
  };
  return { result, slots };
}

describe("evaluateLocalDeliveryQuote", () => {
  it("routes from both stores for 10075, selects the shortest route and returns round-trip evidence", async () => {
    const fixture = dependencies();
    const quote = await evaluateLocalDeliveryQuote(command, fixture.result);

    expect(quote).toMatchObject({
      eligible: true,
      bookable: true,
      reasonCode: "ELIGIBLE",
      selectedLocationId: "third_avenue",
      assignmentRule: "NEAREST_WALKING_ROUTE",
      walkingDistanceFeet: 4_261,
      roundTripDistanceFeet: 8_522,
      walkingDurationSeconds: 1_038,
      estimatedRoundTripDurationSeconds: 2_076,
      requiredCapacitySeconds: 2_376,
      feeCents: 2_500,
      feeTierId: "whole-zone-25",
      inventoryOwnerLocationIds: ["third_avenue"],
      inventoryNodeIds: ["third_avenue"],
    });
    if (!quote.eligible) throw new Error("expected an offer");
    expect(quote.candidateRoutes).toHaveLength(2);
    expect(quote.candidateRoutes.map(({ locationId }) => locationId)).toEqual([
      "third_avenue",
      "east_86th_street",
    ]);
    expect(quote.candidateRoutes.map(({ locationPriority }) => locationPriority)).toEqual([1, 2]);
    expect(fixture.slots).toHaveBeenCalledTimes(1);
    expect(fixture.slots).toHaveBeenCalledWith(expect.objectContaining({ locationId: "third_avenue" }));
    expect(quote).not.toHaveProperty("persistencePlan");
    const stored = await fixture.result.quotes.findById(quote.quoteId);
    expect(stored?.persistencePlan).toMatchObject({
      kind: "OFFER",
      holdTtlSeconds: 300,
      preparationBufferSeconds: 180,
      handoffBufferSeconds: 120,
      inventoryLines: [{
        productId,
        inventoryOwnerLocationId: thirdAvenueOperationalId,
        inventoryNodeId: thirdAvenueOperationalId,
      }],
    });
  });

  it("binds assignment and fee reads to the same version, environment and calculation instant", async () => {
    const base = dependencies();
    const getAssignment = vi.fn(base.result.policy.getAssignment.bind(base.result.policy));
    const evaluateFee = vi.fn(base.result.policy.evaluateFee.bind(base.result.policy));
    const fixture = dependencies({
      policy: { ...base.result.policy, getAssignment, evaluateFee },
    });

    await evaluateLocalDeliveryQuote(command, fixture.result);

    expect(getAssignment).toHaveBeenCalledWith({
      postalCode: "10075",
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
      environment: "STAGING",
      calculatedAt: now.toISOString(),
    });
    expect(evaluateFee).toHaveBeenCalledWith({
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      environment: "STAGING",
      calculatedAt: now.toISOString(),
      walkingDistanceFeet: 4_261,
    });
  });

  it("does not fall back to the farther store when the selected store has no slots", async () => {
    const slotReader = vi.fn(async () => []);
    const fixture = dependencies({ slots: { getAvailableSlots: slotReader } });
    const quote = await evaluateLocalDeliveryQuote(command, fixture.result);

    expect(quote).toMatchObject({
      eligible: true,
      bookable: false,
      reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION",
      selectedLocationId: "third_avenue",
      availableSlots: [],
    });
    expect(slotReader).toHaveBeenCalledTimes(1);
    expect(slotReader).toHaveBeenCalledWith(expect.objectContaining({ locationId: "third_avenue" }));
  });

  it("fails closed without calculating a fee or querying slots when routing fails", async () => {
    const evaluateFee = vi.fn();
    const slots = vi.fn();
    const base = dependencies();
    const fixture = dependencies({
      policy: { ...base.result.policy, evaluateFee },
      router: {
        async getWalkingRoute() {
          throw new LocalDeliveryRoutingError("ROUTING_PROVIDER_UNAVAILABLE");
        },
      },
      slots: { getAvailableSlots: slots },
    });

    await expect(evaluateLocalDeliveryQuote(command, fixture.result)).rejects.toMatchObject({
      code: "ROUTING_PROVIDER_UNAVAILABLE",
    });
    expect(evaluateFee).not.toHaveBeenCalled();
    expect(slots).not.toHaveBeenCalled();
  });

  it("rejects mixed routing providers for the auditable 10075 comparison", async () => {
    const fixture = dependencies({
      router: {
        async getWalkingRoute({ origin }) {
          return {
            provider: origin.latitude === thirdAvenue.coordinates.latitude ? "router-a" : "router-b",
            profile: "walking",
            distanceMeters: 1_000,
            durationSeconds: 600,
          };
        },
      },
    });
    await expect(evaluateLocalDeliveryQuote(command, fixture.result)).rejects.toMatchObject({
      code: "ROUTING_PROVIDER_UNAVAILABLE",
    });
  });

  it("requires distinct, configured priorities for a possible 10075 tie", async () => {
    const base = dependencies();
    const fixture = dependencies({
      policy: {
        ...base.result.policy,
        async getAssignment() {
          return {
            rule: "NEAREST_WALKING_ROUTE",
            candidates: [thirdAvenue, { ...east86th, priority: thirdAvenue.priority }],
          };
        },
      },
    });
    await expect(evaluateLocalDeliveryQuote(command, fixture.result)).rejects.toMatchObject({
      code: "POLICY_VERSION_UNAVAILABLE",
    });
  });

  it("rejects policy metadata, assignments and fees that drift from the canonical version", async () => {
    const base = dependencies();
    const published = await base.result.policy.getPublishedPolicy({
      environment: "STAGING",
      calculatedAt: now.toISOString(),
    });
    if (!published) throw new Error("expected canonical policy fixture");

    const metadataDrift = dependencies({
      policy: {
        ...base.result.policy,
        async getPublishedPolicy() {
          return { ...published, policyId: "different-policy" } as never;
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, metadataDrift.result),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_UNAVAILABLE" });

    const assignmentDrift = dependencies({
      policy: {
        ...base.result.policy,
        async getAssignment() {
          return { rule: "FIXED_POSTAL_ZONE", candidates: [east86th] };
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, assignmentDrift.result),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_UNAVAILABLE" });

    const feeDrift = dependencies({
      policy: {
        ...base.result.policy,
        async evaluateFee() {
          return { feeCents: 0, tierId: "free-local" };
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, feeDrift.result),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_UNAVAILABLE" });
  });

  it("turns malformed geocoder and policy adapter values into controlled errors", async () => {
    const malformedGeocoder = dependencies({
      geocoder: {
        async geocodeExactAddress() {
          return {
            exactAddress: true,
            ambiguous: false,
            isManhattan: true,
            provider: "geocoder",
            postalCode: "10075",
            normalizedAddress: null,
            coordinates: null,
          } as never;
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, malformedGeocoder.result),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });

    const base = dependencies();
    const nonCanonicalJurisdiction = dependencies({
      geocoder: {
        async geocodeExactAddress(input) {
          const geocode = await base.result.geocoder.geocodeExactAddress(input);
          return geocode && {
            ...geocode,
            normalizedAddress: {
              ...geocode.normalizedAddress,
              borough: "manhattan",
            },
          };
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, nonCanonicalJurisdiction.result),
    ).rejects.toMatchObject({ code: "ADDRESS_NOT_IN_MANHATTAN" });

    const malformedAssignment = dependencies({
      policy: {
        ...base.result.policy,
        async getAssignment() {
          return { rule: "NEAREST_WALKING_ROUTE", candidates: null } as never;
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, malformedAssignment.result),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_UNAVAILABLE" });
  });

  it("rejects wrong-day, past and zero-capacity offers", async () => {
    const malformedSlot = dependencies({
      slots: {
        async getAvailableSlots() {
          return [null] as never;
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, malformedSlot.result),
    ).rejects.toMatchObject({ code: "SLOTS_UNAVAILABLE" });

    const wrongDay = dependencies({
      slots: {
        async getAvailableSlots() {
          return [{
            slotId: "wrong-day",
            locationId: "third_avenue",
            startsAt: "2026-07-21T14:00:00-04:00",
            endsAt: "2026-07-21T15:00:00-04:00",
            remainingCapacitySeconds: 20_000,
          }];
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, wrongDay.result),
    ).rejects.toMatchObject({ code: "SLOTS_UNAVAILABLE" });

    const pastSlot = dependencies({
      now: () => new Date("2026-07-21T16:00:00.000Z"),
    });
    await expect(
      evaluateLocalDeliveryQuote(command, pastSlot.result),
    ).rejects.toMatchObject({ code: "SLOTS_UNAVAILABLE" });

    const base = dependencies();
    const zeroCapacity = dependencies({
      policy: {
        ...base.result.policy,
        async getPublishedPolicy(input) {
          const policy = await base.result.policy.getPublishedPolicy(input);
          return policy && {
            ...policy,
            preparationBufferSeconds: 0,
            handoffBufferSeconds: 0,
          };
        },
        async evaluateFee() {
          return { feeCents: 0, tierId: "free-local" };
        },
      },
      router: {
        async getWalkingRoute() {
          return {
            provider: "walking-router",
            profile: "walking",
            distanceMeters: 0,
            durationSeconds: 0,
          };
        },
      },
    });
    await expect(
      evaluateLocalDeliveryQuote(command, zeroCapacity.result),
    ).rejects.toMatchObject({ code: "DISTANCE_UNAVAILABLE" });
  });

  it("marks TRANSFER_REQUIRED and removes slots before inventory can reach the selected store", async () => {
    const slotReader = vi.fn(async (input: { locationId: string }) => [
      {
        slotId: "slot-too-early",
        locationId: input.locationId,
        startsAt: "2026-07-20T11:00:00-04:00",
        endsAt: "2026-07-20T12:00:00-04:00",
        remainingCapacitySeconds: 20_000,
      },
      {
        slotId: "slot-after-transfer",
        locationId: input.locationId,
        startsAt: "2026-07-20T13:00:00-04:00",
        endsAt: "2026-07-20T14:00:00-04:00",
        remainingCapacitySeconds: 20_000,
      },
    ]);
    const fixture = dependencies({
      inventory: {
        async assess() {
          return {
            status: "TRANSFER_REQUIRED",
            earliestReadyAt: "2026-07-20T12:30:00-04:00",
            lines: [inventoryLine({
              readinessStatus: "TRANSFER_REQUIRED",
              inventoryNodeId: englewoodOperationalId,
              inventoryNodeExternalId: "englewood_warehouse",
              containerId: englewoodContainerId,
              transferStatus: "TRANSFER_REQUIRED",
              earliestReadyAt: "2026-07-20T12:30:00-04:00",
            })],
          };
        },
      },
      slots: { getAvailableSlots: slotReader },
    });

    const quote = await evaluateLocalDeliveryQuote(command, fixture.result);
    expect(quote).toMatchObject({
      eligible: true,
      reasonCode: "TRANSFER_REQUIRED",
      bookable: true,
      inventoryStatus: "TRANSFER_REQUIRED",
      transferEarliestReadyAt: "2026-07-20T12:30:00-04:00",
      availableSlots: [{ slotId: "slot-after-transfer", locationId: "third_avenue" }],
    });
    expect(slotReader).toHaveBeenCalledWith(expect.objectContaining({
      locationId: "third_avenue",
      notBefore: "2026-07-20T12:30:00-04:00",
    }));
  });

  it("keeps the no-slots outcome when the selected store inventory requires transfer", async () => {
    const fixture = dependencies({
      inventory: {
        async assess() {
          return {
            status: "TRANSFER_REQUIRED",
            earliestReadyAt: "2026-07-20T12:30:00-04:00",
            lines: [inventoryLine({
              readinessStatus: "TRANSFER_REQUIRED",
              inventoryNodeId: englewoodOperationalId,
              inventoryNodeExternalId: "englewood_warehouse",
              containerId: englewoodContainerId,
              transferStatus: "TRANSFER_REQUIRED",
              earliestReadyAt: "2026-07-20T12:30:00-04:00",
            })],
          };
        },
      },
      slots: { async getAvailableSlots() { return []; } },
    });

    const quote = await evaluateLocalDeliveryQuote(command, fixture.result);
    expect(quote).toMatchObject({
      eligible: true,
      bookable: false,
      reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION",
      inventoryStatus: "TRANSFER_REQUIRED",
      transferEarliestReadyAt: "2026-07-20T12:30:00-04:00",
      availableSlots: [],
    });
  });

  it("fails closed when inventory lacks persistable physical evidence", async () => {
    const fixture = dependencies({
      inventory: {
        async assess() {
          return {
            status: "READY",
            earliestReadyAt: null,
            lines: [inventoryLine({ containerId: null, storageLocationId: null })],
          };
        },
      },
    });

    await expect(evaluateLocalDeliveryQuote(command, fixture.result)).rejects.toMatchObject({
      code: "INVENTORY_NOT_READY",
    });
  });

  it("returns the exact CONTACT_STORE outcome for an unsupported Manhattan ZIP without routing", async () => {
    const policy = vi.fn();
    const router = vi.fn();
    const fixture = dependencies({
      geocoder: {
        async geocodeExactAddress({ address }) {
          return {
            normalizedAddress: {
              ...address,
              borough: "Manhattan",
              postalCode: "10022",
            },
            coordinates: { latitude: 40.758, longitude: -73.97 },
            postalCode: "10022",
            exactAddress: true,
            ambiguous: false,
            isManhattan: true,
            provider: "geocoder",
          };
        },
      },
      policy: {
        getPublishedPolicy: policy,
        getAssignment: vi.fn(),
        evaluateFee: vi.fn(),
      },
      router: { getWalkingRoute: router },
    });
    const quote = await evaluateLocalDeliveryQuote(command, fixture.result);

    expect(quote).toEqual({
      quoteId: "quote-1",
      replayed: false,
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      normalizedAddress: {
        ...command.address,
        borough: "Manhattan",
        postalCode: "10022",
      },
      coordinates: { latitude: 40.758, longitude: -73.97 },
      postalCode: "10022",
      correlationId: "correlation-001",
      expiresAt: "2026-07-16T16:05:00.000Z",
    });
    expect(policy).not.toHaveBeenCalled();
    expect(router).not.toHaveBeenCalled();
  });

  it("returns ADDRESS_NOT_IN_MANHATTAN before zone or routing evaluation", async () => {
    const base = dependencies();
    const fixture = dependencies({
      geocoder: {
        async geocodeExactAddress(input) {
          const result = await base.result.geocoder.geocodeExactAddress(input);
          return result && { ...result, isManhattan: false };
        },
      },
    });
    await expect(evaluateLocalDeliveryQuote(command, fixture.result)).rejects.toEqual(
      new LocalDeliveryApplicationError("ADDRESS_NOT_IN_MANHATTAN"),
    );
  });
});
