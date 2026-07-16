export type WalkingAssignmentStrategy = "FIXED" | "NEAREST_WALKING_ROUTE";

export type WalkingZoneStatus = "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";

export type WalkingServiceDay =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type WalkingReasonCode =
  | "ELIGIBLE"
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "GEOCODING_FAILED"
  | "AMBIGUOUS_ADDRESS"
  | "OUTSIDE_WALKING_ZONE"
  | "NO_ACTIVE_ZONE"
  | "SERVICE_DAY_UNAVAILABLE"
  | "INVALID_ZONE_CONFIGURATION"
  | "STORE_NOT_AVAILABLE"
  | "ROUTE_METRICS_REQUIRED"
  | "DISTANCE_EXCEEDED"
  | "ROUTE_TIME_EXCEEDED"
  | "MINIMUM_ORDER_NOT_MET"
  | "FEE_POLICY_INCOMPLETE"
  | "SLOT_POLICY_INCOMPLETE"
  | "NO_AVAILABLE_SLOTS"
  | "MANAGER_REVIEW";

export type WalkingPosition = readonly [longitude: number, latitude: number];
export type WalkingLinearRing = readonly WalkingPosition[];
export type WalkingPolygonCoordinates = readonly WalkingLinearRing[];

export interface WalkingPolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: WalkingPolygonCoordinates;
}

export interface WalkingMultiPolygonGeometry {
  readonly type: "MultiPolygon";
  readonly coordinates: readonly WalkingPolygonCoordinates[];
}

export type WalkingGeometry = WalkingPolygonGeometry | WalkingMultiPolygonGeometry;

export interface WalkingZoneConfiguration {
  readonly id: string;
  readonly versionId?: string;
  readonly postalCodes: readonly string[];
  readonly priority: number;
  readonly serviceMode: "WALKING";
  readonly assignmentStrategy: WalkingAssignmentStrategy;
  readonly locationIds: readonly string[];
  readonly geometry: WalkingGeometry;
  readonly activeDays: readonly WalkingServiceDay[];
  readonly maxDistanceMiles?: number | null;
  readonly maxRouteMinutes?: number | null;
  readonly minimumOrderCents?: number | null;
  readonly feePolicyByLocation: Readonly<Record<string, string>>;
  readonly slotPolicyByLocation: Readonly<Record<string, string>>;
  readonly status: WalkingZoneStatus;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
}

export interface WalkingRouteMetric {
  readonly locationId: string;
  readonly walkingDistanceMiles: number;
  readonly walkingDurationMinutes: number;
}

export interface WalkingDeliveryEvaluationInput {
  readonly point: WalkingPosition;
  readonly postalCode: string;
  readonly serviceAt: string;
  readonly subtotalCents: number;
  readonly zones: readonly WalkingZoneConfiguration[];
  readonly routeMetrics?: readonly WalkingRouteMetric[];
  readonly locationAvailabilityById?: Readonly<Record<string, boolean>>;
  readonly feePolicyCompletenessById?: Readonly<Record<string, boolean>>;
  readonly slotPolicyCompletenessById?: Readonly<Record<string, boolean>>;
  readonly slotAvailabilityByLocationId?: Readonly<Record<string, boolean>>;
}

export interface WalkingCandidateResult {
  readonly locationId: string;
  readonly walkingDistanceMiles?: number;
  readonly walkingDurationMinutes?: number;
}

export interface EligibleWalkingDeliveryResult {
  readonly eligible: true;
  readonly reasonCode: "ELIGIBLE";
  readonly postalCode: string;
  readonly point: WalkingPosition;
  readonly matchedZoneId: string;
  readonly zoneVersionId?: string;
  readonly assignmentStrategy: WalkingAssignmentStrategy;
  readonly candidates: readonly WalkingCandidateResult[];
  readonly selectedLocationId: string;
  readonly feePolicyId: string;
  readonly slotPolicyId: string;
}

export interface IneligibleWalkingDeliveryResult {
  readonly eligible: false;
  readonly reasonCode: Exclude<WalkingReasonCode, "ELIGIBLE">;
  readonly postalCode?: string;
  readonly point?: WalkingPosition;
  readonly matchedZoneId?: string;
  readonly zoneVersionId?: string;
  readonly assignmentStrategy?: WalkingAssignmentStrategy;
  readonly candidates?: readonly WalkingCandidateResult[];
  readonly selectedLocationId?: string;
}

export type WalkingDeliveryEvaluationResult =
  | EligibleWalkingDeliveryResult
  | IneligibleWalkingDeliveryResult;

export interface WalkingGeometryValidationIssue {
  readonly code:
    | "INVALID_GEOMETRY_TYPE"
    | "EMPTY_GEOMETRY"
    | "EMPTY_POLYGON"
    | "RING_TOO_SHORT"
    | "RING_NOT_CLOSED"
    | "INVALID_POSITION"
    | "COORDINATE_OUT_OF_RANGE"
    | "RING_DEGENERATE_SEGMENT"
    | "RING_ZERO_AREA"
    | "RING_SELF_INTERSECTION";
  readonly path: string;
  readonly message: string;
}

export interface WalkingGeometryValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WalkingGeometryValidationIssue[];
}

export interface WalkingZoneValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface WalkingZoneValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WalkingZoneValidationIssue[];
}
