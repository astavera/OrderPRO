import { describe, expect, it } from "vitest";
import {
  EIGHTY_SIXTH_STREET_LOCATION_ID,
  evaluateWalkingRouteDistanceStandard,
  evaluateWalkingRouteDistanceTier,
  THIRD_AVENUE_LOCATION_ID,
  WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
  WALKING_ROUTE_DISTANCE_POLICY_DEFINITION,
  WALKING_ROUTE_DISTANCE_POLICY_KEY,
  WALKING_ROUTE_DISTANCE_POLICY_VERSION,
  validateWalkingRouteDistancePolicyDefinition,
} from "./walking-route-distance-standard";

function candidate(
  locationId: string,
  trustedWalkingDistanceFeet: number,
  hasAvailableSlots = true,
  trustedWalkingDurationSeconds = 600,
) {
  return { locationId, trustedWalkingDistanceFeet, trustedWalkingDurationSeconds, hasAvailableSlots };
}

describe("WALKING_ROUTE_DISTANCE_STANDARD DRAFT_CALIBRATION_V1 acceptance", () => {
  it("includes zero feet in the free tier and rejects negative distance", () => {
    expect(evaluateWalkingRouteDistanceTier(0)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_1200_FT",
      feeCents: 0,
    });
    expect(evaluateWalkingRouteDistanceTier(-0.01)).toMatchObject({
      automatic: false,
      reasonCode: "INVALID_INPUT",
      feeCents: null,
    });
  });

  it("1. charges $10 for 1,760 ft and fixes 10021/10065 to Third Avenue", () => {
    for (const postalCode of ["10021", "10065"]) {
      expect(
        evaluateWalkingRouteDistanceStandard({
          postalCode,
          candidates: [candidate(THIRD_AVENUE_LOCATION_ID, 1_760)],
        }),
      ).toMatchObject({
        eligible: true,
        policyKey: WALKING_ROUTE_DISTANCE_POLICY_KEY,
        policyVersion: WALKING_ROUTE_DISTANCE_POLICY_VERSION,
        assignmentStrategy: "FIXED",
        selectedLocationId: THIRD_AVENUE_LOCATION_ID,
        feeCents: 1_000,
      });
    }
  });

  it("2. charges $15 for 2,816 ft and fixes 10028/10128 to 86th Street", () => {
    for (const postalCode of ["10028", "10128"]) {
      expect(
        evaluateWalkingRouteDistanceStandard({
          postalCode,
          candidates: [candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 2_816)],
        }),
      ).toMatchObject({
        eligible: true,
        assignmentStrategy: "FIXED",
        selectedLocationId: EIGHTY_SIXTH_STREET_LOCATION_ID,
        feeCents: 1_500,
      });
    }
  });

  it("3. includes 1,200 ft in the $0 tier", () => {
    expect(evaluateWalkingRouteDistanceTier(1_200)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_1200_FT",
      feeCents: 0,
    });
  });

  it("4. charges $10 immediately above 1,200 ft", () => {
    expect(evaluateWalkingRouteDistanceTier(1_200.01)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_2300_FT",
      feeCents: 1_000,
    });
  });

  it("5. includes 2,300 ft in the $10 tier", () => {
    expect(evaluateWalkingRouteDistanceTier(2_300)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_2300_FT",
      feeCents: 1_000,
    });
  });

  it("6. charges $15 immediately above 2,300 ft", () => {
    expect(evaluateWalkingRouteDistanceTier(2_300.01)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_3250_FT",
      feeCents: 1_500,
    });
  });

  it("7. includes 3,250 ft in the $15 tier", () => {
    expect(evaluateWalkingRouteDistanceTier(3_250)).toMatchObject({
      automatic: true,
      tierCode: "UP_TO_3250_FT",
      feeCents: 1_500,
    });
  });

  it("8. sends distances above 3,250 ft to manager review without automatic fee or slot", () => {
    expect(
      evaluateWalkingRouteDistanceStandard({
        postalCode: "10021",
        candidates: [candidate(THIRD_AVENUE_LOCATION_ID, 3_250.01)],
      }),
    ).toMatchObject({
      eligible: false,
      reasonCode: "MANAGER_REVIEW",
      selectedLocationId: THIRD_AVENUE_LOCATION_ID,
      feeCents: null,
      tierCode: WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
      slotLocationId: null,
    });
  });

  it("9. selects 10075 by distance, then duration, then stable locationId", () => {
    const thirdWins = evaluateWalkingRouteDistanceStandard({
      postalCode: "10075",
      candidates: [
        candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 2_000),
        candidate(THIRD_AVENUE_LOCATION_ID, 1_500),
      ],
    });
    const eightySixthWins = evaluateWalkingRouteDistanceStandard({
      postalCode: "10075",
      candidates: [
        candidate(THIRD_AVENUE_LOCATION_ID, 2_000),
        candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 1_500),
      ],
    });
    const stableTie = evaluateWalkingRouteDistanceStandard({
      postalCode: "10075",
      candidates: [
        candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 1_500),
        candidate(THIRD_AVENUE_LOCATION_ID, 1_500),
      ],
    });
    const durationWins = evaluateWalkingRouteDistanceStandard({
      postalCode: "10075",
      candidates: [
        candidate(THIRD_AVENUE_LOCATION_ID, 1_500, true, 601),
        candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 1_500, true, 600),
      ],
    });

    expect(thirdWins).toMatchObject({ selectedLocationId: THIRD_AVENUE_LOCATION_ID });
    expect(eightySixthWins).toMatchObject({ selectedLocationId: EIGHTY_SIXTH_STREET_LOCATION_ID });
    expect(durationWins).toMatchObject({
      selectedLocationId: EIGHTY_SIXTH_STREET_LOCATION_ID,
      trustedWalkingDurationSeconds: 600,
    });
    expect(stableTie).toMatchObject({ selectedLocationId: THIRD_AVENUE_LOCATION_ID });
  });

  it("10. returns NO_AVAILABLE_SLOTS for the selected 10075 winner without falling back", () => {
    const result = evaluateWalkingRouteDistanceStandard({
      postalCode: "10075",
      candidates: [
        candidate(THIRD_AVENUE_LOCATION_ID, 1_000, false),
        candidate(EIGHTY_SIXTH_STREET_LOCATION_ID, 1_100, true),
      ],
    });

    expect(result).toMatchObject({
      eligible: false,
      reasonCode: "NO_AVAILABLE_SLOTS",
      selectedLocationId: THIRD_AVENUE_LOCATION_ID,
      feeCents: 0,
      slotLocationId: null,
    });
    expect(result.selectedLocationId).not.toBe(EIGHTY_SIXTH_STREET_LOCATION_ID);
  });

  it.each([-1, 10.5, Number.POSITIVE_INFINITY])(
    "rejects an invalid trusted walking duration of %s seconds",
    (trustedWalkingDurationSeconds) => {
      const result = evaluateWalkingRouteDistanceStandard({
        postalCode: "10021",
        candidates: [
          candidate(THIRD_AVENUE_LOCATION_ID, 1_000, true, trustedWalkingDurationSeconds),
        ],
      });

      expect(result).toMatchObject({ eligible: false, reasonCode: "INVALID_INPUT" });
    },
  );
});

function definitionIssueCodes(value: unknown) {
  return validateWalkingRouteDistancePolicyDefinition(value).issues.map(({ code }) => code);
}

describe("publishable walking-route policy definition", () => {
  it("accepts only the exact staged calibration definition", () => {
    expect(validateWalkingRouteDistancePolicyDefinition(WALKING_ROUTE_DISTANCE_POLICY_DEFINITION)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("rejects a different identity, strategy or environment", () => {
    expect(
      definitionIssueCodes({
        ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION,
        policyKey: "LEGACY_AVENUE_MATRIX",
        versionKey: "PRODUCTION_V1",
        strategy: "ZIP_MATRIX",
        environment: "PRODUCTION",
      }),
    ).toEqual(["POLICY_KEY_INVALID", "VERSION_KEY_INVALID", "STRATEGY_INVALID", "ENVIRONMENT_INVALID"]);
  });

  it("rejects changed boundaries and fees", () => {
    const tiers = WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers.map((tier, index) =>
      index === 1 ? { ...tier, minimumExclusiveFeet: 1_199, feeCents: 999 } : tier,
    );

    expect(definitionIssueCodes({ ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION, tiers })).toEqual([
      "TIER_BOUNDARY_INVALID",
      "TIER_FEE_INVALID",
    ]);
  });

  it("rejects changed automatic handling and reason codes", () => {
    const tiers = WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers.map((tier, index) =>
      index === 3 ? { ...tier, automatic: true, reasonCode: "ELIGIBLE" } : tier,
    );

    expect(definitionIssueCodes({ ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION, tiers })).toEqual([
      "TIER_AUTOMATIC_INVALID",
      "TIER_REASON_CODE_INVALID",
    ]);
  });

  it("rejects duplicate, extra and missing tier codes", () => {
    const [first, second, third] = WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers;
    const tiers = [first, first, second, third, { ...third, code: "EXTRA_TIER" }];
    const codes = definitionIssueCodes({ ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION, tiers });

    expect(codes).toContain("TIER_COUNT_INVALID");
    expect(codes).toContain("TIER_CODE_DUPLICATE");
    expect(codes).toContain("TIER_CODE_UNKNOWN");
    expect(codes).toContain("TIER_REQUIRED");
  });

  it("rejects non-canonical tier ordering", () => {
    const [first, second, third, review] = WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers;
    expect(
      definitionIssueCodes({
        ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION,
        tiers: [second, first, third, review],
      }),
    ).toEqual(["TIER_ORDER_INVALID", "TIER_ORDER_INVALID"]);
  });

  it.each<{ additionalRules: unknown }>([
    { additionalRules: [] },
    { additionalRules: [{ type: "AVENUE_SURCHARGE", avenue: "Lexington", feeCents: 1_000 }] },
    { additionalRules: [{ type: "HISTORICAL_MATRIX", source: "balloon-delivery" }] },
  ])("rejects additional rules even when supplied as $additionalRules", ({ additionalRules }) => {
    expect(
      definitionIssueCodes({ ...WALKING_ROUTE_DISTANCE_POLICY_DEFINITION, additionalRules }),
    ).toEqual(["ADDITIONAL_RULES_NOT_ALLOWED"]);
  });
});
