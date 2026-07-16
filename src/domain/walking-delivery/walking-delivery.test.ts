import { describe, expect, it } from "vitest";
import { canonicalJson, stableSha256Digest } from "./canonical-json";
import { evaluateWalkingDelivery } from "./evaluator";
import { pointInWalkingGeometry, validateWalkingGeometry } from "./geometry";
import type { WalkingMultiPolygonGeometry, WalkingPolygonGeometry, WalkingZoneConfiguration } from "./types";
import { validateWalkingZoneConfiguration } from "./validation";

const THIRD_AVENUE = "store-3rd-avenue";
const EIGHTY_SIXTH_STREET = "store-86th-street";

const allDays = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

const serviceArea: WalkingPolygonGeometry = {
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

const baseZone: WalkingZoneConfiguration = {
  id: "walking-10028",
  versionId: "walking-10028-draft-v1",
  postalCodes: ["10028"],
  priority: 200,
  serviceMode: "WALKING",
  assignmentStrategy: "FIXED",
  locationIds: [EIGHTY_SIXTH_STREET],
  geometry: serviceArea,
  activeDays: allDays,
  feePolicyByLocation: {
    [THIRD_AVENUE]: "fee-third",
    [EIGHTY_SIXTH_STREET]: "fee-86th",
  },
  slotPolicyByLocation: {
    [THIRD_AVENUE]: "slot-third",
    [EIGHTY_SIXTH_STREET]: "slot-86th",
  },
  status: "DRAFT",
};

function zone(overrides: Partial<WalkingZoneConfiguration> = {}): WalkingZoneConfiguration {
  return { ...baseZone, ...overrides };
}

const commonEvaluation = {
  point: [-73.95, 40.75] as const,
  postalCode: "10028",
  serviceAt: "2026-07-20T15:00:00-04:00",
  subtotalCents: 10_000,
};

describe("walking delivery geometry", () => {
  const geometryWithHole: WalkingPolygonGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  };

  it("includes the exterior boundary", () => {
    expect(pointInWalkingGeometry([0, 5], geometryWithHole)).toBe(true);
  });

  it("excludes a hole and its boundary", () => {
    expect(pointInWalkingGeometry([5, 5], geometryWithHole)).toBe(false);
    expect(pointInWalkingGeometry([4, 5], geometryWithHole)).toBe(false);
  });

  it("rejects points outside the polygon", () => {
    expect(pointInWalkingGeometry([11, 5], geometryWithHole)).toBe(false);
  });

  it("supports valid MultiPolygon geometry", () => {
    const multiPolygon: WalkingMultiPolygonGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10],
          ],
        ],
      ],
    };

    expect(validateWalkingGeometry(multiPolygon).valid).toBe(true);
    expect(pointInWalkingGeometry([10.5, 10.5], multiPolygon)).toBe(true);
  });

  it("detects open and self-intersecting rings", () => {
    const open = validateWalkingGeometry({
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]],
    });
    const bowTie = validateWalkingGeometry({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 2],
          [0, 2],
          [2, 0],
          [0, 0],
        ],
      ],
    });

    expect(open.issues.map((issue) => issue.code)).toContain("RING_NOT_CLOSED");
    expect(bowTie.issues.map((issue) => issue.code)).toContain("RING_SELF_INTERSECTION");
  });
});

describe("walking delivery configuration", () => {
  it("accepts a valid FIXED zone", () => {
    expect(validateWalkingZoneConfiguration(baseZone)).toEqual({ valid: true, issues: [] });
  });

  it("rejects FIXED with two candidate stores", () => {
    const result = validateWalkingZoneConfiguration(
      zone({ locationIds: [THIRD_AVENUE, EIGHTY_SIXTH_STREET] }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("FIXED_REQUIRES_ONE_LOCATION");
  });
});

describe("walking delivery assignment", () => {
  it("keeps 10028 fixed at 86th Street even when Third Avenue has a shorter route", () => {
    const result = evaluateWalkingDelivery({
      ...commonEvaluation,
      zones: [baseZone],
      routeMetrics: [
        { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.1, walkingDurationMinutes: 2 },
        { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.8, walkingDurationMinutes: 15 },
      ],
    });

    expect(result).toMatchObject({
      eligible: true,
      reasonCode: "ELIGIBLE",
      selectedLocationId: EIGHTY_SIXTH_STREET,
      feePolicyId: "fee-86th",
      slotPolicyId: "slot-86th",
    });
  });

  const sharedZone = zone({
    id: "walking-10075",
    postalCodes: ["10075"],
    priority: 100,
    assignmentStrategy: "NEAREST_WALKING_ROUTE",
    locationIds: [THIRD_AVENUE, EIGHTY_SIXTH_STREET],
  });

  const sharedEvaluation = { ...commonEvaluation, postalCode: "10075", zones: [sharedZone] };

  it("selects Third Avenue in 10075 when its walking route is shorter", () => {
    const result = evaluateWalkingDelivery({
      ...sharedEvaluation,
      routeMetrics: [
        { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.4, walkingDurationMinutes: 9 },
        { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.7, walkingDurationMinutes: 15 },
      ],
    });

    expect(result).toMatchObject({ eligible: true, selectedLocationId: THIRD_AVENUE });
  });

  it("selects 86th Street in 10075 when its walking route is shorter", () => {
    const result = evaluateWalkingDelivery({
      ...sharedEvaluation,
      routeMetrics: [
        { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.9, walkingDurationMinutes: 18 },
        { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.3, walkingDurationMinutes: 7 },
      ],
    });

    expect(result).toMatchObject({ eligible: true, selectedLocationId: EIGHTY_SIXTH_STREET });
  });

  it("breaks a complete route tie by stable locationId", () => {
    const metrics = [
      { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.5, walkingDurationMinutes: 10 },
      { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.5, walkingDurationMinutes: 10 },
    ];

    const result = evaluateWalkingDelivery({ ...sharedEvaluation, routeMetrics: metrics });

    expect(result).toMatchObject({ eligible: true, selectedLocationId: THIRD_AVENUE });
  });

  it("uses walking duration before locationId when distances tie", () => {
    const result = evaluateWalkingDelivery({
      ...sharedEvaluation,
      routeMetrics: [
        { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.5, walkingDurationMinutes: 11 },
        { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.5, walkingDurationMinutes: 9 },
      ],
    });

    expect(result).toMatchObject({ eligible: true, selectedLocationId: EIGHTY_SIXTH_STREET });
  });

  it("returns OUTSIDE_WALKING_ZONE when the point does not match", () => {
    const result = evaluateWalkingDelivery({
      ...sharedEvaluation,
      point: [-73.8, 40.75],
      routeMetrics: [
        { locationId: THIRD_AVENUE, walkingDistanceMiles: 0.5, walkingDurationMinutes: 10 },
        { locationId: EIGHTY_SIXTH_STREET, walkingDistanceMiles: 0.5, walkingDurationMinutes: 10 },
      ],
    });

    expect(result).toEqual({
      eligible: false,
      reasonCode: "OUTSIDE_WALKING_ZONE",
      postalCode: "10075",
      point: [-73.8, 40.75],
    });
  });
});

describe("walking delivery publication digest", () => {
  it("canonicalizes object keys recursively and produces a stable SHA-256 digest", () => {
    const first = {
      schemaVersion: "orderpro.walking-zones.v1",
      versionNumber: 4,
      metadata: { published: true, effectiveTo: null },
    };
    const reordered = {
      metadata: { effectiveTo: null, published: true },
      versionNumber: 4,
      schemaVersion: "orderpro.walking-zones.v1",
    };

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(stableSha256Digest(first)).toBe(stableSha256Digest(reordered));
    expect(stableSha256Digest(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects non-JSON values instead of producing an ambiguous digest", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/Unsupported JSON value/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/Non-finite number/);
  });
});
