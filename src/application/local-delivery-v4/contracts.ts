import {
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
  LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
  LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
  LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE,
  LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
  LOCAL_WALKING_DELIVERY_V4_STRATEGY,
  LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
} from "../../domain/walking-delivery/local-walking-delivery-v4";

export const LOCAL_DELIVERY_FEE_POLICY_VERSION_ID =
  LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID;
export const LOCAL_DELIVERY_ZONE_VERSION_ID =
  LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID;

export type LocalDeliveryEnvironment = "STAGING" | "PRODUCTION";

export type LocalDeliveryAddress = {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
};

export type LocalDeliveryGeocodedAddress = LocalDeliveryAddress & {
  readonly borough: string;
};

export type LocalDeliveryNormalizedAddress = LocalDeliveryAddress & {
  readonly borough: "Manhattan";
};

export type LocalDeliveryCartLine = {
  readonly variantId: string;
  readonly quantity: number;
};

export type LocalDeliveryInventoryTransferStatus =
  | "NOT_REQUIRED"
  | "TRANSFER_REQUIRED"
  | "REQUESTED"
  | "IN_TRANSIT"
  | "RECEIVED"
  | "READY";

/**
 * Internal, immutable evidence used to persist and later reserve the exact
 * inventory assessed for a quote. These database identities are deliberately
 * kept out of the storefront quote response.
 */
export type LocalDeliveryInventoryLineEvidence = {
  readonly lineNumber: number;
  readonly variantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly readinessStatus: "READY" | "TRANSFER_REQUIRED";
  readonly inventoryOwnerLocationId: string;
  readonly inventoryOwnerExternalLocationId: string;
  readonly inventoryNodeId: string;
  readonly inventoryNodeExternalId: string;
  readonly containerId: string | null;
  readonly storageLocationId: string | null;
  readonly transferStatus: LocalDeliveryInventoryTransferStatus;
  readonly earliestReadyAt: string | null;
};

export type LocalDeliveryCoordinates = {
  readonly latitude: number;
  readonly longitude: number;
};

export type LocalDeliveryGeocode = {
  readonly normalizedAddress: LocalDeliveryGeocodedAddress;
  readonly coordinates: LocalDeliveryCoordinates;
  readonly postalCode: string;
  readonly exactAddress: boolean;
  readonly ambiguous: boolean;
  /** A trusted provider decision, not a city-name substring check. */
  readonly isManhattan: boolean;
  readonly provider: string;
};

export type LocalDeliveryLocation = {
  readonly locationId: string;
  readonly name: string;
  readonly address: string;
  readonly coordinates: LocalDeliveryCoordinates;
  readonly priority: number;
};

export type LocalDeliveryAssignment =
  | {
      readonly rule: "FIXED_POSTAL_ZONE";
      readonly candidates: readonly [LocalDeliveryLocation];
    }
  | {
      readonly rule: "NEAREST_WALKING_ROUTE";
      readonly candidates: readonly [LocalDeliveryLocation, LocalDeliveryLocation];
    };

export type LocalDeliveryPolicySnapshot = {
  readonly policyId: typeof LOCAL_WALKING_DELIVERY_V4_POLICY_ID;
  readonly feePolicyVersionId: typeof LOCAL_DELIVERY_FEE_POLICY_VERSION_ID;
  readonly zoneVersionId: typeof LOCAL_DELIVERY_ZONE_VERSION_ID;
  readonly environment: LocalDeliveryEnvironment;
  readonly strategy: typeof LOCAL_WALKING_DELIVERY_V4_STRATEGY;
  readonly distanceBasis: typeof LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS;
  readonly distanceUnit: typeof LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT;
  readonly routingMode: typeof LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE;
  readonly currency: "USD";
  readonly routingProfile: typeof LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE;
  readonly quoteTtlSeconds: number;
  readonly holdTtlSeconds: number;
  readonly preparationBufferSeconds: number;
  readonly handoffBufferSeconds: number;
};

export type LocalDeliveryFee = {
  readonly feeCents: number;
  readonly tierId: string;
};

export type LocalDeliveryRoute = {
  readonly provider: string;
  readonly profile: "walking";
  readonly distanceMeters: number;
  readonly durationSeconds: number;
};

export type LocalDeliveryCandidateRoute = {
  readonly locationId: string;
  readonly locationPriority: number;
  readonly walkingDistanceFeet: number;
  readonly walkingDurationSeconds: number;
  readonly routingProvider: string;
};

export type LocalDeliveryInventoryAssessment = {
  readonly status: "READY" | "TRANSFER_REQUIRED" | "NOT_READY";
  readonly earliestReadyAt: string | null;
  readonly lines: readonly LocalDeliveryInventoryLineEvidence[];
};

export type LocalDeliverySlot = {
  readonly slotId: string;
  readonly locationId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly remainingCapacitySeconds: number;
};

type LocalDeliveryQuoteOfferCommon = {
  readonly quoteId: string;
  readonly replayed: boolean;
  readonly eligible: true;
  readonly normalizedAddress: LocalDeliveryNormalizedAddress;
  readonly coordinates: LocalDeliveryCoordinates;
  readonly postalCode: string;
  readonly selectedLocationId: string;
  readonly selectedLocationName: string;
  readonly assignmentRule: LocalDeliveryAssignment["rule"];
  readonly walkingDistanceFeet: number;
  readonly walkingDurationSeconds: number;
  readonly roundTripDistanceFeet: number;
  readonly estimatedRoundTripDurationSeconds: number;
  readonly requiredCapacitySeconds: number;
  readonly feeCents: number;
  readonly currency: "USD";
  readonly feeTierId: string;
  readonly candidateRoutes: readonly LocalDeliveryCandidateRoute[];
  readonly availableSlots: readonly LocalDeliverySlot[];
  readonly inventoryStatus: "READY" | "TRANSFER_REQUIRED";
  readonly transferEarliestReadyAt: string | null;
  readonly inventoryOwnerLocationIds: readonly string[];
  readonly inventoryNodeIds: readonly string[];
  readonly zoneVersionId: typeof LOCAL_DELIVERY_ZONE_VERSION_ID;
  readonly feePolicyVersionId: typeof LOCAL_DELIVERY_FEE_POLICY_VERSION_ID;
  readonly routingProvider: string;
  readonly routingProfile: "walking";
  readonly routeCalculatedAt: string;
  readonly expiresAt: string;
  readonly correlationId: string;
};

export type LocalDeliveryQuoteOffer = LocalDeliveryQuoteOfferCommon &
  (
    | {
        readonly bookable: true;
        readonly reasonCode: "ELIGIBLE" | "TRANSFER_REQUIRED";
      }
    | {
        readonly bookable: false;
        readonly reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION";
      }
  );

export type LocalDeliveryContactStoreQuote = {
  readonly quoteId: string;
  readonly replayed: boolean;
  readonly eligible: false;
  readonly bookable: false;
  readonly reasonCode: "CONTACT_STORE";
  readonly storefrontMessage: "Contact store";
  readonly normalizedAddress: LocalDeliveryNormalizedAddress;
  readonly coordinates: LocalDeliveryCoordinates;
  readonly postalCode: string;
  readonly correlationId: string;
  readonly expiresAt: string;
};

export type LocalDeliveryQuoteResult =
  | LocalDeliveryQuoteOffer
  | LocalDeliveryContactStoreQuote;

type WithoutQuoteIdentity<T> = T extends unknown
  ? Omit<T, "quoteId" | "replayed">
  : never;

export type LocalDeliveryQuoteDraft = WithoutQuoteIdentity<LocalDeliveryQuoteResult>;

export type LocalDeliveryOfferPersistencePlan = {
  readonly kind: "OFFER";
  readonly calculatedAt: string;
  readonly holdTtlSeconds: number;
  readonly preparationBufferSeconds: number;
  readonly handoffBufferSeconds: number;
  readonly inventoryLines: readonly LocalDeliveryInventoryLineEvidence[];
};

export type LocalDeliveryQuotePersistencePlan =
  | LocalDeliveryOfferPersistencePlan
  | {
      readonly kind: "CONTACT_STORE";
      readonly calculatedAt: string;
    };

type LocalDeliveryQuoteSaveCommon = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly cartLines: readonly LocalDeliveryCartLine[];
};

export type LocalDeliveryQuoteSaveInput = LocalDeliveryQuoteSaveCommon &
  (
    | {
        readonly quote: Extract<LocalDeliveryQuoteDraft, { eligible: true }>;
        readonly persistencePlan: LocalDeliveryOfferPersistencePlan;
      }
    | {
        readonly quote: Extract<LocalDeliveryQuoteDraft, { eligible: false }>;
        readonly persistencePlan: Extract<
          LocalDeliveryQuotePersistencePlan,
          { kind: "CONTACT_STORE" }
        >;
      }
  );

export type EvaluateLocalDeliveryQuoteCommand = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly environment: LocalDeliveryEnvironment;
  readonly address: LocalDeliveryAddress;
  readonly cartLines: readonly LocalDeliveryCartLine[];
  readonly requestedDate: string;
};

export interface LocalDeliveryGeocoderPort {
  geocodeExactAddress(input: {
    address: LocalDeliveryAddress;
    correlationId: string;
  }): Promise<LocalDeliveryGeocode | null>;
}

export interface LocalDeliveryPolicyPort {
  getPublishedPolicy(input: {
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
  }): Promise<LocalDeliveryPolicySnapshot | null>;
  getAssignment(input: {
    postalCode: string;
    feePolicyVersionId: typeof LOCAL_DELIVERY_FEE_POLICY_VERSION_ID;
    zoneVersionId: typeof LOCAL_DELIVERY_ZONE_VERSION_ID;
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
  }): Promise<LocalDeliveryAssignment | null>;
  evaluateFee(input: {
    feePolicyVersionId: typeof LOCAL_DELIVERY_FEE_POLICY_VERSION_ID;
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
    walkingDistanceFeet: number;
  }): Promise<LocalDeliveryFee | null>;
}

export interface LocalDeliveryZonePort {
  containsPoint(input: {
    zoneVersionId: typeof LOCAL_DELIVERY_ZONE_VERSION_ID;
    postalCode: string;
    coordinates: LocalDeliveryCoordinates;
    calculatedAt: string;
  }): Promise<boolean>;
}

export interface LocalDeliveryRouterPort {
  getWalkingRoute(input: {
    origin: LocalDeliveryCoordinates;
    destination: LocalDeliveryCoordinates;
    correlationId: string;
  }): Promise<LocalDeliveryRoute>;
}

export interface LocalDeliveryInventoryPort {
  assess(input: {
    deliveryLocationId: string;
    cartLines: readonly LocalDeliveryCartLine[];
    requestedDate: string;
    correlationId: string;
  }): Promise<LocalDeliveryInventoryAssessment>;
}

export interface LocalDeliverySlotPort {
  getAvailableSlots(input: {
    locationId: string;
    requestedDate: string;
    requiredCapacitySeconds: number;
    notBefore: string | null;
    correlationId: string;
  }): Promise<readonly LocalDeliverySlot[]>;
}

export interface LocalDeliveryQuoteStorePort {
  findByIdempotency(input: {
    clientId: string;
    idempotencyKey: string;
  }): Promise<{
    readonly requestHash: string;
    readonly quote: LocalDeliveryQuoteResult;
  } | null>;
  save(input: LocalDeliveryQuoteSaveInput): Promise<LocalDeliveryQuoteResult>;
  findById(quoteId: string): Promise<{
    readonly clientId: string;
    readonly cartLines: readonly LocalDeliveryCartLine[];
    readonly quote: LocalDeliveryQuoteResult;
    readonly persistencePlan: LocalDeliveryQuotePersistencePlan;
  } | null>;
}

export type LocalDeliveryQuoteDependencies = {
  readonly geocoder: LocalDeliveryGeocoderPort;
  readonly policy: LocalDeliveryPolicyPort;
  readonly zone: LocalDeliveryZonePort;
  readonly router: LocalDeliveryRouterPort;
  readonly inventory: LocalDeliveryInventoryPort;
  readonly slots: LocalDeliverySlotPort;
  readonly quotes: LocalDeliveryQuoteStorePort;
  readonly now?: () => Date;
};

export type LocalDeliveryErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_ADDRESS"
  | "ADDRESS_NOT_IN_MANHATTAN"
  | "OUTSIDE_WALKING_AREA"
  | "DISTANCE_UNAVAILABLE"
  | "ROUTING_PROVIDER_UNAVAILABLE"
  | "NO_SLOTS_FOR_SELECTED_LOCATION"
  | "INVENTORY_NOT_READY"
  | "TRANSFER_REQUIRED"
  | "QUOTE_EXPIRED"
  | "CAPACITY_HOLD_FAILED"
  | "POLICY_VERSION_UNAVAILABLE"
  | "SLOTS_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT";

export class LocalDeliveryApplicationError extends Error {
  constructor(readonly code: LocalDeliveryErrorCode) {
    super(code);
    this.name = "LocalDeliveryApplicationError";
  }
}

export class LocalDeliveryRoutingError extends Error {
  constructor(
    readonly code: "DISTANCE_UNAVAILABLE" | "ROUTING_PROVIDER_UNAVAILABLE",
  ) {
    super(code);
    this.name = "LocalDeliveryRoutingError";
  }
}
