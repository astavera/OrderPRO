import { describe, expect, it } from "vitest";
import {
  evaluateWalkingDeliveryQuote,
  WalkingQuoteEvaluationError,
  type EvaluateWalkingDeliveryQuoteDependencies,
  type PersistWalkingQuoteInput,
  type WalkingQuoteConfiguration,
  type WalkingQuoteResult,
  type WalkingQuoteStore,
} from "./evaluate-walking-delivery-quote";

const METERS_TO_FEET = 3.280839895013123;
const THIRD = "store-3rd-avenue";
const EIGHTY_SIXTH = "store-86th-street";
const SERVICE_AT = "2026-07-20T14:00:00-04:00";

const geometry = {
  type: "Polygon" as const,
  coordinates: [[
    [-74, 40.7],
    [-73.9, 40.7],
    [-73.9, 40.9],
    [-74, 40.9],
    [-74, 40.7],
  ]] as const,
};

const tiers = [
  { id: "tier-free", tierCode: "UP_TO_1200_FT" as const, minimumExclusiveFeet: null, maximumInclusiveFeet: 1_200, feeCents: 0, automaticQuote: true, reasonCode: "ELIGIBLE" as const },
  { id: "tier-10", tierCode: "UP_TO_2300_FT" as const, minimumExclusiveFeet: 1_200, maximumInclusiveFeet: 2_300, feeCents: 1_000, automaticQuote: true, reasonCode: "ELIGIBLE" as const },
  { id: "tier-15", tierCode: "UP_TO_3250_FT" as const, minimumExclusiveFeet: 2_300, maximumInclusiveFeet: 3_250, feeCents: 1_500, automaticQuote: true, reasonCode: "ELIGIBLE" as const },
  { id: "tier-review", tierCode: "OVER_3250_FT_MANAGER_REVIEW" as const, minimumExclusiveFeet: 3_250, maximumInclusiveFeet: null, feeCents: null, automaticQuote: false, reasonCode: "MANAGER_REVIEW" as const },
];

function zone(postalCode: string, assignmentStrategy: "FIXED" | "NEAREST_WALKING_ROUTE", locationIds: string[]) {
  return {
    id: `zone-${postalCode}`,
    versionId: `zone-version-${postalCode}`,
    postalCodes: [postalCode],
    priority: 100,
    serviceMode: "WALKING" as const,
    assignmentStrategy,
    locationIds,
    geometry,
    activeDays: ["MONDAY" as const],
    feePolicyByLocation: Object.fromEntries(locationIds.map((id) => [id, `local-fee-${id}`])),
    slotPolicyByLocation: Object.fromEntries(locationIds.map((id) => [id, `slot-${id}`])),
    status: "PUBLISHED" as const,
  };
}

const configuration: WalkingQuoteConfiguration = {
  walkingPublicationId: "walking-publication-v1",
  zones: [
    zone("10021", "FIXED", [THIRD]),
    zone("10028", "FIXED", [EIGHTY_SIXTH]),
    zone("10075", "NEAREST_WALKING_ROUTE", [THIRD, EIGHTY_SIXTH]),
  ],
  locations: [
    { locationId: THIRD, point: [-73.958, 40.77] },
    { locationId: EIGHTY_SIXTH, point: [-73.956, 40.78] },
  ],
  feePolicyVersion: {
    id: "fee-policy-version-calibration-v1",
    policyId: "WALKING_ROUTE_DISTANCE_STANDARD",
    versionKey: "DRAFT_CALIBRATION_V1",
    status: "PUBLISHED",
    environment: "STAGING",
    strategy: "WALKING_ROUTE_DISTANCE",
    tiers,
  },
};

class MemoryQuoteStore implements WalkingQuoteStore {
  private readonly records = new Map<string, { requestHash: string; result: WalkingQuoteResult }>();
  lastSavedInput: PersistWalkingQuoteInput | null = null;

  async findByIdempotency(input: { clientId: string; idempotencyKey: string }) {
    return this.records.get(`${input.clientId}:${input.idempotencyKey}`) ?? null;
  }

  async save(input: PersistWalkingQuoteInput) {
    this.lastSavedInput = input;
    const result: WalkingQuoteResult = { ...input, quoteId: `quote-${this.records.size + 1}`, replayed: false };
    this.records.set(`${input.clientId}:${input.idempotencyKey}`, { requestHash: input.requestHash, result });
    return result;
  }
}

function dependencies(input: {
  address: string;
  postalCode: string;
  routeFeetByLocation: Record<string, number>;
  slotsByLocation?: Record<string, number>;
}) {
  const store = new MemoryQuoteStore();
  const slotCalls: string[] = [];
  const routeCalls: string[] = [];
  const result: EvaluateWalkingDeliveryQuoteDependencies & { store: MemoryQuoteStore } = {
    geocoder: {
      async geocodeExactAddress(address) {
        expect(address).toBe(input.address);
        return {
          normalizedAddress: `${input.address}, New York, NY ${input.postalCode}`,
          point: [-73.95, 40.8],
          postalCode: input.postalCode,
          provider: "fake-geocoder",
          matchType: "EXACT_ADDRESS",
          ambiguous: false,
        };
      },
    },
    configuration: { async getPublishedConfiguration() { return configuration; } },
    router: {
      async getWalkingRoute({ origin }) {
        const locationId = origin[0] === -73.958 ? THIRD : EIGHTY_SIXTH;
        routeCalls.push(locationId);
        return {
          provider: "fake-walking-router",
          profile: "walking",
          distanceMeters: input.routeFeetByLocation[locationId] / METERS_TO_FEET,
          durationSeconds: locationId === THIRD ? 600 : 700,
        };
      },
    },
    slots: {
      async getAvailableSlots({ locationId }) {
        slotCalls.push(locationId);
        return Array.from({ length: input.slotsByLocation?.[locationId] ?? 1 }, (_, index) => ({
          slotId: `${locationId}-${index + 1}`,
          locationId,
          startsAt: SERVICE_AT,
          endsAt: "2026-07-20T15:00:00-04:00",
          remainingCapacity: 1,
        }));
      },
    },
    store,
    now: () => new Date("2026-07-16T20:00:00.000Z"),
  };
  return { result, slotCalls, routeCalls };
}

function command(address: string, idempotencyKey = "quote-command-1") {
  return {
    clientId: "ecommerce-staging",
    idempotencyKey,
    correlationId: "correlation-1",
    address,
    serviceAt: SERVICE_AT,
    subtotalCents: 5_000,
    environment: "STAGING" as const,
  };
}

describe("walking delivery quote orchestration", () => {
  it("quotes 310 E 75th St from Third Avenue at the $10 tier", async () => {
    const fixture = dependencies({
      address: "310 E 75th St",
      postalCode: "10021",
      routeFeetByLocation: { [THIRD]: 1_760, [EIGHTY_SIXTH]: 9_999 },
    });
    const result = await evaluateWalkingDeliveryQuote(command("310 E 75th St"), fixture.result);

    expect(result).toMatchObject({
      selectedLocationId: THIRD,
      zoneVersionId: "zone-version-10021",
      feeCents: 1_000,
      tierId: "UP_TO_2300_FT",
      reasonCode: "ELIGIBLE",
      routingProfile: "walking",
    });
    expect(result.distanceFeet).toBeCloseTo(1_760, 8);
    expect(fixture.routeCalls).toEqual([THIRD]);
    expect(fixture.slotCalls).toEqual([THIRD]);
  });

  it("quotes 316 E 82nd St from 86th Street at the $15 tier", async () => {
    const fixture = dependencies({
      address: "316 E 82nd St",
      postalCode: "10028",
      routeFeetByLocation: { [THIRD]: 9_999, [EIGHTY_SIXTH]: 2_816 },
    });
    const result = await evaluateWalkingDeliveryQuote(command("316 E 82nd St"), fixture.result);

    expect(result).toMatchObject({ selectedLocationId: EIGHTY_SIXTH, feeCents: 1_500, tierId: "UP_TO_3250_FT" });
    expect(result.distanceFeet).toBeCloseTo(2_816, 8);
    expect(fixture.slotCalls).toEqual([EIGHTY_SIXTH]);
  });

  it("routes both 10075 candidates and never requests slots from the losing store", async () => {
    const fixture = dependencies({
      address: "10075 shared address",
      postalCode: "10075",
      routeFeetByLocation: { [THIRD]: 1_700, [EIGHTY_SIXTH]: 1_500 },
    });
    const result = await evaluateWalkingDeliveryQuote(command("10075 shared address"), fixture.result);

    expect(result.selectedLocationId).toBe(EIGHTY_SIXTH);
    expect(fixture.routeCalls).toEqual([THIRD, EIGHTY_SIXTH]);
    expect(fixture.slotCalls).toEqual([EIGHTY_SIXTH]);
  });

  it("does not request or return slots above 3,250 ft", async () => {
    const fixture = dependencies({
      address: "Manager review address",
      postalCode: "10021",
      routeFeetByLocation: { [THIRD]: 3_250.01, [EIGHTY_SIXTH]: 9_999 },
    });
    const result = await evaluateWalkingDeliveryQuote(command("Manager review address"), fixture.result);

    expect(result).toMatchObject({
      reasonCode: "MANAGER_REVIEW",
      feeCents: null,
      tierId: "OVER_3250_FT_MANAGER_REVIEW",
      slots: [],
    });
    expect(fixture.slotCalls).toEqual([]);
  });

  it("returns NO_AVAILABLE_SLOTS without falling back in 10075", async () => {
    const fixture = dependencies({
      address: "No slots shared address",
      postalCode: "10075",
      routeFeetByLocation: { [THIRD]: 1_000, [EIGHTY_SIXTH]: 1_100 },
      slotsByLocation: { [THIRD]: 0, [EIGHTY_SIXTH]: 2 },
    });
    const result = await evaluateWalkingDeliveryQuote(command("No slots shared address"), fixture.result);

    expect(result).toMatchObject({ selectedLocationId: THIRD, reasonCode: "NO_AVAILABLE_SLOTS", slots: [] });
    expect(fixture.slotCalls).toEqual([THIRD]);
    expect(fixture.result.store.lastSavedInput).toMatchObject({
      slotPolicyId: `slot-${THIRD}`,
      slotSnapshot: [],
    });
  });

  it("replays an identical idempotency key and rejects changed content", async () => {
    const fixture = dependencies({
      address: "310 E 75th St",
      postalCode: "10021",
      routeFeetByLocation: { [THIRD]: 1_760, [EIGHTY_SIXTH]: 9_999 },
    });
    const first = await evaluateWalkingDeliveryQuote(command("310 E 75th St"), fixture.result);
    const replay = await evaluateWalkingDeliveryQuote(command("310 E 75th St"), fixture.result);
    expect(replay).toMatchObject({ quoteId: first.quoteId, replayed: true });
    expect(fixture.routeCalls).toHaveLength(1);

    await expect(
      evaluateWalkingDeliveryQuote({ ...command("310 E 75th St"), subtotalCents: 5_001 }, fixture.result),
    ).rejects.toEqual(expect.objectContaining<Partial<WalkingQuoteEvaluationError>>({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("does not persist an offer when the geocoded address is outside every active polygon", async () => {
    const fixture = dependencies({
      address: "Outside address",
      postalCode: "99999",
      routeFeetByLocation: { [THIRD]: 1_000, [EIGHTY_SIXTH]: 1_000 },
    });

    await expect(evaluateWalkingDeliveryQuote(command("Outside address"), fixture.result)).rejects.toMatchObject({
      code: "OUTSIDE_WALKING_ZONE",
    });
    expect(fixture.result.store.lastSavedInput).toBeNull();
    expect(fixture.routeCalls).toEqual([]);
    expect(fixture.slotCalls).toEqual([]);
  });
});
