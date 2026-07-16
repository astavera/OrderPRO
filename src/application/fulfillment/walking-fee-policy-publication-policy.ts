import {
  EIGHTY_SIXTH_STREET_LOCATION_ID,
  THIRD_AVENUE_LOCATION_ID,
  validateWalkingRouteDistancePolicyDefinition,
  type WalkingRouteDistancePolicyDefinition,
} from "../../domain/walking-delivery";

export const WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION =
  "orderpro.walking-route-distance-fee.v1" as const;

export const WALKING_FEE_POLICY_PUBLISH_CONFIRMATION =
  "PUBLISH WALKING_ROUTE_DISTANCE_STANDARD" as const;

export const WALKING_FEE_POLICY_LOCATION_IDS = [
  THIRD_AVENUE_LOCATION_ID,
  EIGHTY_SIXTH_STREET_LOCATION_ID,
] as const;

export interface WalkingFeeTierRecord {
  readonly id: string;
  readonly tierKey: string;
  readonly sequence: number;
  readonly lowerExclusiveFeet: number | null;
  readonly upperInclusiveFeet: number | null;
  readonly feeCents: number | null;
  readonly automatic: boolean;
  readonly reasonCode: string;
}

export interface WalkingFeePolicyVersionRecord {
  readonly policyId: string;
  readonly policyCode: string;
  readonly versionId: string;
  readonly versionKey: string;
  readonly versionNumber: number;
  readonly revision: number;
  readonly environment: string;
  readonly strategy: string;
  readonly currency: string;
  readonly routingProfile: string;
  readonly tiers: readonly WalkingFeeTierRecord[];
}

export function toWalkingRouteDistancePolicyDefinition(
  record: WalkingFeePolicyVersionRecord,
): WalkingRouteDistancePolicyDefinition {
  return {
    policyKey: record.policyCode,
    versionKey: record.versionKey,
    strategy: record.strategy,
    environment: record.environment,
    tiers: record.tiers.map((tier) => ({
      code: tier.tierKey,
      minimumExclusiveFeet: tier.lowerExclusiveFeet,
      maximumInclusiveFeet: tier.upperInclusiveFeet,
      feeCents: tier.feeCents,
      automatic: tier.automatic,
      reasonCode: tier.reasonCode,
    })),
  };
}

export function validateWalkingFeePolicyVersion(record: WalkingFeePolicyVersionRecord) {
  const definition = toWalkingRouteDistancePolicyDefinition(record);
  const definitionValidation = validateWalkingRouteDistancePolicyDefinition(definition);
  const issues = [...definitionValidation.issues];

  if (record.currency !== "USD") {
    issues.push({ code: "DEFINITION_INVALID", path: "$.currency", message: "Currency must be USD." });
  }
  if (record.routingProfile !== "walking") {
    issues.push({
      code: "DEFINITION_INVALID",
      path: "$.routingProfile",
      message: "Routing profile must be walking.",
    });
  }

  return { valid: issues.length === 0, issues } as const;
}

export function buildWalkingFeePolicySnapshot(record: WalkingFeePolicyVersionRecord) {
  return {
    schemaVersion: WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION,
    policyId: record.policyId,
    policyCode: record.policyCode,
    versionId: record.versionId,
    versionKey: record.versionKey,
    versionNumber: record.versionNumber,
    revision: record.revision,
    environment: record.environment,
    strategy: record.strategy,
    currency: record.currency,
    routingProfile: record.routingProfile,
    tiers: record.tiers.map((tier) => ({
      id: tier.id,
      tierKey: tier.tierKey,
      sequence: tier.sequence,
      lowerExclusiveFeet: tier.lowerExclusiveFeet,
      upperInclusiveFeet: tier.upperInclusiveFeet,
      feeCents: tier.feeCents,
      automatic: tier.automatic,
      reasonCode: tier.reasonCode,
    })),
  };
}
