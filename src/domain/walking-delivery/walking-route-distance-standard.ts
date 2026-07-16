import type { WalkingAssignmentStrategy, WalkingReasonCode } from "./types";

export const WALKING_ROUTE_DISTANCE_POLICY_KEY = "WALKING_ROUTE_DISTANCE_STANDARD" as const;
export const WALKING_ROUTE_DISTANCE_POLICY_VERSION = "DRAFT_CALIBRATION_V1" as const;
export const WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE = "OVER_3250_FT_MANAGER_REVIEW" as const;
export const WALKING_ROUTE_DISTANCE_STRATEGY = "WALKING_ROUTE_DISTANCE" as const;
export const WALKING_ROUTE_DISTANCE_ENVIRONMENT = "STAGING" as const;

export const THIRD_AVENUE_LOCATION_ID = "store-3rd-avenue" as const;
export const EIGHTY_SIXTH_STREET_LOCATION_ID = "store-86th-street" as const;

export const WALKING_ROUTE_DISTANCE_TIERS = [
  {
    code: "UP_TO_1200_FT",
    minimumExclusiveFeet: null,
    maximumInclusiveFeet: 1_200,
    feeCents: 0,
  },
  {
    code: "UP_TO_2300_FT",
    minimumExclusiveFeet: 1_200,
    maximumInclusiveFeet: 2_300,
    feeCents: 1_000,
  },
  {
    code: "UP_TO_3250_FT",
    minimumExclusiveFeet: 2_300,
    maximumInclusiveFeet: 3_250,
    feeCents: 1_500,
  },
] as const;

export type WalkingRouteDistanceTier = (typeof WALKING_ROUTE_DISTANCE_TIERS)[number];
type WalkingRouteDistanceAutomaticTierCode = WalkingRouteDistanceTier["code"];
export type WalkingRouteDistanceTierCode =
  | WalkingRouteDistanceAutomaticTierCode
  | typeof WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE;

export const WALKING_ROUTE_DISTANCE_POLICY_DEFINITION = {
  policyKey: WALKING_ROUTE_DISTANCE_POLICY_KEY,
  versionKey: WALKING_ROUTE_DISTANCE_POLICY_VERSION,
  strategy: WALKING_ROUTE_DISTANCE_STRATEGY,
  environment: WALKING_ROUTE_DISTANCE_ENVIRONMENT,
  tiers: [
    { ...WALKING_ROUTE_DISTANCE_TIERS[0], automatic: true, reasonCode: "ELIGIBLE" },
    { ...WALKING_ROUTE_DISTANCE_TIERS[1], automatic: true, reasonCode: "ELIGIBLE" },
    { ...WALKING_ROUTE_DISTANCE_TIERS[2], automatic: true, reasonCode: "ELIGIBLE" },
    {
      code: WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
      minimumExclusiveFeet: 3_250,
      maximumInclusiveFeet: null,
      feeCents: null,
      automatic: false,
      reasonCode: "MANAGER_REVIEW",
    },
  ],
} as const;

export interface WalkingRouteDistancePolicyTierDefinition {
  readonly code: string;
  readonly minimumExclusiveFeet: number | null;
  readonly maximumInclusiveFeet: number | null;
  readonly feeCents: number | null;
  readonly automatic: boolean;
  readonly reasonCode: string;
}

export interface WalkingRouteDistancePolicyDefinition {
  readonly policyKey: string;
  readonly versionKey: string;
  readonly strategy: string;
  readonly environment: string;
  readonly tiers: readonly WalkingRouteDistancePolicyTierDefinition[];
  readonly additionalRules?: unknown;
}

export type WalkingRouteDistancePolicyDefinitionIssueCode =
  | "DEFINITION_INVALID"
  | "DEFINITION_UNEXPECTED_FIELD"
  | "POLICY_KEY_INVALID"
  | "VERSION_KEY_INVALID"
  | "STRATEGY_INVALID"
  | "ENVIRONMENT_INVALID"
  | "TIER_COUNT_INVALID"
  | "TIER_DEFINITION_INVALID"
  | "TIER_UNEXPECTED_FIELD"
  | "TIER_CODE_DUPLICATE"
  | "TIER_CODE_UNKNOWN"
  | "TIER_REQUIRED"
  | "TIER_ORDER_INVALID"
  | "TIER_BOUNDARY_INVALID"
  | "TIER_FEE_INVALID"
  | "TIER_AUTOMATIC_INVALID"
  | "TIER_REASON_CODE_INVALID"
  | "ADDITIONAL_RULES_NOT_ALLOWED";

export interface WalkingRouteDistancePolicyDefinitionIssue {
  readonly code: WalkingRouteDistancePolicyDefinitionIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface WalkingRouteDistancePolicyDefinitionValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WalkingRouteDistancePolicyDefinitionIssue[];
}

const DEFINITION_FIELDS = new Set([
  "policyKey",
  "versionKey",
  "strategy",
  "environment",
  "tiers",
  "additionalRules",
]);
const TIER_FIELDS = new Set([
  "code",
  "minimumExclusiveFeet",
  "maximumInclusiveFeet",
  "feeCents",
  "automatic",
  "reasonCode",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definitionIssue(
  code: WalkingRouteDistancePolicyDefinitionIssueCode,
  path: string,
  message: string,
): WalkingRouteDistancePolicyDefinitionIssue {
  return { code, path, message };
}

export function validateWalkingRouteDistancePolicyDefinition(
  value: unknown,
): WalkingRouteDistancePolicyDefinitionValidationResult {
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [definitionIssue("DEFINITION_INVALID", "$", "Expected a walking-route policy definition object.")],
    };
  }

  const issues: WalkingRouteDistancePolicyDefinitionIssue[] = [];
  const add = (code: WalkingRouteDistancePolicyDefinitionIssueCode, path: string, message: string) =>
    issues.push(definitionIssue(code, path, message));

  for (const field of Object.keys(value)) {
    if (!DEFINITION_FIELDS.has(field)) {
      add("DEFINITION_UNEXPECTED_FIELD", `$.${field}`, "The policy definition contains an unsupported field.");
    }
  }

  if (value.policyKey !== WALKING_ROUTE_DISTANCE_POLICY_KEY) {
    add("POLICY_KEY_INVALID", "$.policyKey", `policyKey must be ${WALKING_ROUTE_DISTANCE_POLICY_KEY}.`);
  }
  if (value.versionKey !== WALKING_ROUTE_DISTANCE_POLICY_VERSION) {
    add("VERSION_KEY_INVALID", "$.versionKey", `versionKey must be ${WALKING_ROUTE_DISTANCE_POLICY_VERSION}.`);
  }
  if (value.strategy !== WALKING_ROUTE_DISTANCE_STRATEGY) {
    add("STRATEGY_INVALID", "$.strategy", `strategy must be ${WALKING_ROUTE_DISTANCE_STRATEGY}.`);
  }
  if (value.environment !== WALKING_ROUTE_DISTANCE_ENVIRONMENT) {
    add("ENVIRONMENT_INVALID", "$.environment", `environment must be ${WALKING_ROUTE_DISTANCE_ENVIRONMENT}.`);
  }
  if (Object.hasOwn(value, "additionalRules")) {
    add(
      "ADDITIONAL_RULES_NOT_ALLOWED",
      "$.additionalRules",
      "Additional rules, avenue surcharges and historical matrices are not allowed.",
    );
  }

  if (!Array.isArray(value.tiers)) {
    add("TIER_COUNT_INVALID", "$.tiers", "Exactly four structural tiers are required.");
    return { valid: issues.length === 0, issues };
  }

  if (value.tiers.length !== WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers.length) {
    add("TIER_COUNT_INVALID", "$.tiers", "Exactly four structural tiers are required.");
  }

  const expectedByCode = new Map(
    WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers.map((tier) => [tier.code, tier] as const),
  );
  const seenCodes = new Set<string>();

  value.tiers.forEach((tierValue, index) => {
    const path = `$.tiers[${index}]`;
    if (!isRecord(tierValue)) {
      add("TIER_DEFINITION_INVALID", path, "Each tier must be an object.");
      return;
    }

    for (const field of Object.keys(tierValue)) {
      if (!TIER_FIELDS.has(field)) {
        add("TIER_UNEXPECTED_FIELD", `${path}.${field}`, "The tier contains an unsupported field.");
      }
    }

    const code = typeof tierValue.code === "string" ? tierValue.code : "";
    if (seenCodes.has(code)) {
      add("TIER_CODE_DUPLICATE", `${path}.code`, "Tier codes must be unique.");
    }
    seenCodes.add(code);

    const expected = expectedByCode.get(code as WalkingRouteDistanceTierCode);
    if (!expected) {
      add("TIER_CODE_UNKNOWN", `${path}.code`, "The tier code is not part of this calibration.");
      return;
    }

    if (WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers[index]?.code !== code) {
      add("TIER_ORDER_INVALID", `${path}.code`, "Tiers must use the canonical distance order.");
    }
    if (
      tierValue.minimumExclusiveFeet !== expected.minimumExclusiveFeet ||
      tierValue.maximumInclusiveFeet !== expected.maximumInclusiveFeet
    ) {
      add("TIER_BOUNDARY_INVALID", path, "Tier distance boundaries do not match the calibration.");
    }
    if (tierValue.feeCents !== expected.feeCents) {
      add("TIER_FEE_INVALID", `${path}.feeCents`, "Tier fee does not match the calibration.");
    }
    if (tierValue.automatic !== expected.automatic) {
      add("TIER_AUTOMATIC_INVALID", `${path}.automatic`, "Tier automatic handling does not match the calibration.");
    }
    if (tierValue.reasonCode !== expected.reasonCode) {
      add("TIER_REASON_CODE_INVALID", `${path}.reasonCode`, "Tier reason code does not match the calibration.");
    }
  });

  for (const expected of WALKING_ROUTE_DISTANCE_POLICY_DEFINITION.tiers) {
    if (!seenCodes.has(expected.code)) {
      add("TIER_REQUIRED", "$.tiers", `Required tier ${expected.code} is missing.`);
    }
  }

  return { valid: issues.length === 0, issues };
}

export type WalkingRouteDistanceTierResult =
  | {
      readonly automatic: true;
      readonly reasonCode: "ELIGIBLE";
      readonly trustedWalkingDistanceFeet: number;
      readonly tierCode: WalkingRouteDistanceAutomaticTierCode;
      readonly feeCents: number;
    }
  | {
      readonly automatic: false;
      readonly reasonCode: "MANAGER_REVIEW";
      readonly trustedWalkingDistanceFeet: number;
      readonly tierCode: typeof WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE;
      readonly feeCents: null;
    }
  | {
      readonly automatic: false;
      readonly reasonCode: "INVALID_INPUT";
      readonly trustedWalkingDistanceFeet: number;
      readonly tierCode: null;
      readonly feeCents: null;
    };

export interface WalkingRouteDistanceCandidateInput {
  readonly locationId: string;
  readonly trustedWalkingDistanceFeet: number;
  readonly trustedWalkingDurationSeconds: number;
  readonly hasAvailableSlots: boolean;
}

export interface WalkingRouteDistanceStandardInput {
  readonly postalCode: string;
  readonly candidates: readonly WalkingRouteDistanceCandidateInput[];
}

interface WalkingRouteDistanceSelection {
  readonly assignmentStrategy: WalkingAssignmentStrategy;
  readonly selected: WalkingRouteDistanceCandidateInput;
}

interface WalkingRouteDistanceResultCommon {
  readonly policyKey: typeof WALKING_ROUTE_DISTANCE_POLICY_KEY;
  readonly policyVersion: typeof WALKING_ROUTE_DISTANCE_POLICY_VERSION;
  readonly postalCode: string;
}

export type WalkingRouteDistanceStandardResult =
  | (WalkingRouteDistanceResultCommon & {
      readonly eligible: true;
      readonly reasonCode: "ELIGIBLE";
      readonly assignmentStrategy: WalkingAssignmentStrategy;
      readonly selectedLocationId: string;
      readonly trustedWalkingDistanceFeet: number;
      readonly trustedWalkingDurationSeconds: number;
      readonly tierCode: WalkingRouteDistanceAutomaticTierCode;
      readonly feeCents: number;
      readonly slotLocationId: string;
    })
  | (WalkingRouteDistanceResultCommon & {
      readonly eligible: false;
      readonly reasonCode: "NO_AVAILABLE_SLOTS";
      readonly assignmentStrategy: WalkingAssignmentStrategy;
      readonly selectedLocationId: string;
      readonly trustedWalkingDistanceFeet: number;
      readonly trustedWalkingDurationSeconds: number;
      readonly tierCode: WalkingRouteDistanceAutomaticTierCode;
      readonly feeCents: number;
      readonly slotLocationId: null;
    })
  | (WalkingRouteDistanceResultCommon & {
      readonly eligible: false;
      readonly reasonCode: "MANAGER_REVIEW";
      readonly assignmentStrategy: WalkingAssignmentStrategy;
      readonly selectedLocationId: string;
      readonly trustedWalkingDistanceFeet: number;
      readonly trustedWalkingDurationSeconds: number;
      readonly tierCode: typeof WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE;
      readonly feeCents: null;
      readonly slotLocationId: null;
    })
  | (WalkingRouteDistanceResultCommon & {
      readonly eligible: false;
      readonly reasonCode: Extract<WalkingReasonCode, "INVALID_INPUT" | "OUTSIDE_WALKING_ZONE" | "ROUTE_METRICS_REQUIRED">;
      readonly assignmentStrategy: WalkingAssignmentStrategy | null;
      readonly selectedLocationId: null;
      readonly trustedWalkingDistanceFeet: null;
      readonly trustedWalkingDurationSeconds: null;
      readonly tierCode: null;
      readonly feeCents: null;
      readonly slotLocationId: null;
    });

const FIXED_LOCATION_BY_POSTAL_CODE: Readonly<Record<string, string>> = {
  "10021": THIRD_AVENUE_LOCATION_ID,
  "10065": THIRD_AVENUE_LOCATION_ID,
  "10028": EIGHTY_SIXTH_STREET_LOCATION_ID,
  "10128": EIGHTY_SIXTH_STREET_LOCATION_ID,
};

const SHARED_POSTAL_CODE = "10075";
const SHARED_CANDIDATE_LOCATION_IDS = [THIRD_AVENUE_LOCATION_ID, EIGHTY_SIXTH_STREET_LOCATION_ID] as const;

function stableTextCompare(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validCandidate(candidate: WalkingRouteDistanceCandidateInput) {
  return (
    typeof candidate.locationId === "string" &&
    candidate.locationId.trim().length > 0 &&
    Number.isFinite(candidate.trustedWalkingDistanceFeet) &&
    candidate.trustedWalkingDistanceFeet >= 0 &&
    Number.isFinite(candidate.trustedWalkingDurationSeconds) &&
    Number.isInteger(candidate.trustedWalkingDurationSeconds) &&
    candidate.trustedWalkingDurationSeconds >= 0 &&
    typeof candidate.hasAvailableSlots === "boolean"
  );
}

function selectCandidate(
  postalCode: string,
  candidates: readonly WalkingRouteDistanceCandidateInput[],
): WalkingRouteDistanceSelection | "OUTSIDE_WALKING_ZONE" | "ROUTE_METRICS_REQUIRED" | "INVALID_INPUT" {
  if (candidates.some((candidate) => !validCandidate(candidate))) return "INVALID_INPUT";

  const byLocation = new Map<string, WalkingRouteDistanceCandidateInput>();
  for (const candidate of candidates) {
    if (byLocation.has(candidate.locationId)) return "INVALID_INPUT";
    byLocation.set(candidate.locationId, candidate);
  }

  const fixedLocationId = FIXED_LOCATION_BY_POSTAL_CODE[postalCode];
  if (fixedLocationId) {
    const selected = byLocation.get(fixedLocationId);
    if (!selected) return "ROUTE_METRICS_REQUIRED";
    return { assignmentStrategy: "FIXED", selected };
  }

  if (postalCode !== SHARED_POSTAL_CODE) return "OUTSIDE_WALKING_ZONE";

  const sharedCandidates: WalkingRouteDistanceCandidateInput[] = [];
  for (const locationId of SHARED_CANDIDATE_LOCATION_IDS) {
    const candidate = byLocation.get(locationId);
    if (!candidate) return "ROUTE_METRICS_REQUIRED";
    sharedCandidates.push(candidate);
  }

  sharedCandidates.sort(
    (left, right) =>
      left.trustedWalkingDistanceFeet - right.trustedWalkingDistanceFeet ||
      left.trustedWalkingDurationSeconds - right.trustedWalkingDurationSeconds ||
      stableTextCompare(left.locationId, right.locationId),
  );

  return {
    assignmentStrategy: "NEAREST_WALKING_ROUTE",
    selected: sharedCandidates[0],
  };
}

export function evaluateWalkingRouteDistanceTier(
  trustedWalkingDistanceFeet: number,
): WalkingRouteDistanceTierResult {
  if (!Number.isFinite(trustedWalkingDistanceFeet) || trustedWalkingDistanceFeet < 0) {
    return {
      automatic: false,
      reasonCode: "INVALID_INPUT",
      trustedWalkingDistanceFeet,
      tierCode: null,
      feeCents: null,
    };
  }

  const tier = WALKING_ROUTE_DISTANCE_TIERS.find(
    (candidate) =>
      (candidate.minimumExclusiveFeet === null ||
        trustedWalkingDistanceFeet > candidate.minimumExclusiveFeet) &&
      trustedWalkingDistanceFeet <= candidate.maximumInclusiveFeet,
  );

  if (!tier) {
    return {
      automatic: false,
      reasonCode: "MANAGER_REVIEW",
      trustedWalkingDistanceFeet,
      tierCode: WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
      feeCents: null,
    };
  }

  return {
    automatic: true,
    reasonCode: "ELIGIBLE",
    trustedWalkingDistanceFeet,
    tierCode: tier.code,
    feeCents: tier.feeCents,
  };
}

export function evaluateWalkingRouteDistanceStandard(
  input: WalkingRouteDistanceStandardInput,
): WalkingRouteDistanceStandardResult {
  const postalCode = typeof input.postalCode === "string" ? input.postalCode.trim() : "";
  const common = {
    policyKey: WALKING_ROUTE_DISTANCE_POLICY_KEY,
    policyVersion: WALKING_ROUTE_DISTANCE_POLICY_VERSION,
    postalCode,
  } as const;

  if (!/^\d{5}$/.test(postalCode) || !Array.isArray(input.candidates)) {
    return {
      ...common,
      eligible: false,
      reasonCode: "INVALID_INPUT",
      assignmentStrategy: null,
      selectedLocationId: null,
      trustedWalkingDistanceFeet: null,
      trustedWalkingDurationSeconds: null,
      tierCode: null,
      feeCents: null,
      slotLocationId: null,
    };
  }

  const selection = selectCandidate(postalCode, input.candidates);
  if (typeof selection === "string") {
    return {
      ...common,
      eligible: false,
      reasonCode: selection,
      assignmentStrategy: postalCode === SHARED_POSTAL_CODE ? "NEAREST_WALKING_ROUTE" : null,
      selectedLocationId: null,
      trustedWalkingDistanceFeet: null,
      trustedWalkingDurationSeconds: null,
      tierCode: null,
      feeCents: null,
      slotLocationId: null,
    };
  }

  const tier = evaluateWalkingRouteDistanceTier(selection.selected.trustedWalkingDistanceFeet);
  if (tier.reasonCode === "INVALID_INPUT") {
    return {
      ...common,
      eligible: false,
      reasonCode: "INVALID_INPUT",
      assignmentStrategy: selection.assignmentStrategy,
      selectedLocationId: null,
      trustedWalkingDistanceFeet: null,
      trustedWalkingDurationSeconds: null,
      tierCode: null,
      feeCents: null,
      slotLocationId: null,
    };
  }

  if (!tier.automatic) {
    return {
      ...common,
      eligible: false,
      reasonCode: tier.reasonCode,
      assignmentStrategy: selection.assignmentStrategy,
      selectedLocationId: selection.selected.locationId,
      trustedWalkingDistanceFeet: selection.selected.trustedWalkingDistanceFeet,
      trustedWalkingDurationSeconds: selection.selected.trustedWalkingDurationSeconds,
      tierCode: tier.tierCode,
      feeCents: null,
      slotLocationId: null,
    };
  }

  if (!selection.selected.hasAvailableSlots) {
    return {
      ...common,
      eligible: false,
      reasonCode: "NO_AVAILABLE_SLOTS",
      assignmentStrategy: selection.assignmentStrategy,
      selectedLocationId: selection.selected.locationId,
      trustedWalkingDistanceFeet: selection.selected.trustedWalkingDistanceFeet,
      trustedWalkingDurationSeconds: selection.selected.trustedWalkingDurationSeconds,
      tierCode: tier.tierCode,
      feeCents: tier.feeCents,
      slotLocationId: null,
    };
  }

  return {
    ...common,
    eligible: true,
    reasonCode: "ELIGIBLE",
    assignmentStrategy: selection.assignmentStrategy,
    selectedLocationId: selection.selected.locationId,
    trustedWalkingDistanceFeet: selection.selected.trustedWalkingDistanceFeet,
    trustedWalkingDurationSeconds: selection.selected.trustedWalkingDurationSeconds,
    tierCode: tier.tierCode,
    feeCents: tier.feeCents,
    slotLocationId: selection.selected.locationId,
  };
}
