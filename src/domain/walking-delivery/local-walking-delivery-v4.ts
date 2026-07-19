export const LOCAL_WALKING_DELIVERY_V4_POLICY_ID =
  "walking-route-distance-v4-base-10" as const;
export const LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID =
  "walking-route-distance-v4-base-10-2026-07-16" as const;
export const LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID =
  "upper-east-side-walking-zones-v1" as const;
export const LOCAL_WALKING_DELIVERY_V4_STRATEGY = "WALKING_ROUTE_DISTANCE" as const;
export const LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS =
  "ONE_WAY_FROM_SELECTED_STORE" as const;
export const LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT = "FEET" as const;
export const LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE = "WALKING" as const;
export const LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE = "walking" as const;
export const LOCAL_WALKING_DELIVERY_V4_CURRENCY = "USD" as const;

export const LOCAL_WALKING_DELIVERY_V4_LOCATION_IDS = [
  "third_avenue",
  "east_86th_street",
] as const;

export type LocalWalkingDeliveryV4LocationId =
  (typeof LOCAL_WALKING_DELIVERY_V4_LOCATION_IDS)[number];

export const LOCAL_WALKING_DELIVERY_V4_LOCATIONS = {
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
} as const satisfies Readonly<
  Record<
    LocalWalkingDeliveryV4LocationId,
    {
      readonly locationId: LocalWalkingDeliveryV4LocationId;
      readonly name: string;
      readonly address: string;
      readonly latitude: number;
      readonly longitude: number;
    }
  >
>;

export const LOCAL_WALKING_DELIVERY_V4_SUPPORTED_POSTAL_CODES = [
  "10021",
  "10065",
  "10075",
  "10028",
  "10128",
] as const;

export type LocalWalkingDeliveryV4PostalCode =
  (typeof LOCAL_WALKING_DELIVERY_V4_SUPPORTED_POSTAL_CODES)[number];

export const LOCAL_WALKING_DELIVERY_V4_DEFAULT_LOCATION_PRIORITY = [
  "third_avenue",
  "east_86th_street",
] as const satisfies readonly LocalWalkingDeliveryV4LocationId[];

export const LOCAL_WALKING_DELIVERY_V4_TIERS = [
  {
    id: "free-local",
    minimumExclusiveFeet: null,
    maximumInclusiveFeet: 1_200,
    feeCents: 0,
  },
  {
    id: "base-delivery",
    minimumExclusiveFeet: 1_200,
    maximumInclusiveFeet: 2_200,
    feeCents: 1_000,
  },
  {
    id: "extended-12",
    minimumExclusiveFeet: 2_200,
    maximumInclusiveFeet: 2_700,
    feeCents: 1_200,
  },
  {
    id: "extended-14",
    minimumExclusiveFeet: 2_700,
    maximumInclusiveFeet: 2_950,
    feeCents: 1_400,
  },
  {
    id: "extended-15",
    minimumExclusiveFeet: 2_950,
    maximumInclusiveFeet: 3_250,
    feeCents: 1_500,
  },
  {
    id: "extended-17",
    minimumExclusiveFeet: 3_250,
    maximumInclusiveFeet: 3_500,
    feeCents: 1_700,
  },
  {
    id: "extended-19",
    minimumExclusiveFeet: 3_500,
    maximumInclusiveFeet: 3_750,
    feeCents: 1_900,
  },
  {
    id: "extended-21",
    minimumExclusiveFeet: 3_750,
    maximumInclusiveFeet: 4_000,
    feeCents: 2_100,
  },
  {
    id: "extended-23",
    minimumExclusiveFeet: 4_000,
    maximumInclusiveFeet: 4_250,
    feeCents: 2_300,
  },
  {
    id: "whole-zone-25",
    minimumExclusiveFeet: 4_250,
    maximumInclusiveFeet: null,
    feeCents: 2_500,
  },
] as const;

export type LocalWalkingDeliveryV4Tier =
  (typeof LOCAL_WALKING_DELIVERY_V4_TIERS)[number];
export type LocalWalkingDeliveryV4TierId = LocalWalkingDeliveryV4Tier["id"];

export const LOCAL_WALKING_DELIVERY_V4_POLICY = {
  id: LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
  feePolicyVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
  zoneVersionId: LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
  status: "DRAFT",
  environment: "STAGING",
  strategy: LOCAL_WALKING_DELIVERY_V4_STRATEGY,
  distanceBasis: LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
  distanceUnit: LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
  routingMode: LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE,
  routingProfile: LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
  currency: LOCAL_WALKING_DELIVERY_V4_CURRENCY,
  locations: LOCAL_WALKING_DELIVERY_V4_LOCATIONS,
  postalAssignments: {
    fixed: {
      "10021": "third_avenue",
      "10065": "third_avenue",
      "10028": "east_86th_street",
      "10128": "east_86th_street",
    },
    shared: {
      "10075": ["third_avenue", "east_86th_street"],
    },
  },
  locationPriority: LOCAL_WALKING_DELIVERY_V4_DEFAULT_LOCATION_PRIORITY,
  tiers: LOCAL_WALKING_DELIVERY_V4_TIERS,
} as const;

export type LocalWalkingDeliveryV4AssignmentRule =
  | "FIXED_POSTAL_ZONE"
  | "NEAREST_WALKING_ROUTE";

export type LocalWalkingDeliveryV4ReasonCode =
  | "ELIGIBLE"
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "ADDRESS_NOT_IN_MANHATTAN"
  | "CONTACT_STORE"
  | "OUTSIDE_WALKING_AREA"
  | "DISTANCE_UNAVAILABLE"
  | "ROUTING_PROVIDER_UNAVAILABLE"
  | "NO_SLOTS_FOR_SELECTED_LOCATION";

export interface LocalWalkingDeliveryV4CandidateRouteInput {
  readonly locationId: LocalWalkingDeliveryV4LocationId;
  readonly walkingDistanceFeet: number;
  readonly walkingDurationSeconds: number;
  readonly hasAvailableSlots: boolean;
}

export interface LocalWalkingDeliveryV4OperationalBuffers {
  readonly preparationSeconds: number;
  readonly handoffSeconds: number;
}

export interface LocalWalkingDeliveryV4Input {
  /** True only after the geocoder produced a non-ambiguous exact address. */
  readonly addressIsValid: boolean;
  /** Trusted jurisdiction result from the normalized geocoded address. */
  readonly isManhattan: boolean;
  readonly postalCode: string;
  /** Result of point-in-polygon against the published zone version. */
  readonly isInsidePublishedZone: boolean;
  readonly candidateRoutes: readonly LocalWalkingDeliveryV4CandidateRouteInput[];
  readonly routingProvider: string;
  readonly routingProfile: string;
  readonly routeCalculatedAt: string;
  readonly locationPriority?: readonly LocalWalkingDeliveryV4LocationId[];
  readonly operationalBuffers?: LocalWalkingDeliveryV4OperationalBuffers;
}

export interface LocalWalkingDeliveryV4CandidateRoute {
  readonly locationId: LocalWalkingDeliveryV4LocationId;
  readonly walkingDistanceFeet: number;
  readonly walkingDurationSeconds: number;
}

export interface LocalWalkingDeliveryV4RoundTripMetrics {
  readonly roundTripDistanceFeet: number;
  readonly estimatedRoundTripDurationSeconds: number;
  readonly operationalDurationSeconds: number;
}

export type LocalWalkingDeliveryV4TierResult =
  | {
      readonly valid: true;
      readonly walkingDistanceFeet: number;
      readonly feeTierId: LocalWalkingDeliveryV4TierId;
      readonly feeCents: number;
    }
  | {
      readonly valid: false;
      readonly walkingDistanceFeet: number;
      readonly feeTierId: null;
      readonly feeCents: null;
      readonly reasonCode: "INVALID_INPUT";
    };

interface LocalWalkingDeliveryV4ResultCommon {
  readonly feePolicyVersionId: typeof LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID;
  readonly zoneVersionId: typeof LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID;
  readonly postalCode: string;
}

type LocalWalkingDeliveryV4EarlyFailure = LocalWalkingDeliveryV4ResultCommon & {
  readonly eligible: false;
  readonly bookable: false;
  readonly reasonCode: Exclude<
    LocalWalkingDeliveryV4ReasonCode,
    "ELIGIBLE" | "NO_SLOTS_FOR_SELECTED_LOCATION" | "CONTACT_STORE"
  >;
};

export type LocalWalkingDeliveryV4ContactStoreResult = {
  readonly eligible: false;
  readonly bookable: false;
  readonly reasonCode: "CONTACT_STORE";
  readonly storefrontMessage: "Contact store";
  readonly postalCode: string;
};

interface LocalWalkingDeliveryV4PricedResultCommon
  extends LocalWalkingDeliveryV4ResultCommon,
    LocalWalkingDeliveryV4RoundTripMetrics {
  readonly assignmentRule: LocalWalkingDeliveryV4AssignmentRule;
  readonly selectedLocationId: LocalWalkingDeliveryV4LocationId;
  readonly selectedLocationName: string;
  readonly walkingDistanceFeet: number;
  readonly walkingDurationSeconds: number;
  readonly feeCents: number;
  readonly currency: typeof LOCAL_WALKING_DELIVERY_V4_CURRENCY;
  readonly feeTierId: LocalWalkingDeliveryV4TierId;
  readonly candidateRoutes: readonly LocalWalkingDeliveryV4CandidateRoute[];
  readonly locationPriority: readonly LocalWalkingDeliveryV4LocationId[];
  readonly routingProvider: string;
  readonly routingProfile: typeof LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE;
  readonly routeCalculatedAt: string;
  readonly distanceBasis: typeof LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS;
  readonly distanceUnit: typeof LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT;
}

export type LocalWalkingDeliveryV4Result =
  | (LocalWalkingDeliveryV4PricedResultCommon & {
      readonly eligible: true;
      readonly bookable: true;
      readonly reasonCode: "ELIGIBLE";
      readonly slotLocationId: LocalWalkingDeliveryV4LocationId;
    })
  | (LocalWalkingDeliveryV4PricedResultCommon & {
      readonly eligible: true;
      readonly bookable: false;
      readonly reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION";
      readonly slotLocationId: null;
    })
  | LocalWalkingDeliveryV4ContactStoreResult
  | LocalWalkingDeliveryV4EarlyFailure;

const FIXED_LOCATION_BY_POSTAL_CODE: Readonly<
  Partial<Record<LocalWalkingDeliveryV4PostalCode, LocalWalkingDeliveryV4LocationId>>
> = {
  "10021": "third_avenue",
  "10065": "third_avenue",
  "10028": "east_86th_street",
  "10128": "east_86th_street",
};

const SHARED_POSTAL_CODE: LocalWalkingDeliveryV4PostalCode = "10075";
const SUPPORTED_POSTAL_CODES = new Set<string>(
  LOCAL_WALKING_DELIVERY_V4_SUPPORTED_POSTAL_CODES,
);
const KNOWN_LOCATION_IDS = new Set<string>(LOCAL_WALKING_DELIVERY_V4_LOCATION_IDS);

function normalizedUsPostalCode(value: string): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{5})(?:-\d{4})?$/.exec(value.trim());
  return match?.[1] ?? null;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function resolveLocationPriority(
  value: readonly LocalWalkingDeliveryV4LocationId[] | undefined,
): readonly LocalWalkingDeliveryV4LocationId[] | null {
  const priority = value ?? LOCAL_WALKING_DELIVERY_V4_DEFAULT_LOCATION_PRIORITY;
  if (priority.length !== LOCAL_WALKING_DELIVERY_V4_LOCATION_IDS.length) return null;
  if (new Set(priority).size !== LOCAL_WALKING_DELIVERY_V4_LOCATION_IDS.length) return null;
  if (priority.some((locationId) => !KNOWN_LOCATION_IDS.has(locationId))) return null;
  return [...priority];
}

function resolveOperationalBuffers(
  value: LocalWalkingDeliveryV4OperationalBuffers | undefined,
): LocalWalkingDeliveryV4OperationalBuffers | null {
  const buffers = value ?? { preparationSeconds: 0, handoffSeconds: 0 };
  if (
    !isNonNegativeInteger(buffers.preparationSeconds) ||
    !isNonNegativeInteger(buffers.handoffSeconds)
  ) {
    return null;
  }
  return buffers;
}

export function calculateLocalWalkingDeliveryV4RoundTripMetrics(
  walkingDistanceFeet: number,
  walkingDurationSeconds: number,
  operationalBuffers?: LocalWalkingDeliveryV4OperationalBuffers,
): LocalWalkingDeliveryV4RoundTripMetrics | null {
  const buffers = resolveOperationalBuffers(operationalBuffers);
  if (
    !buffers ||
    !isNonNegativeFinite(walkingDistanceFeet) ||
    !isNonNegativeInteger(walkingDurationSeconds)
  ) {
    return null;
  }

  const estimatedRoundTripDurationSeconds = walkingDurationSeconds * 2;
  return {
    roundTripDistanceFeet: walkingDistanceFeet * 2,
    estimatedRoundTripDurationSeconds,
    operationalDurationSeconds:
      estimatedRoundTripDurationSeconds +
      buffers.preparationSeconds +
      buffers.handoffSeconds,
  };
}

export function evaluateLocalWalkingDeliveryV4Tier(
  walkingDistanceFeet: number,
): LocalWalkingDeliveryV4TierResult {
  if (!isNonNegativeFinite(walkingDistanceFeet)) {
    return {
      valid: false,
      walkingDistanceFeet,
      feeTierId: null,
      feeCents: null,
      reasonCode: "INVALID_INPUT",
    };
  }

  const tier = LOCAL_WALKING_DELIVERY_V4_TIERS.find(
    (candidate) =>
      (candidate.minimumExclusiveFeet === null ||
        walkingDistanceFeet > candidate.minimumExclusiveFeet) &&
      (candidate.maximumInclusiveFeet === null ||
        walkingDistanceFeet <= candidate.maximumInclusiveFeet),
  );

  // The final tier is open, so every finite non-negative distance must match.
  if (!tier) {
    return {
      valid: false,
      walkingDistanceFeet,
      feeTierId: null,
      feeCents: null,
      reasonCode: "INVALID_INPUT",
    };
  }

  return {
    valid: true,
    walkingDistanceFeet,
    feeTierId: tier.id,
    feeCents: tier.feeCents,
  };
}

function routeSetForPostalCode(
  postalCode: LocalWalkingDeliveryV4PostalCode,
  candidateRoutes: readonly LocalWalkingDeliveryV4CandidateRouteInput[],
):
  | {
      readonly assignmentRule: LocalWalkingDeliveryV4AssignmentRule;
      readonly selected: LocalWalkingDeliveryV4CandidateRouteInput;
      readonly auditedRoutes: readonly LocalWalkingDeliveryV4CandidateRouteInput[];
    }
  | null {
  const byLocationId = new Map<
    LocalWalkingDeliveryV4LocationId,
    LocalWalkingDeliveryV4CandidateRouteInput
  >();

  for (const route of candidateRoutes) {
    if (
      !route ||
      !KNOWN_LOCATION_IDS.has(route.locationId) ||
      byLocationId.has(route.locationId) ||
      !isNonNegativeFinite(route.walkingDistanceFeet) ||
      !isNonNegativeInteger(route.walkingDurationSeconds) ||
      typeof route.hasAvailableSlots !== "boolean"
    ) {
      return null;
    }
    byLocationId.set(route.locationId, route);
  }

  const fixedLocationId = FIXED_LOCATION_BY_POSTAL_CODE[postalCode];
  if (fixedLocationId) {
    const selected = byLocationId.get(fixedLocationId);
    if (!selected) return null;
    return {
      assignmentRule: "FIXED_POSTAL_ZONE",
      selected,
      auditedRoutes: [selected],
    };
  }

  const thirdAvenue = byLocationId.get("third_avenue");
  const east86thStreet = byLocationId.get("east_86th_street");
  if (postalCode !== SHARED_POSTAL_CODE || !thirdAvenue || !east86thStreet) return null;

  return {
    assignmentRule: "NEAREST_WALKING_ROUTE",
    selected: thirdAvenue,
    auditedRoutes: [thirdAvenue, east86thStreet],
  };
}

function selectNearestRoute(
  routes: readonly LocalWalkingDeliveryV4CandidateRouteInput[],
  locationPriority: readonly LocalWalkingDeliveryV4LocationId[],
): LocalWalkingDeliveryV4CandidateRouteInput {
  const priorityByLocation = new Map(
    locationPriority.map((locationId, index) => [locationId, index] as const),
  );

  return [...routes].sort(
    (left, right) =>
      left.walkingDistanceFeet - right.walkingDistanceFeet ||
      left.walkingDurationSeconds - right.walkingDurationSeconds ||
      (priorityByLocation.get(left.locationId) ?? Number.MAX_SAFE_INTEGER) -
        (priorityByLocation.get(right.locationId) ?? Number.MAX_SAFE_INTEGER),
  )[0];
}

function earlyFailure(
  postalCode: string,
  reasonCode: LocalWalkingDeliveryV4EarlyFailure["reasonCode"],
): LocalWalkingDeliveryV4EarlyFailure {
  return {
    eligible: false,
    bookable: false,
    reasonCode,
    postalCode,
    feePolicyVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
    zoneVersionId: LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
  };
}

export function evaluateLocalWalkingDeliveryV4(
  input: LocalWalkingDeliveryV4Input,
): LocalWalkingDeliveryV4Result {
  const postalCode = normalizedUsPostalCode(input.postalCode);

  if (input.addressIsValid !== true || !postalCode) {
    return earlyFailure(postalCode ?? "", "INVALID_ADDRESS");
  }
  if (input.isManhattan !== true) {
    return earlyFailure(postalCode, "ADDRESS_NOT_IN_MANHATTAN");
  }
  if (!SUPPORTED_POSTAL_CODES.has(postalCode)) {
    return {
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      postalCode,
    };
  }
  if (input.isInsidePublishedZone !== true) {
    return earlyFailure(postalCode, "OUTSIDE_WALKING_AREA");
  }

  if (
    !Array.isArray(input.candidateRoutes) ||
    input.routingProfile !== LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE ||
    typeof input.routingProvider !== "string" ||
    input.routingProvider.trim().length === 0 ||
    typeof input.routeCalculatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.routeCalculatedAt))
  ) {
    return earlyFailure(postalCode, "ROUTING_PROVIDER_UNAVAILABLE");
  }

  const locationPriority = resolveLocationPriority(input.locationPriority);
  const operationalBuffers = resolveOperationalBuffers(input.operationalBuffers);
  if (!locationPriority || !operationalBuffers) {
    return earlyFailure(postalCode, "INVALID_INPUT");
  }

  const routeSet = routeSetForPostalCode(
    postalCode as LocalWalkingDeliveryV4PostalCode,
    input.candidateRoutes,
  );
  if (!routeSet) {
    return earlyFailure(postalCode, "DISTANCE_UNAVAILABLE");
  }

  const selected =
    routeSet.assignmentRule === "NEAREST_WALKING_ROUTE"
      ? selectNearestRoute(routeSet.auditedRoutes, locationPriority)
      : routeSet.selected;
  const tier = evaluateLocalWalkingDeliveryV4Tier(selected.walkingDistanceFeet);
  const roundTrip = calculateLocalWalkingDeliveryV4RoundTripMetrics(
    selected.walkingDistanceFeet,
    selected.walkingDurationSeconds,
    operationalBuffers,
  );
  if (!tier.valid || !roundTrip) {
    return earlyFailure(postalCode, "DISTANCE_UNAVAILABLE");
  }

  const pricedCommon = {
    postalCode,
    feePolicyVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
    zoneVersionId: LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
    assignmentRule: routeSet.assignmentRule,
    selectedLocationId: selected.locationId,
    selectedLocationName: LOCAL_WALKING_DELIVERY_V4_LOCATIONS[selected.locationId].name,
    walkingDistanceFeet: selected.walkingDistanceFeet,
    walkingDurationSeconds: selected.walkingDurationSeconds,
    ...roundTrip,
    feeCents: tier.feeCents,
    currency: LOCAL_WALKING_DELIVERY_V4_CURRENCY,
    feeTierId: tier.feeTierId,
    candidateRoutes: routeSet.auditedRoutes.map(
      ({ locationId, walkingDistanceFeet, walkingDurationSeconds }) => ({
        locationId,
        walkingDistanceFeet,
        walkingDurationSeconds,
      }),
    ),
    locationPriority,
    routingProvider: input.routingProvider.trim(),
    routingProfile: LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
    routeCalculatedAt: input.routeCalculatedAt,
    distanceBasis: LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
    distanceUnit: LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
  } as const;

  if (!selected.hasAvailableSlots) {
    return {
      ...pricedCommon,
      eligible: true,
      bookable: false,
      reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION",
      slotLocationId: null,
    };
  }

  return {
    ...pricedCommon,
    eligible: true,
    bookable: true,
    reasonCode: "ELIGIBLE",
    slotLocationId: selected.locationId,
  };
}
