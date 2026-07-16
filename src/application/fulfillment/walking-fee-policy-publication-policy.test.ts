import { describe, expect, it } from "vitest";
import { stableSha256Digest, WALKING_ROUTE_DISTANCE_POLICY_DEFINITION } from "../../domain/walking-delivery";
import {
  buildWalkingFeePolicySnapshot,
  validateWalkingFeePolicyVersion,
  WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION,
  type WalkingFeePolicyVersionRecord,
} from "./walking-fee-policy-publication-policy";

function validRecord(): WalkingFeePolicyVersionRecord {
  return {
    policyId: "00000000-0000-4000-8400-000000000001",
    policyCode: WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.policyKey,
    versionId: "00000000-0000-4000-8410-000000000001",
    versionKey: WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.versionKey,
    versionNumber: 1,
    revision: 1,
    environment: WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.environment,
    strategy: WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.strategy,
    currency: "USD",
    routingProfile: "walking",
    tiers: WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers.map((tier, index) => ({
      id: `00000000-0000-4000-8420-00000000000${index + 1}`,
      tierKey: tier.code,
      sequence: index + 1,
      lowerExclusiveFeet: tier.minimumExclusiveFeet,
      upperInclusiveFeet: tier.maximumInclusiveFeet,
      feeCents: tier.feeCents,
      automatic: tier.automatic,
      reasonCode: tier.reasonCode,
    })),
  };
}

describe("walking fee-policy publication projection", () => {
  it("accepts only the exact STAGING walking-distance calibration", () => {
    expect(validateWalkingFeePolicyVersion(validRecord())).toEqual({ valid: true, issues: [] });

    const original = validRecord();
    const changed = {
      ...original,
      tiers: original.tiers.map((tier, index) =>
        index === 1 ? { ...tier, feeCents: 1_100 } : tier,
      ),
    };
    expect(validateWalkingFeePolicyVersion(changed).valid).toBe(false);
  });

  it("builds a stable immutable snapshot with the exact structural tiers", () => {
    const snapshot = buildWalkingFeePolicySnapshot(validRecord());

    expect(snapshot.schemaVersion).toBe(WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.tiers.map((tier) => tier.tierKey)).toEqual([
      "UP_TO_1200_FT",
      "UP_TO_2300_FT",
      "UP_TO_3250_FT",
      "OVER_3250_FT_MANAGER_REVIEW",
    ]);
    expect(stableSha256Digest(snapshot)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stableSha256Digest(snapshot)).toBe(
      stableSha256Digest({ ...snapshot, tiers: snapshot.tiers.map((tier) => ({ ...tier })) }),
    );
  });
});
