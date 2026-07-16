import { validateStoreOnlineFulfillmentPolicy } from "../../domain/fulfillment/store-online-policy";
import { validateWalkingGeometry } from "../../domain/walking-delivery";

export type FulfillmentDashboardBlockerScope = "WALKING_ZONE" | "STORE_ONLINE_POLICY";

export type FulfillmentDashboardBlockerCode =
  | "WALKING_ZONE_VERSION_REQUIRED"
  | "WALKING_CURRENT_VERSION_MISSING"
  | "WALKING_POSTAL_CODES_REQUIRED"
  | "WALKING_GEOMETRY_REQUIRED"
  | "WALKING_GEOMETRY_INVALID"
  | "WALKING_PRIORITY_REQUIRED"
  | "WALKING_PRIORITY_INVALID"
  | "WALKING_ACTIVE_DAYS_REQUIRED"
  | "WALKING_ASSIGNMENT_STRATEGY_INVALID"
  | "WALKING_FIXED_CANDIDATE_COUNT_INVALID"
  | "WALKING_NEAREST_CANDIDATE_COUNT_INVALID"
  | "WALKING_CANDIDATE_DUPLICATE"
  | "WALKING_CANDIDATE_LOCATION_INACTIVE"
  | "WALKING_CANDIDATE_PUBLIC_ID_REQUIRED"
  | "WALKING_CANDIDATE_MUST_BE_STORE"
  | "WALKING_FEE_POLICY_REQUIRED"
  | "WALKING_FEE_POLICY_SCOPE_INVALID"
  | "WALKING_FEE_POLICY_INCOMPLETE"
  | "WALKING_FEE_POLICY_LOCATION_MISMATCH"
  | "WALKING_SLOT_POLICY_REQUIRED"
  | "WALKING_SLOT_POLICY_INCOMPLETE"
  | "WALKING_SLOT_POLICY_MODE_INVALID"
  | "WALKING_SLOT_POLICY_LOCATION_MISMATCH"
  | "STORE_ONLINE_SOURCE_REQUIRED"
  | "STORE_ONLINE_CONSOLIDATION_REQUIRED"
  | "STORE_ONLINE_CONSOLIDATION_MUST_DIFFER"
  | "STORE_ONLINE_SOURCE_MUST_BE_STORE"
  | "STORE_ONLINE_CONSOLIDATION_MUST_BE_WAREHOUSE"
  | "STORE_ONLINE_SOURCE_INACTIVE"
  | "STORE_ONLINE_CONSOLIDATION_INACTIVE"
  | "STORE_ONLINE_SOURCE_PUBLIC_ID_REQUIRED"
  | "STORE_ONLINE_CONSOLIDATION_PUBLIC_ID_REQUIRED"
  | "STORE_ONLINE_ACTIVATION_GATE_REQUIRED"
  | "STORE_ONLINE_ADDED_BUSINESS_DAYS_INVALID"
  | "STORE_ONLINE_BUSINESS_CALENDAR_REQUIRED"
  | "STORE_ONLINE_CUTOFF_REQUIRED"
  | "STORE_ONLINE_PICKUP_CADENCE_REQUIRED"
  | "STORE_ONLINE_PICKUP_WEEKDAY_INVALID"
  | "STORE_ONLINE_TIME_ZONE_REQUIRED"
  | "STORE_ONLINE_MODE_INVALID"
  | "STORE_ONLINE_POLICY_INCOMPLETE"
  | "STORE_ONLINE_POLICY_NOT_PUBLISHED"
  | "STORE_ONLINE_SALES_DISABLED";

export interface FulfillmentDashboardBlocker {
  readonly scope: FulfillmentDashboardBlockerScope;
  readonly code: FulfillmentDashboardBlockerCode;
  readonly message: string;
  readonly subjectId: string;
  readonly locationId: string | null;
  readonly details: readonly string[];
}

interface DashboardLocationInput {
  readonly id: string;
  readonly type: string;
  readonly active: boolean;
  readonly publicId: string | null;
}

interface DashboardFeePolicyInput {
  readonly locationId: string;
  readonly serviceScope: string;
  readonly status: string;
  readonly activeDays: readonly string[];
}

interface DashboardSlotPolicyInput {
  readonly locationId: string;
  readonly fulfillmentMode: string;
  readonly status: string;
  readonly activeDays: readonly string[];
  readonly leadTimeMinutes: number | null;
  readonly cutoffMinuteOfDay: number | null;
  readonly capacityPolicyRef: string | null;
}

export interface WalkingCandidateReadinessInput {
  readonly location: DashboardLocationInput;
  readonly feePolicy: DashboardFeePolicyInput | null;
  readonly slotPolicy: DashboardSlotPolicyInput | null;
}

export interface WalkingZoneVersionReadinessInput {
  readonly id: string;
  readonly postalCodes: readonly string[];
  readonly geometry: unknown | null;
  readonly priority: number | null;
  readonly activeDays: readonly string[];
  readonly assignmentStrategy: string;
  readonly candidates: readonly WalkingCandidateReadinessInput[];
}

export interface WalkingZoneRecordReadinessInput {
  readonly id: string;
  readonly currentVersionNumber: number;
  readonly currentVersionId: string | null;
  readonly latestVersionId: string | null;
}

export interface StoreOnlinePolicyReadinessInput {
  readonly id: string;
  readonly status: string;
  readonly fulfillmentMode: string;
  readonly onlineSalesEnabled: boolean;
  readonly availableOnlyAfterStoreActivation: boolean;
  readonly addedBusinessDays: number;
  readonly timeZone: string;
  readonly pickupWeekdays: readonly string[];
  readonly retrievalCutoffMinuteOfDay: number | null;
  readonly businessCalendarRef: string | null;
  readonly sourceLocation: DashboardLocationInput;
  readonly consolidationLocation: DashboardLocationInput;
}

function blocker(
  scope: FulfillmentDashboardBlockerScope,
  code: FulfillmentDashboardBlockerCode,
  message: string,
  subjectId: string,
  locationId: string | null = null,
  details: readonly string[] = [],
): FulfillmentDashboardBlocker {
  return { scope, code, message, subjectId, locationId, details };
}

function policyStatusIsReady(status: string) {
  return status === "VALIDATED" || status === "PUBLISHED";
}

export function getWalkingZoneRecordBlockers(
  zone: WalkingZoneRecordReadinessInput,
): FulfillmentDashboardBlocker[] {
  const blockers: FulfillmentDashboardBlocker[] = [];

  if (!zone.latestVersionId) {
    blockers.push(
      blocker(
        "WALKING_ZONE",
        "WALKING_ZONE_VERSION_REQUIRED",
        "The walking zone does not have a configuration version.",
        zone.id,
      ),
    );
  }

  if (zone.currentVersionNumber > 0 && !zone.currentVersionId) {
    blockers.push(
      blocker(
        "WALKING_ZONE",
        "WALKING_CURRENT_VERSION_MISSING",
        `Current version ${zone.currentVersionNumber} could not be found.`,
        zone.id,
      ),
    );
  }

  return blockers;
}

export function getWalkingZoneVersionBlockers(
  version: WalkingZoneVersionReadinessInput,
): FulfillmentDashboardBlocker[] {
  const blockers: FulfillmentDashboardBlocker[] = [];
  const add = (
    code: FulfillmentDashboardBlockerCode,
    message: string,
    locationId: string | null = null,
    details: readonly string[] = [],
  ) => blockers.push(blocker("WALKING_ZONE", code, message, version.id, locationId, details));

  if (version.postalCodes.length === 0) {
    add("WALKING_POSTAL_CODES_REQUIRED", "At least one postal-code label is required.");
  }

  if (version.geometry == null) {
    add("WALKING_GEOMETRY_REQUIRED", "An approved Polygon or MultiPolygon is required.");
  } else {
    const geometryValidation = validateWalkingGeometry(version.geometry);
    if (!geometryValidation.valid) {
      add(
        "WALKING_GEOMETRY_INVALID",
        "The walking-zone geometry is invalid.",
        null,
        geometryValidation.issues.map((issue) => issue.code),
      );
    }
  }

  if (version.priority == null) {
    add("WALKING_PRIORITY_REQUIRED", "A deterministic overlap priority is required.");
  } else if (!Number.isInteger(version.priority)) {
    add("WALKING_PRIORITY_INVALID", "Walking-zone priority must be an integer.");
  }

  if (version.activeDays.length === 0) {
    add("WALKING_ACTIVE_DAYS_REQUIRED", "At least one active walking-delivery day is required.");
  }

  const locationIds = version.candidates.map(({ location }) => location.id);
  if (new Set(locationIds).size !== locationIds.length) {
    add("WALKING_CANDIDATE_DUPLICATE", "Candidate stores must be unique within a zone version.");
  }

  if (version.assignmentStrategy === "FIXED") {
    if (version.candidates.length !== 1) {
      add("WALKING_FIXED_CANDIDATE_COUNT_INVALID", "FIXED requires exactly one candidate store.");
    }
  } else if (version.assignmentStrategy === "NEAREST_WALKING_ROUTE") {
    if (version.candidates.length < 2) {
      add(
        "WALKING_NEAREST_CANDIDATE_COUNT_INVALID",
        "NEAREST_WALKING_ROUTE requires at least two candidate stores.",
      );
    }
  } else {
    add("WALKING_ASSIGNMENT_STRATEGY_INVALID", "The walking assignment strategy is not supported.");
  }

  for (const candidate of version.candidates) {
    const locationId = candidate.location.id;

    if (!candidate.location.active) {
      add("WALKING_CANDIDATE_LOCATION_INACTIVE", "The candidate location is inactive.", locationId);
    }
    if (!candidate.location.publicId?.trim()) {
      add(
        "WALKING_CANDIDATE_PUBLIC_ID_REQUIRED",
        "The candidate location needs a stable public integration ID.",
        locationId,
      );
    }
    if (candidate.location.type !== "STORE") {
      add("WALKING_CANDIDATE_MUST_BE_STORE", "Walking delivery candidates must be stores.", locationId);
    }

    const feePolicy = candidate.feePolicy;
    if (!feePolicy) {
      add("WALKING_FEE_POLICY_REQUIRED", "The candidate store needs a fee policy.", locationId);
    } else {
      if (feePolicy.locationId !== locationId) {
        add(
          "WALKING_FEE_POLICY_LOCATION_MISMATCH",
          "The fee policy belongs to a different location.",
          locationId,
        );
      }
      if (feePolicy.serviceScope !== "GENERAL_LOCAL_DELIVERY") {
        add(
          "WALKING_FEE_POLICY_SCOPE_INVALID",
          "Walking delivery requires a GENERAL_LOCAL_DELIVERY fee policy.",
          locationId,
        );
      }
      if (!policyStatusIsReady(feePolicy.status) || feePolicy.activeDays.length === 0) {
        add(
          "WALKING_FEE_POLICY_INCOMPLETE",
          "The fee policy must be validated and define active service days.",
          locationId,
        );
      }
    }

    const slotPolicy = candidate.slotPolicy;
    if (!slotPolicy) {
      add("WALKING_SLOT_POLICY_REQUIRED", "The candidate store needs a slot policy.", locationId);
    } else {
      if (slotPolicy.locationId !== locationId) {
        add(
          "WALKING_SLOT_POLICY_LOCATION_MISMATCH",
          "The slot policy belongs to a different location.",
          locationId,
        );
      }
      if (slotPolicy.fulfillmentMode !== "WALKING_LOCAL_DELIVERY") {
        add(
          "WALKING_SLOT_POLICY_MODE_INVALID",
          "Walking delivery requires a WALKING_LOCAL_DELIVERY slot policy.",
          locationId,
        );
      }

      const incompleteFields: string[] = [];
      if (!policyStatusIsReady(slotPolicy.status)) incompleteFields.push("status");
      if (slotPolicy.activeDays.length === 0) incompleteFields.push("activeDays");
      if (!Number.isInteger(slotPolicy.leadTimeMinutes) || (slotPolicy.leadTimeMinutes ?? -1) < 0) {
        incompleteFields.push("leadTimeMinutes");
      }
      if (
        !Number.isInteger(slotPolicy.cutoffMinuteOfDay) ||
        (slotPolicy.cutoffMinuteOfDay ?? -1) < 0 ||
        (slotPolicy.cutoffMinuteOfDay ?? 1_440) > 1_439
      ) {
        incompleteFields.push("cutoffMinuteOfDay");
      }
      if (!slotPolicy.capacityPolicyRef?.trim()) incompleteFields.push("capacityPolicyRef");

      if (incompleteFields.length > 0) {
        add(
          "WALKING_SLOT_POLICY_INCOMPLETE",
          "The slot policy is incomplete.",
          locationId,
          incompleteFields,
        );
      }
    }
  }

  return blockers;
}

const WEEKDAY_NUMBER: Readonly<Record<string, number>> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

function cutoffLocalTime(minuteOfDay: number | null) {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay == null || minuteOfDay < 0 || minuteOfDay > 1_439) {
    return null;
  }

  const hours = Math.floor(minuteOfDay / 60).toString().padStart(2, "0");
  const minutes = (minuteOfDay % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function getStoreOnlinePolicyBlockers(
  policy: StoreOnlinePolicyReadinessInput,
): FulfillmentDashboardBlocker[] {
  const blockers: FulfillmentDashboardBlocker[] = [];
  const add = (code: FulfillmentDashboardBlockerCode, message: string, locationId: string | null = null) =>
    blockers.push(blocker("STORE_ONLINE_POLICY", code, message, policy.id, locationId));

  const domainBlockers = validateStoreOnlineFulfillmentPolicy({
    sourceLocationId: policy.sourceLocation.id,
    consolidationLocationId: policy.consolidationLocation.id,
    onlineSalesEnabled: policy.onlineSalesEnabled,
    availableOnlyAfterStoreActivation: policy.availableOnlyAfterStoreActivation,
    addedBusinessDays: policy.addedBusinessDays,
    businessCalendarCode: policy.businessCalendarRef,
    cutoffLocalTime: cutoffLocalTime(policy.retrievalCutoffMinuteOfDay),
    pickupWeekdays: policy.pickupWeekdays.map((day) => WEEKDAY_NUMBER[day] ?? 0),
  });

  const domainMessages: Record<
    (typeof domainBlockers)[number],
    readonly [FulfillmentDashboardBlockerCode, string]
  > = {
    SOURCE_LOCATION_REQUIRED: ["STORE_ONLINE_SOURCE_REQUIRED", "A source store is required."],
    CONSOLIDATION_WAREHOUSE_REQUIRED: [
      "STORE_ONLINE_CONSOLIDATION_REQUIRED",
      "A consolidation warehouse is required.",
    ],
    CONSOLIDATION_MUST_DIFFER_FROM_SOURCE: [
      "STORE_ONLINE_CONSOLIDATION_MUST_DIFFER",
      "The consolidation warehouse must differ from the source store.",
    ],
    ACTIVATION_GATE_REQUIRED: [
      "STORE_ONLINE_ACTIVATION_GATE_REQUIRED",
      "Inventory must be store-activated before it can be offered online.",
    ],
    ADDED_BUSINESS_DAYS_INVALID: [
      "STORE_ONLINE_ADDED_BUSINESS_DAYS_INVALID",
      "Added retrieval days must be a non-negative integer.",
    ],
    BUSINESS_CALENDAR_REQUIRED: [
      "STORE_ONLINE_BUSINESS_CALENDAR_REQUIRED",
      "A business calendar is required before calculating a customer promise.",
    ],
    CUTOFF_REQUIRED: [
      "STORE_ONLINE_CUTOFF_REQUIRED",
      "A valid local retrieval cutoff is required.",
    ],
    PICKUP_SCHEDULE_REQUIRED: [
      "STORE_ONLINE_PICKUP_CADENCE_REQUIRED",
      "At least one store-pickup weekday is required.",
    ],
    PICKUP_WEEKDAY_INVALID: [
      "STORE_ONLINE_PICKUP_WEEKDAY_INVALID",
      "The pickup schedule contains an invalid weekday.",
    ],
  };

  domainBlockers.forEach((domainCode) => {
    const [code, message] = domainMessages[domainCode];
    add(code, message, policy.sourceLocation.id || null);
  });

  if (policy.sourceLocation.type !== "STORE") {
    add(
      "STORE_ONLINE_SOURCE_MUST_BE_STORE",
      "Store-backed online inventory requires a store source.",
      policy.sourceLocation.id,
    );
  }
  if (policy.consolidationLocation.type !== "WAREHOUSE") {
    add(
      "STORE_ONLINE_CONSOLIDATION_MUST_BE_WAREHOUSE",
      "Store retrieval must consolidate at a warehouse.",
      policy.consolidationLocation.id,
    );
  }
  if (!policy.sourceLocation.active) {
    add("STORE_ONLINE_SOURCE_INACTIVE", "The source store is inactive.", policy.sourceLocation.id);
  }
  if (!policy.consolidationLocation.active) {
    add(
      "STORE_ONLINE_CONSOLIDATION_INACTIVE",
      "The consolidation warehouse is inactive.",
      policy.consolidationLocation.id,
    );
  }
  if (!policy.sourceLocation.publicId?.trim()) {
    add(
      "STORE_ONLINE_SOURCE_PUBLIC_ID_REQUIRED",
      "The source store needs a stable public integration ID.",
      policy.sourceLocation.id,
    );
  }
  if (!policy.consolidationLocation.publicId?.trim()) {
    add(
      "STORE_ONLINE_CONSOLIDATION_PUBLIC_ID_REQUIRED",
      "The consolidation warehouse needs a stable public integration ID.",
      policy.consolidationLocation.id,
    );
  }
  if (!policy.timeZone.trim()) {
    add("STORE_ONLINE_TIME_ZONE_REQUIRED", "A policy time zone is required.");
  }
  if (policy.fulfillmentMode !== "STORE_RETRIEVAL_SHIPPING") {
    add("STORE_ONLINE_MODE_INVALID", "The policy must use STORE_RETRIEVAL_SHIPPING.");
  }
  if (policy.status === "DRAFT_INCOMPLETE") {
    add("STORE_ONLINE_POLICY_INCOMPLETE", "The store-online policy is marked incomplete.");
  } else if (policy.status !== "PUBLISHED") {
    add("STORE_ONLINE_POLICY_NOT_PUBLISHED", "The store-online policy is not published.");
  }
  if (!policy.onlineSalesEnabled) {
    add("STORE_ONLINE_SALES_DISABLED", "Online sales are disabled for this store policy.");
  }

  return blockers;
}
