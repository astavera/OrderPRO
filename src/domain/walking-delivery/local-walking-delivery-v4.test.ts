import { describe, expect, it } from "vitest";
import {
  calculateLocalWalkingDeliveryV4RoundTripMetrics,
  evaluateLocalWalkingDeliveryV4,
  evaluateLocalWalkingDeliveryV4Tier,
  LOCAL_WALKING_DELIVERY_V4_DEFAULT_LOCATION_PRIORITY,
  LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
  LOCAL_WALKING_DELIVERY_V4_LOCATIONS,
  LOCAL_WALKING_DELIVERY_V4_POLICY,
  LOCAL_WALKING_DELIVERY_V4_SUPPORTED_POSTAL_CODES,
  LOCAL_WALKING_DELIVERY_V4_TIERS,
  LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
  type LocalWalkingDeliveryV4CandidateRouteInput,
  type LocalWalkingDeliveryV4Input,
  type LocalWalkingDeliveryV4LocationId,
} from "./local-walking-delivery-v4";

function route(
  locationId: LocalWalkingDeliveryV4LocationId,
  walkingDistanceFeet: number,
  walkingDurationSeconds = 600,
  hasAvailableSlots = true,
): LocalWalkingDeliveryV4CandidateRouteInput {
  return {
    locationId,
    walkingDistanceFeet,
    walkingDurationSeconds,
    hasAvailableSlots,
  };
}

function validInput(
  overrides: Partial<LocalWalkingDeliveryV4Input> = {},
): LocalWalkingDeliveryV4Input {
  return {
    addressIsValid: true,
    isManhattan: true,
    postalCode: "10021",
    isInsidePublishedZone: true,
    candidateRoutes: [route("third_avenue", 1_000)],
    routingProvider: "mock-walking-router",
    routingProfile: "walking",
    routeCalculatedAt: "2026-07-16T16:00:00.000Z",
    ...overrides,
  };
}

describe("Local Walking Delivery v4 canonical policy", () => {
  it("uses the exact external version IDs, staging state and route basis", () => {
    expect(LOCAL_WALKING_DELIVERY_V4_POLICY).toMatchObject({
      id: "walking-route-distance-v4-base-10",
      feePolicyVersionId: "walking-route-distance-v4-base-10-2026-07-16",
      zoneVersionId: "upper-east-side-walking-zones-v1",
      status: "DRAFT",
      environment: "STAGING",
      strategy: "WALKING_ROUTE_DISTANCE",
      distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
      distanceUnit: "FEET",
      routingMode: "WALKING",
      routingProfile: "walking",
      currency: "USD",
    });
    expect(LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID).toBe(
      "walking-route-distance-v4-base-10-2026-07-16",
    );
    expect(LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID).toBe(
      "upper-east-side-walking-zones-v1",
    );
  });

  it("defines the two stores with their exact external IDs and coordinates", () => {
    expect(LOCAL_WALKING_DELIVERY_V4_LOCATIONS).toEqual({
      third_avenue: {
        locationId: "third_avenue",
        name: "3rd Avenue Store",
        address: "1243 3rd Ave, New York, NY 10021",
        latitude: 40.769473514641,
        longitude: -73.960715741688,
      },
      east_86th_street: {
        locationId: "east_86th_street",
        name: "86th Street Store",
        address: "112 E 86th St, New York, NY 10028",
        latitude: 40.779922307507,
        longitude: -73.956748615355,
      },
    });
  });

  it("configures all five ZIP codes and the fixed/shared assignments", () => {
    expect(LOCAL_WALKING_DELIVERY_V4_SUPPORTED_POSTAL_CODES).toEqual([
      "10021",
      "10065",
      "10075",
      "10028",
      "10128",
    ]);
    expect(LOCAL_WALKING_DELIVERY_V4_POLICY.postalAssignments).toEqual({
      fixed: {
        "10021": "third_avenue",
        "10065": "third_avenue",
        "10028": "east_86th_street",
        "10128": "east_86th_street",
      },
      shared: { "10075": ["third_avenue", "east_86th_street"] },
    });
  });

  it("contains ten contiguous tiers and leaves the final tier open", () => {
    expect(LOCAL_WALKING_DELIVERY_V4_TIERS).toHaveLength(10);
    expect(LOCAL_WALKING_DELIVERY_V4_TIERS.at(-1)).toEqual({
      id: "whole-zone-25",
      minimumExclusiveFeet: 4_250,
      maximumInclusiveFeet: null,
      feeCents: 2_500,
    });
    expect(JSON.stringify(LOCAL_WALKING_DELIVERY_V4_POLICY)).not.toContain(
      "MANAGER_REVIEW",
    );
  });
});

describe("Local Walking Delivery v4 fee boundaries", () => {
  it.each([
    [0, "free-local", 0],
    [1_200, "free-local", 0],
    [1_200.01, "base-delivery", 1_000],
    [2_200, "base-delivery", 1_000],
    [2_200.01, "extended-12", 1_200],
    [2_700, "extended-12", 1_200],
    [2_700.01, "extended-14", 1_400],
    [2_950, "extended-14", 1_400],
    [2_950.01, "extended-15", 1_500],
    [3_250, "extended-15", 1_500],
    [3_250.01, "extended-17", 1_700],
    [3_500, "extended-17", 1_700],
    [3_500.01, "extended-19", 1_900],
    [3_750, "extended-19", 1_900],
    [3_750.01, "extended-21", 2_100],
    [4_000, "extended-21", 2_100],
    [4_000.01, "extended-23", 2_300],
    [4_250, "extended-23", 2_300],
    [4_250.01, "whole-zone-25", 2_500],
    [1_000_000, "whole-zone-25", 2_500],
  ] as const)("classifies %s ft as %s at %s cents", (distance, feeTierId, feeCents) => {
    expect(evaluateLocalWalkingDeliveryV4Tier(distance)).toEqual({
      valid: true,
      walkingDistanceFeet: distance,
      feeTierId,
      feeCents,
    });
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid distance %s without guessing a fee",
    (distance) => {
      expect(evaluateLocalWalkingDeliveryV4Tier(distance)).toMatchObject({
        valid: false,
        reasonCode: "INVALID_INPUT",
        feeTierId: null,
        feeCents: null,
      });
    },
  );
});

describe("Local Walking Delivery v4 acceptance routes", () => {
  it("assigns 599 E 85th St / 10028 to 86th Street and charges $21 at 3,924 ft", () => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode: "10028",
          candidateRoutes: [route("east_86th_street", 3_924, 960)],
        }),
      ),
    ).toMatchObject({
      eligible: true,
      assignmentRule: "FIXED_POSTAL_ZONE",
      selectedLocationId: "east_86th_street",
      walkingDistanceFeet: 3_924,
      feeCents: 2_100,
      feeTierId: "extended-21",
      slotLocationId: "east_86th_street",
    });
  });

  it("assigns 500 E 80th St / 10075 to Third Avenue, retains both routes and charges $25", () => {
    const result = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("third_avenue", 4_261, 1_038),
          route("east_86th_street", 4_490, 1_090),
        ],
      }),
    );

    expect(result).toMatchObject({
      eligible: true,
      assignmentRule: "NEAREST_WALKING_ROUTE",
      selectedLocationId: "third_avenue",
      walkingDistanceFeet: 4_261,
      walkingDurationSeconds: 1_038,
      roundTripDistanceFeet: 8_522,
      estimatedRoundTripDurationSeconds: 2_076,
      feeCents: 2_500,
      feeTierId: "whole-zone-25",
      candidateRoutes: [
        { locationId: "third_avenue", walkingDistanceFeet: 4_261 },
        { locationId: "east_86th_street", walkingDistanceFeet: 4_490 },
      ],
    });
  });

  it.each([
    ["316 E 82nd St", 2_816, 1_400, "extended-14"],
    ["E 96th St and Park Ave", 2_929, 1_400, "extended-14"],
    ["E 96th St and Lexington Ave", 2_951, 1_500, "extended-15"],
    ["E 96th St and 3rd Ave", 3_447, 1_700, "extended-17"],
    ["E 96th St and 2nd Ave", 4_110, 2_300, "extended-23"],
  ] as const)(
    "prices the mocked 86th Street calibration route for %s",
    (_address, distance, feeCents, feeTierId) => {
      expect(
        evaluateLocalWalkingDeliveryV4(
          validInput({
            postalCode: "10028",
            candidateRoutes: [route("east_86th_street", distance)],
          }),
        ),
      ).toMatchObject({
        eligible: true,
        selectedLocationId: "east_86th_street",
        walkingDistanceFeet: distance,
        feeCents,
        feeTierId,
      });
    },
  );

  it.each(["10021", "10065"])("fixes ZIP %s to Third Avenue", (postalCode) => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode,
          candidateRoutes: [route("third_avenue", 2_000)],
        }),
      ),
    ).toMatchObject({
      eligible: true,
      assignmentRule: "FIXED_POSTAL_ZONE",
      selectedLocationId: "third_avenue",
    });
  });

  it.each(["10028", "10128"])("fixes ZIP %s to East 86th Street", (postalCode) => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode,
          candidateRoutes: [route("east_86th_street", 2_000)],
        }),
      ),
    ).toMatchObject({
      eligible: true,
      assignmentRule: "FIXED_POSTAL_ZONE",
      selectedLocationId: "east_86th_street",
    });
  });
});

describe("Local Walking Delivery v4 selection and availability", () => {
  it("breaks 10075 ties by distance, then duration, then configurable locationPriority", () => {
    const byDistance = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("third_avenue", 1_500, 700),
          route("east_86th_street", 1_499, 900),
        ],
      }),
    );
    const byDuration = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("third_avenue", 1_500, 701),
          route("east_86th_street", 1_500, 700),
        ],
      }),
    );
    const byCustomPriority = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("third_avenue", 1_500, 700),
          route("east_86th_street", 1_500, 700),
        ],
        locationPriority: ["east_86th_street", "third_avenue"],
      }),
    );
    const byDefaultPriority = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("east_86th_street", 1_500, 700),
          route("third_avenue", 1_500, 700),
        ],
      }),
    );

    expect(byDistance).toMatchObject({ selectedLocationId: "east_86th_street" });
    expect(byDuration).toMatchObject({ selectedLocationId: "east_86th_street" });
    expect(byCustomPriority).toMatchObject({
      selectedLocationId: "east_86th_street",
      locationPriority: ["east_86th_street", "third_avenue"],
    });
    expect(byDefaultPriority).toMatchObject({
      selectedLocationId: "third_avenue",
      locationPriority: ["third_avenue", "east_86th_street"],
    });
    expect(LOCAL_WALKING_DELIVERY_V4_DEFAULT_LOCATION_PRIORITY).toEqual([
      "third_avenue",
      "east_86th_street",
    ]);
  });

  it.each([
    { locationPriority: ["third_avenue"] as const },
    { locationPriority: ["third_avenue", "third_avenue"] as const },
  ])("rejects non-auditable location priority $locationPriority", ({ locationPriority }) => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode: "10075",
          candidateRoutes: [
            route("third_avenue", 1_500, 700),
            route("east_86th_street", 1_500, 700),
          ],
          locationPriority,
        }),
      ),
    ).toMatchObject({ eligible: false, reasonCode: "INVALID_INPUT" });
  });

  it("does not fall back when the 10075 winner has no slots", () => {
    const result = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10075",
        candidateRoutes: [
          route("third_avenue", 1_000, 500, false),
          route("east_86th_street", 1_100, 550, true),
        ],
      }),
    );

    expect(result).toMatchObject({
      eligible: true,
      bookable: false,
      reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION",
      selectedLocationId: "third_avenue",
      feeCents: 0,
      slotLocationId: null,
    });
  });

  it("requires both candidate routes for shared ZIP 10075", () => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode: "10075",
          candidateRoutes: [route("third_avenue", 1_000)],
        }),
      ),
    ).toMatchObject({
      eligible: false,
      reasonCode: "DISTANCE_UNAVAILABLE",
    });
  });
});

describe("Local Walking Delivery v4 eligibility", () => {
  it("returns Contact store for a valid Manhattan address outside the five ZIPs", () => {
    const result = evaluateLocalWalkingDeliveryV4(
      validInput({
        postalCode: "10022",
        isInsidePublishedZone: false,
        candidateRoutes: [],
      }),
    );

    expect(result).toEqual({
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      postalCode: "10022",
    });
    expect(result).not.toHaveProperty("selectedLocationId");
    expect(result).not.toHaveProperty("feeCents");
    expect(result).not.toHaveProperty("slotLocationId");
    expect(result).not.toHaveProperty("feePolicyVersionId");
    expect(result).not.toHaveProperty("zoneVersionId");
  });

  it("returns ADDRESS_NOT_IN_MANHATTAN before considering ZIP support", () => {
    expect(
      evaluateLocalWalkingDeliveryV4(
        validInput({
          postalCode: "11201",
          isManhattan: false,
          candidateRoutes: [],
        }),
      ),
    ).toMatchObject({
      eligible: false,
      reasonCode: "ADDRESS_NOT_IN_MANHATTAN",
    });
  });

  it("returns OUTSIDE_WALKING_AREA when a supported ZIP point misses the polygon", () => {
    const result = evaluateLocalWalkingDeliveryV4(
      validInput({ isInsidePublishedZone: false, candidateRoutes: [] }),
    );
    expect(result).toMatchObject({
      eligible: false,
      reasonCode: "OUTSIDE_WALKING_AREA",
    });
    expect(result).not.toHaveProperty("feeCents");
  });

  it("normalizes a valid ZIP+4 before assignment", () => {
    expect(
      evaluateLocalWalkingDeliveryV4(validInput({ postalCode: "10021-1234" })),
    ).toMatchObject({ eligible: true, postalCode: "10021" });
  });

  it.each(["", "1002", "ABCDE"])("returns INVALID_ADDRESS for ZIP %s", (postalCode) => {
    expect(
      evaluateLocalWalkingDeliveryV4(validInput({ postalCode })),
    ).toMatchObject({ eligible: false, reasonCode: "INVALID_ADDRESS" });
  });

  it("returns INVALID_ADDRESS for a geocoder-rejected address", () => {
    expect(
      evaluateLocalWalkingDeliveryV4(validInput({ addressIsValid: false })),
    ).toMatchObject({ eligible: false, reasonCode: "INVALID_ADDRESS" });
  });

  it("never turns a large in-zone route into manager review", () => {
    const result = evaluateLocalWalkingDeliveryV4(
      validInput({
        candidateRoutes: [route("third_avenue", 50_000, 12_000)],
      }),
    );
    expect(result).toMatchObject({
      eligible: true,
      feeTierId: "whole-zone-25",
      feeCents: 2_500,
    });
    expect(result).not.toHaveProperty("managerReview");
    expect(JSON.stringify(result)).not.toContain("MANAGER_REVIEW");
  });
});

describe("Local Walking Delivery v4 round-trip metrics", () => {
  it("doubles one-way route metrics and adds operational buffers only to capacity time", () => {
    expect(
      calculateLocalWalkingDeliveryV4RoundTripMetrics(1_325.5, 360, {
        preparationSeconds: 180,
        handoffSeconds: 240,
      }),
    ).toEqual({
      roundTripDistanceFeet: 2_651,
      estimatedRoundTripDurationSeconds: 720,
      operationalDurationSeconds: 1_140,
    });
  });

  it.each([
    [-1, 360],
    [1_000, -1],
    [1_000, 1.5],
  ])("rejects invalid round-trip inputs (%s, %s)", (distance, duration) => {
    expect(calculateLocalWalkingDeliveryV4RoundTripMetrics(distance, duration)).toBeNull();
  });
});
