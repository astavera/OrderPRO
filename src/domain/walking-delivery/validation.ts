import { validateWalkingGeometry } from "./geometry";
import type {
  WalkingServiceDay,
  WalkingZoneConfiguration,
  WalkingZoneValidationIssue,
  WalkingZoneValidationResult,
} from "./types";

const SERVICE_DAYS = new Set<WalkingServiceDay>([
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
]);

const TIMESTAMP_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidInstant(value: string) {
  return TIMESTAMP_WITH_TIMEZONE.test(value) && Number.isFinite(Date.parse(value));
}

function addIssue(issues: WalkingZoneValidationIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message });
}

function validateOptionalLimit(
  value: number | null | undefined,
  path: string,
  issues: WalkingZoneValidationIssue[],
) {
  if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
    addIssue(issues, "INVALID_LIMIT", path, "The limit must be a finite non-negative number.");
  }
}

export function validateWalkingZoneConfiguration(zone: WalkingZoneConfiguration): WalkingZoneValidationResult {
  const issues: WalkingZoneValidationIssue[] = [];

  if (typeof zone.id !== "string" || zone.id.trim().length === 0) {
    addIssue(issues, "ZONE_ID_REQUIRED", "$.id", "A stable zone identifier is required.");
  }

  if (!Array.isArray(zone.postalCodes) || zone.postalCodes.length === 0) {
    addIssue(issues, "POSTAL_CODE_REQUIRED", "$.postalCodes", "At least one postal code is required.");
  } else {
    const normalizedPostalCodes = new Set<string>();
    zone.postalCodes.forEach((postalCode, index) => {
      const normalized = typeof postalCode === "string" ? postalCode.trim() : "";
      if (!/^\d{5}$/.test(normalized)) {
        addIssue(issues, "INVALID_POSTAL_CODE", `$.postalCodes[${index}]`, "Postal codes must contain five digits.");
      } else if (normalizedPostalCodes.has(normalized)) {
        addIssue(issues, "DUPLICATE_POSTAL_CODE", `$.postalCodes[${index}]`, "Postal codes must be unique within a zone.");
      }
      normalizedPostalCodes.add(normalized);
    });
  }

  if (!Number.isInteger(zone.priority)) {
    addIssue(issues, "INVALID_PRIORITY", "$.priority", "Priority must be an integer.");
  }

  if (zone.serviceMode !== "WALKING") {
    addIssue(issues, "INVALID_SERVICE_MODE", "$.serviceMode", "Walking zones must use WALKING service mode.");
  }

  const geometryResult = validateWalkingGeometry(zone.geometry);
  geometryResult.issues.forEach((issue) =>
    addIssue(issues, issue.code, `$.geometry${issue.path.slice(1)}`, issue.message),
  );

  if (!Array.isArray(zone.locationIds) || zone.locationIds.length === 0) {
    addIssue(issues, "LOCATION_REQUIRED", "$.locationIds", "At least one candidate location is required.");
  }

  const locationIds = new Set<string>();
  zone.locationIds.forEach((locationId, index) => {
    if (typeof locationId !== "string" || locationId.trim().length === 0) {
      addIssue(issues, "INVALID_LOCATION_ID", `$.locationIds[${index}]`, "Location identifiers cannot be empty.");
      return;
    }

    if (locationIds.has(locationId)) {
      addIssue(issues, "DUPLICATE_LOCATION_ID", `$.locationIds[${index}]`, "Candidate locations must be unique.");
    }
    locationIds.add(locationId);
  });

  if (zone.assignmentStrategy === "FIXED" && zone.locationIds.length !== 1) {
    addIssue(issues, "FIXED_REQUIRES_ONE_LOCATION", "$.locationIds", "FIXED requires exactly one candidate location.");
  } else if (zone.assignmentStrategy === "NEAREST_WALKING_ROUTE" && zone.locationIds.length < 2) {
    addIssue(issues, "NEAREST_REQUIRES_MULTIPLE_LOCATIONS", "$.locationIds", "NEAREST_WALKING_ROUTE requires at least two locations.");
  } else if (zone.assignmentStrategy !== "FIXED" && zone.assignmentStrategy !== "NEAREST_WALKING_ROUTE") {
    addIssue(issues, "INVALID_ASSIGNMENT_STRATEGY", "$.assignmentStrategy", "The assignment strategy is not supported.");
  }

  zone.locationIds.forEach((locationId) => {
    if (!zone.feePolicyByLocation?.[locationId]?.trim()) {
      addIssue(issues, "FEE_POLICY_REQUIRED", `$.feePolicyByLocation.${locationId}`, "Each candidate location requires a fee policy.");
    }
    if (!zone.slotPolicyByLocation?.[locationId]?.trim()) {
      addIssue(issues, "SLOT_POLICY_REQUIRED", `$.slotPolicyByLocation.${locationId}`, "Each candidate location requires a slot policy.");
    }
  });

  if (!Array.isArray(zone.activeDays) || zone.activeDays.length === 0) {
    addIssue(issues, "ACTIVE_DAY_REQUIRED", "$.activeDays", "At least one active service day is required.");
  } else {
    const activeDays = new Set<WalkingServiceDay>();
    zone.activeDays.forEach((day, index) => {
      if (!SERVICE_DAYS.has(day)) {
        addIssue(issues, "INVALID_ACTIVE_DAY", `$.activeDays[${index}]`, "The service day is not supported.");
      } else if (activeDays.has(day)) {
        addIssue(issues, "DUPLICATE_ACTIVE_DAY", `$.activeDays[${index}]`, "Active service days must be unique.");
      }
      activeDays.add(day);
    });
  }

  validateOptionalLimit(zone.maxDistanceMiles, "$.maxDistanceMiles", issues);
  validateOptionalLimit(zone.maxRouteMinutes, "$.maxRouteMinutes", issues);

  if (
    zone.minimumOrderCents !== undefined &&
    zone.minimumOrderCents !== null &&
    (!Number.isInteger(zone.minimumOrderCents) || zone.minimumOrderCents < 0)
  ) {
    addIssue(issues, "INVALID_MINIMUM_ORDER", "$.minimumOrderCents", "Minimum order must be non-negative integer cents.");
  }

  if (zone.effectiveFrom && !isValidInstant(zone.effectiveFrom)) {
    addIssue(issues, "INVALID_EFFECTIVE_FROM", "$.effectiveFrom", "effectiveFrom must be a valid timestamp.");
  }
  if (zone.effectiveTo && !isValidInstant(zone.effectiveTo)) {
    addIssue(issues, "INVALID_EFFECTIVE_TO", "$.effectiveTo", "effectiveTo must be a valid timestamp.");
  }
  if (
    zone.effectiveFrom &&
    zone.effectiveTo &&
    isValidInstant(zone.effectiveFrom) &&
    isValidInstant(zone.effectiveTo) &&
    Date.parse(zone.effectiveFrom) >= Date.parse(zone.effectiveTo)
  ) {
    addIssue(issues, "INVALID_EFFECTIVE_RANGE", "$.effectiveTo", "effectiveTo must be later than effectiveFrom.");
  }

  if (!["DRAFT", "VALIDATED", "PUBLISHED", "ARCHIVED"].includes(zone.status)) {
    addIssue(issues, "INVALID_ZONE_STATUS", "$.status", "The zone status is not supported.");
  }

  return { valid: issues.length === 0, issues };
}

export function validateWalkingZoneConfigurations(
  zones: readonly WalkingZoneConfiguration[],
): WalkingZoneValidationResult {
  const issues: WalkingZoneValidationIssue[] = [];
  const zoneIds = new Set<string>();

  zones.forEach((zone, index) => {
    validateWalkingZoneConfiguration(zone).issues.forEach((issue) =>
      addIssue(issues, issue.code, `$[${index}]${issue.path.slice(1)}`, issue.message),
    );

    if (zoneIds.has(zone.id)) {
      addIssue(issues, "DUPLICATE_ZONE_ID", `$[${index}].id`, "Zone identifiers must be unique in a snapshot.");
    }
    zoneIds.add(zone.id);
  });

  return { valid: issues.length === 0, issues };
}
