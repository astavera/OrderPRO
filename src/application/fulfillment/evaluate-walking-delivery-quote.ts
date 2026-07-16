import {
  evaluateWalkingDelivery,
  evaluateWalkingRouteDistanceStandard,
  stableSha256Digest,
  WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
  WALKING_ROUTE_DISTANCE_ENVIRONMENT,
  WALKING_ROUTE_DISTANCE_POLICY_KEY,
  WALKING_ROUTE_DISTANCE_POLICY_VERSION,
  WALKING_ROUTE_DISTANCE_STRATEGY,
  WALKING_ROUTE_DISTANCE_TIERS,
  validateWalkingRouteDistancePolicyDefinition,
  type WalkingPosition,
  type WalkingReasonCode,
  type WalkingRouteDistanceStandardResult,
  type WalkingRouteDistanceTierCode,
  type WalkingZoneConfiguration,
} from "../../domain/walking-delivery";

const METERS_TO_FEET = 3.280839895013123;
const FEET_PER_MILE = 5_280;
export const WALKING_QUOTE_SCHEMA_VERSION = "orderpro.walking-delivery-quote.v1" as const;

export type WalkingQuoteOutcomeReasonCode = Extract<
  WalkingReasonCode,
  "ELIGIBLE" | "NO_AVAILABLE_SLOTS" | "MANAGER_REVIEW"
>;

export type WalkingQuoteSlot = {
  readonly slotId: string;
  readonly locationId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly remainingCapacity: number;
};

export type WalkingQuoteLocation = {
  readonly locationId: string;
  readonly point: WalkingPosition;
};

export type WalkingQuotePolicyTier = {
  readonly id: string;
  readonly tierCode: WalkingRouteDistanceTierCode;
  readonly minimumExclusiveFeet: number | null;
  readonly maximumInclusiveFeet: number | null;
  readonly feeCents: number | null;
  readonly automaticQuote: boolean;
  readonly reasonCode: "ELIGIBLE" | "MANAGER_REVIEW";
};

export type WalkingQuotePolicyVersion = {
  readonly id: string;
  readonly policyId: typeof WALKING_ROUTE_DISTANCE_POLICY_KEY;
  readonly versionKey: typeof WALKING_ROUTE_DISTANCE_POLICY_VERSION;
  readonly status: "PUBLISHED";
  readonly environment: "STAGING" | "PRODUCTION";
  readonly strategy: "WALKING_ROUTE_DISTANCE";
  readonly tiers: readonly WalkingQuotePolicyTier[];
  readonly additionalRules?: unknown;
};

export type WalkingQuoteConfiguration = {
  readonly zones: readonly WalkingZoneConfiguration[];
  readonly locations: readonly WalkingQuoteLocation[];
  readonly feePolicyVersion: WalkingQuotePolicyVersion;
  readonly walkingPublicationId: string;
};

export type GeocodedWalkingAddress = {
  readonly normalizedAddress: string;
  readonly point: WalkingPosition;
  readonly postalCode: string;
  readonly provider: string;
  readonly matchType: "EXACT_ADDRESS";
  readonly ambiguous: false;
};

export type TrustedWalkingRoute = {
  readonly provider: string;
  readonly profile: "walking";
  readonly distanceMeters: number;
  readonly durationSeconds: number;
};

export interface WalkingQuoteGeocoder {
  geocodeExactAddress(address: string, correlationId: string): Promise<GeocodedWalkingAddress>;
}

export interface WalkingQuoteRouter {
  getWalkingRoute(input: {
    origin: WalkingPosition;
    destination: WalkingPosition;
    correlationId: string;
  }): Promise<TrustedWalkingRoute>;
}

export interface WalkingQuoteSlotReader {
  getAvailableSlots(input: {
    locationId: string;
    slotPolicyId: string;
    serviceAt: string;
    correlationId: string;
  }): Promise<readonly WalkingQuoteSlot[]>;
}

export interface WalkingQuoteConfigurationReader {
  getPublishedConfiguration(input: {
    postalCode: string;
    serviceAt: string;
    calculatedAt: string;
    environment: "STAGING" | "PRODUCTION";
  }): Promise<WalkingQuoteConfiguration | null>;
}

export type WalkingQuoteResult = {
  readonly schemaVersion: typeof WALKING_QUOTE_SCHEMA_VERSION;
  readonly quoteId: string;
  readonly replayed: boolean;
  readonly eligible: boolean;
  readonly normalizedAddress: string;
  /** GeoJSON position: [longitude, latitude]. */
  readonly customerCoordinates: WalkingPosition;
  readonly postalCode: string;
  readonly selectedLocationId: string;
  readonly zoneVersionId: string;
  readonly feePolicyVersionId: string;
  readonly routingProvider: string;
  readonly routingProfile: "walking";
  readonly distanceFeet: number;
  readonly durationSeconds: number;
  readonly feeCents: number | null;
  /** Stable public tier identifier. The database tier UUID is persistence-only. */
  readonly tierId: WalkingRouteDistanceTierCode;
  readonly reasonCode: WalkingQuoteOutcomeReasonCode;
  readonly calculatedAt: string;
  readonly slots: readonly WalkingQuoteSlot[];
  readonly correlationId: string;
};

export type PersistWalkingQuoteInput = Omit<WalkingQuoteResult, "quoteId" | "replayed"> & {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly tierRecordId: string;
  readonly slotPolicyId: string | null;
  readonly walkingPublicationId: string;
  readonly feePolicySnapshot: unknown;
  readonly tierSnapshot: unknown | null;
  readonly slotSnapshot: readonly WalkingQuoteSlot[] | null;
};

export interface WalkingQuoteStore {
  findByIdempotency(input: {
    clientId: string;
    idempotencyKey: string;
  }): Promise<{ readonly requestHash: string; readonly result: WalkingQuoteResult } | null>;
  save(input: PersistWalkingQuoteInput): Promise<WalkingQuoteResult>;
}

export type EvaluateWalkingDeliveryQuoteCommand = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly address: string;
  readonly serviceAt: string;
  readonly subtotalCents: number;
  readonly environment: "STAGING" | "PRODUCTION";
};

export type EvaluateWalkingDeliveryQuoteDependencies = {
  readonly geocoder: WalkingQuoteGeocoder;
  readonly router: WalkingQuoteRouter;
  readonly slots: WalkingQuoteSlotReader;
  readonly configuration: WalkingQuoteConfigurationReader;
  readonly store: WalkingQuoteStore;
  readonly now?: () => Date;
};

export class WalkingQuoteEvaluationError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "GEOCODING_FAILED"
      | "CONFIGURATION_NOT_READY"
      | "ROUTING_UNAVAILABLE"
      | "SLOTS_UNAVAILABLE"
      | "IDEMPOTENCY_CONFLICT"
      | Exclude<WalkingReasonCode, "ELIGIBLE" | "NO_AVAILABLE_SLOTS" | "MANAGER_REVIEW">,
  ) {
    super(code);
    this.name = "WalkingQuoteEvaluationError";
  }
}

function normalizedRequestAddress(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function distanceMetersToFeet(value: number) {
  // The persisted contract is DECIMAL(12,2); classify the exact value that is audited.
  return Math.round((value * METERS_TO_FEET + Number.EPSILON) * 100) / 100;
}

function validInstant(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validPoint(value: WalkingPosition) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function validAvailableSlot(slot: WalkingQuoteSlot, selectedLocationId: string) {
  return (
    slot.slotId.trim().length > 0 &&
    slot.locationId === selectedLocationId &&
    validInstant(slot.startsAt) &&
    validInstant(slot.endsAt) &&
    Date.parse(slot.endsAt) > Date.parse(slot.startsAt) &&
    Number.isInteger(slot.remainingCapacity) &&
    slot.remainingCapacity > 0
  );
}

function policyTierByCode(policy: WalkingQuotePolicyVersion) {
  const tiers = new Map<WalkingRouteDistanceTierCode, WalkingQuotePolicyTier>();
  for (const tier of policy.tiers) {
    if (tiers.has(tier.tierCode)) return null;
    tiers.set(tier.tierCode, tier);
  }

  for (const expected of WALKING_ROUTE_DISTANCE_TIERS) {
    const actual = tiers.get(expected.code);
    if (
      !actual ||
      actual.minimumExclusiveFeet !== expected.minimumExclusiveFeet ||
      actual.maximumInclusiveFeet !== expected.maximumInclusiveFeet ||
      actual.feeCents !== expected.feeCents ||
      !actual.automaticQuote ||
      actual.reasonCode !== "ELIGIBLE"
    ) {
      return null;
    }
  }

  const managerReview = tiers.get(WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE);
  if (
    !managerReview ||
    managerReview.minimumExclusiveFeet !== 3_250 ||
    managerReview.maximumInclusiveFeet !== null ||
    managerReview.feeCents !== null ||
    managerReview.automaticQuote ||
    managerReview.reasonCode !== "MANAGER_REVIEW"
  ) {
    return null;
  }

  return tiers;
}

function validateConfiguration(configuration: WalkingQuoteConfiguration) {
  const policy = configuration.feePolicyVersion;
  const definition = {
    policyKey: policy.policyId,
    versionKey: policy.versionKey,
    strategy: policy.strategy,
    environment: policy.environment,
    tiers: policy.tiers.map((tier) => ({
      code: tier.tierCode,
      minimumExclusiveFeet: tier.minimumExclusiveFeet,
      maximumInclusiveFeet: tier.maximumInclusiveFeet,
      feeCents: tier.feeCents,
      automatic: tier.automaticQuote,
      reasonCode: tier.reasonCode,
    })),
    ...(Object.hasOwn(policy, "additionalRules") ? { additionalRules: policy.additionalRules } : {}),
  };
  return (
    policy.policyId === WALKING_ROUTE_DISTANCE_POLICY_KEY &&
    policy.versionKey === WALKING_ROUTE_DISTANCE_POLICY_VERSION &&
    policy.status === "PUBLISHED" &&
    policy.strategy === WALKING_ROUTE_DISTANCE_STRATEGY &&
    policy.environment === WALKING_ROUTE_DISTANCE_ENVIRONMENT &&
    validateWalkingRouteDistancePolicyDefinition(definition).valid &&
    policyTierByCode(policy) !== null
  );
}

function routeCandidateIds(
  evaluation: ReturnType<typeof evaluateWalkingDelivery>,
): readonly string[] | null {
  if (evaluation.eligible || evaluation.reasonCode === "ROUTE_METRICS_REQUIRED") {
    const ids = evaluation.candidates?.map(({ locationId }) => locationId) ?? [];
    return ids.length > 0 ? ids : null;
  }
  return null;
}

export async function evaluateWalkingDeliveryQuote(
  command: EvaluateWalkingDeliveryQuoteCommand,
  dependencies: EvaluateWalkingDeliveryQuoteDependencies,
): Promise<WalkingQuoteResult> {
  const address = normalizedRequestAddress(command.address);
  if (
    address.length < 5 ||
    address.length > 500 ||
    !validInstant(command.serviceAt) ||
    !Number.isInteger(command.subtotalCents) ||
    command.subtotalCents < 0 ||
    !command.clientId.trim() ||
    !command.idempotencyKey.trim() ||
    !command.correlationId.trim()
  ) {
    throw new WalkingQuoteEvaluationError("INVALID_REQUEST");
  }

  const requestHash = stableSha256Digest({
    clientId: command.clientId,
    address,
    serviceAt: command.serviceAt,
    subtotalCents: command.subtotalCents,
    environment: command.environment,
  });
  const existing = await dependencies.store.findByIdempotency({
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
  });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new WalkingQuoteEvaluationError("IDEMPOTENCY_CONFLICT");
    return { ...existing.result, replayed: true };
  }
  const calculatedAt = (dependencies.now?.() ?? new Date()).toISOString();

  let geocoded: GeocodedWalkingAddress;
  try {
    geocoded = await dependencies.geocoder.geocodeExactAddress(address, command.correlationId);
  } catch {
    throw new WalkingQuoteEvaluationError("GEOCODING_FAILED");
  }
  if (
    !geocoded.normalizedAddress.trim() ||
    !validPoint(geocoded.point) ||
    !/^\d{5}$/.test(geocoded.postalCode) ||
    !geocoded.provider.trim() ||
    geocoded.matchType !== "EXACT_ADDRESS" ||
    geocoded.ambiguous !== false
  ) {
    throw new WalkingQuoteEvaluationError("GEOCODING_FAILED");
  }

  const configuration = await dependencies.configuration.getPublishedConfiguration({
    postalCode: geocoded.postalCode,
    serviceAt: command.serviceAt,
    calculatedAt,
    environment: command.environment,
  });
  if (
    !configuration ||
    configuration.feePolicyVersion.environment !== command.environment ||
    !validateConfiguration(configuration)
  ) {
    throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
  }

  const preflight = evaluateWalkingDelivery({
    point: geocoded.point,
    postalCode: geocoded.postalCode,
    serviceAt: command.serviceAt,
    subtotalCents: command.subtotalCents,
    zones: configuration.zones,
  });
  const candidateIds = routeCandidateIds(preflight);
  if (!candidateIds) {
    if (preflight.eligible) {
      throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
    }
    if (preflight.reasonCode === "NO_AVAILABLE_SLOTS" || preflight.reasonCode === "MANAGER_REVIEW") {
      throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
    }
    throw new WalkingQuoteEvaluationError(preflight.reasonCode);
  }

  const locations = new Map(configuration.locations.map((location) => [location.locationId, location]));
  let routes: Array<{
    locationId: string;
    provider: string;
    distanceFeet: number;
    durationSeconds: number;
  }>;
  try {
    routes = await Promise.all(candidateIds.map(async (locationId) => {
        const location = locations.get(locationId);
        if (!location || !validPoint(location.point)) throw new Error("invalid location");
        const route = await dependencies.router.getWalkingRoute({
          origin: location.point,
          destination: geocoded.point,
          correlationId: command.correlationId,
        });
        if (
          !route.provider.trim() ||
          route.profile !== "walking" ||
          !Number.isFinite(route.distanceMeters) ||
          route.distanceMeters < 0 ||
          !Number.isInteger(route.durationSeconds) ||
          route.durationSeconds < 0
        ) {
          throw new Error("invalid route");
        }
        return {
          locationId,
          provider: route.provider,
          distanceFeet: distanceMetersToFeet(route.distanceMeters),
          durationSeconds: route.durationSeconds,
        };
      }),
    );
  } catch {
    throw new WalkingQuoteEvaluationError("ROUTING_UNAVAILABLE");
  }

  const evaluatedZone = evaluateWalkingDelivery({
    point: geocoded.point,
    postalCode: geocoded.postalCode,
    serviceAt: command.serviceAt,
    subtotalCents: command.subtotalCents,
    zones: configuration.zones,
    routeMetrics: routes.map((route) => ({
      locationId: route.locationId,
      walkingDistanceMiles: route.distanceFeet / FEET_PER_MILE,
      walkingDurationMinutes: route.durationSeconds / 60,
    })),
  });
  if (!evaluatedZone.eligible) {
    throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
  }
  if (!evaluatedZone.zoneVersionId) {
    throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
  }

  const policyResultBeforeSlots = evaluateWalkingRouteDistanceStandard({
    postalCode: geocoded.postalCode,
    candidates: routes.map((route) => ({
      locationId: route.locationId,
      trustedWalkingDistanceFeet: route.distanceFeet,
      trustedWalkingDurationSeconds: route.durationSeconds,
      hasAvailableSlots: true,
    })),
  });
  if (!policyResultBeforeSlots.selectedLocationId || policyResultBeforeSlots.selectedLocationId !== evaluatedZone.selectedLocationId) {
    throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
  }

  const selectedRoute = routes.find(({ locationId }) => locationId === policyResultBeforeSlots.selectedLocationId);
  const tiersByCode = policyTierByCode(configuration.feePolicyVersion);
  const tier = policyResultBeforeSlots.tierCode && tiersByCode?.get(policyResultBeforeSlots.tierCode);
  if (!selectedRoute || !tier) throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");

  let availableSlots: readonly WalkingQuoteSlot[] = [];
  let finalPolicyResult: WalkingRouteDistanceStandardResult = policyResultBeforeSlots;
  if (policyResultBeforeSlots.reasonCode !== "MANAGER_REVIEW") {
    try {
      availableSlots = await dependencies.slots.getAvailableSlots({
        locationId: policyResultBeforeSlots.selectedLocationId,
        slotPolicyId: evaluatedZone.slotPolicyId,
        serviceAt: command.serviceAt,
        correlationId: command.correlationId,
      });
    } catch {
      throw new WalkingQuoteEvaluationError("SLOTS_UNAVAILABLE");
    }
    const slotIds = new Set<string>();
    for (const slot of availableSlots) {
      if (
        !validAvailableSlot(slot, policyResultBeforeSlots.selectedLocationId) ||
        slotIds.has(slot.slotId)
      ) {
        throw new WalkingQuoteEvaluationError("SLOTS_UNAVAILABLE");
      }
      slotIds.add(slot.slotId);
    }
    const policyResultWithSlots = evaluateWalkingRouteDistanceStandard({
      postalCode: geocoded.postalCode,
      candidates: routes.map((route) => ({
        locationId: route.locationId,
        trustedWalkingDistanceFeet: route.distanceFeet,
        trustedWalkingDurationSeconds: route.durationSeconds,
        hasAvailableSlots: route.locationId === policyResultBeforeSlots.selectedLocationId ? availableSlots.length > 0 : true,
      })),
    });
    if (!policyResultWithSlots.selectedLocationId) {
      throw new WalkingQuoteEvaluationError("CONFIGURATION_NOT_READY");
    }
    finalPolicyResult = policyResultWithSlots;
  }

  const slotPolicyWasEvaluated =
    finalPolicyResult.reasonCode === "ELIGIBLE" || finalPolicyResult.reasonCode === "NO_AVAILABLE_SLOTS";
  return dependencies.store.save({
    schemaVersion: WALKING_QUOTE_SCHEMA_VERSION,
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
    requestHash,
    correlationId: command.correlationId,
    eligible: finalPolicyResult.reasonCode === "ELIGIBLE",
    normalizedAddress: geocoded.normalizedAddress,
    customerCoordinates: geocoded.point,
    postalCode: geocoded.postalCode,
    selectedLocationId: finalPolicyResult.selectedLocationId,
    zoneVersionId: evaluatedZone.zoneVersionId,
    feePolicyVersionId: configuration.feePolicyVersion.id,
    routingProvider: selectedRoute.provider,
    routingProfile: "walking",
    distanceFeet: finalPolicyResult.trustedWalkingDistanceFeet,
    durationSeconds: finalPolicyResult.trustedWalkingDurationSeconds,
    feeCents: finalPolicyResult.feeCents,
    tierId: tier.tierCode,
    tierRecordId: tier.id,
    reasonCode: finalPolicyResult.reasonCode,
    calculatedAt,
    slots: finalPolicyResult.reasonCode === "ELIGIBLE" ? availableSlots : [],
    feePolicySnapshot: configuration.feePolicyVersion,
    tierSnapshot: tier,
    slotPolicyId: slotPolicyWasEvaluated ? evaluatedZone.slotPolicyId : null,
    slotSnapshot: slotPolicyWasEvaluated ? availableSlots : null,
    walkingPublicationId: configuration.walkingPublicationId,
  });
}
