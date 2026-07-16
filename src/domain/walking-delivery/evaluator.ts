import { isValidWalkingPosition, pointInWalkingGeometry } from "./geometry";
import type {
  IneligibleWalkingDeliveryResult,
  WalkingCandidateResult,
  WalkingDeliveryEvaluationInput,
  WalkingDeliveryEvaluationResult,
  WalkingReasonCode,
  WalkingRouteMetric,
  WalkingServiceDay,
  WalkingZoneConfiguration,
} from "./types";
import { validateWalkingZoneConfigurations } from "./validation";

const SERVICE_DAYS: readonly WalkingServiceDay[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const SERVICE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function failure(
  reasonCode: Exclude<WalkingReasonCode, "ELIGIBLE">,
  details: Omit<IneligibleWalkingDeliveryResult, "eligible" | "reasonCode"> = {},
): IneligibleWalkingDeliveryResult {
  return { eligible: false, reasonCode, ...details };
}

function parseServiceDay(serviceAt: string): WalkingServiceDay | null {
  const match = SERVICE_TIMESTAMP.exec(serviceAt);
  if (!match || !Number.isFinite(Date.parse(serviceAt))) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));

  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }

  return SERVICE_DAYS[calendarDate.getUTCDay()];
}

function compareStableText(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function isEffectiveAt(zone: WalkingZoneConfiguration, serviceTimestamp: number) {
  if (zone.status === "ARCHIVED") {
    return false;
  }

  if (zone.effectiveFrom && serviceTimestamp < Date.parse(zone.effectiveFrom)) {
    return false;
  }

  return !(zone.effectiveTo && serviceTimestamp >= Date.parse(zone.effectiveTo));
}

function metricsByLocation(metrics: readonly WalkingRouteMetric[] | undefined) {
  const result = new Map<string, WalkingRouteMetric>();

  for (const metric of metrics ?? []) {
    if (
      typeof metric.locationId !== "string" ||
      metric.locationId.trim().length === 0 ||
      !Number.isFinite(metric.walkingDistanceMiles) ||
      metric.walkingDistanceMiles < 0 ||
      !Number.isFinite(metric.walkingDurationMinutes) ||
      metric.walkingDurationMinutes < 0 ||
      result.has(metric.locationId)
    ) {
      return null;
    }

    result.set(metric.locationId, metric);
  }

  return result;
}

function compareRouteMetrics(left: WalkingRouteMetric, right: WalkingRouteMetric) {
  return (
    left.walkingDistanceMiles - right.walkingDistanceMiles ||
    left.walkingDurationMinutes - right.walkingDurationMinutes ||
    compareStableText(left.locationId, right.locationId)
  );
}

function candidateResult(locationId: string, metric?: WalkingRouteMetric): WalkingCandidateResult {
  return metric
    ? {
        locationId,
        walkingDistanceMiles: metric.walkingDistanceMiles,
        walkingDurationMinutes: metric.walkingDurationMinutes,
      }
    : { locationId };
}

export function evaluateWalkingDelivery(
  input: WalkingDeliveryEvaluationInput,
): WalkingDeliveryEvaluationResult {
  const zonesValue: unknown = input.zones;
  const postalCode = typeof input.postalCode === "string" ? input.postalCode.trim() : "";
  const serviceDay = typeof input.serviceAt === "string" ? parseServiceDay(input.serviceAt) : null;
  const serviceTimestamp = typeof input.serviceAt === "string" ? Date.parse(input.serviceAt) : Number.NaN;

  if (
    !isValidWalkingPosition(input.point) ||
    !/^\d{5}$/.test(postalCode) ||
    !serviceDay ||
    !Number.isInteger(input.subtotalCents) ||
    input.subtotalCents < 0 ||
    !Array.isArray(zonesValue)
  ) {
    return failure("INVALID_INPUT");
  }

  const zones = zonesValue as readonly WalkingZoneConfiguration[];

  if (!validateWalkingZoneConfigurations(zones).valid) {
    return failure("INVALID_ZONE_CONFIGURATION", { postalCode, point: input.point });
  }

  const routeMetrics = metricsByLocation(input.routeMetrics);
  if (!routeMetrics) {
    return failure("INVALID_INPUT", { postalCode, point: input.point });
  }

  const geometricMatches = zones.filter(
    (zone) => zone.postalCodes.some((candidate) => candidate.trim() === postalCode) && pointInWalkingGeometry(input.point, zone.geometry),
  );

  if (geometricMatches.length === 0) {
    return failure("OUTSIDE_WALKING_ZONE", { postalCode, point: input.point });
  }

  const effectiveMatches = geometricMatches.filter((zone) => isEffectiveAt(zone, serviceTimestamp));
  if (effectiveMatches.length === 0) {
    return failure("NO_ACTIVE_ZONE", { postalCode, point: input.point });
  }

  const serviceDayMatches = effectiveMatches.filter((zone) => zone.activeDays.includes(serviceDay));
  if (serviceDayMatches.length === 0) {
    return failure("SERVICE_DAY_UNAVAILABLE", { postalCode, point: input.point });
  }

  const zonesByPriority = [...serviceDayMatches].sort(
    (left, right) => right.priority - left.priority || compareStableText(left.id, right.id),
  );
  const selectedZone = zonesByPriority[0];

  if (zonesByPriority[1]?.priority === selectedZone.priority) {
    return failure("INVALID_ZONE_CONFIGURATION", { postalCode, point: input.point });
  }

  const commonDetails = {
    postalCode,
    point: input.point,
    matchedZoneId: selectedZone.id,
    zoneVersionId: selectedZone.versionId,
    assignmentStrategy: selectedZone.assignmentStrategy,
  };

  let selectedLocationId: string;
  let candidates: WalkingCandidateResult[];

  if (selectedZone.assignmentStrategy === "FIXED") {
    selectedLocationId = selectedZone.locationIds[0];
    candidates = [candidateResult(selectedLocationId, routeMetrics.get(selectedLocationId))];
  } else {
    const candidateMetrics: WalkingRouteMetric[] = [];
    for (const locationId of selectedZone.locationIds) {
      const metric = routeMetrics.get(locationId);
      if (!metric) {
        return failure("ROUTE_METRICS_REQUIRED", {
          ...commonDetails,
          candidates: selectedZone.locationIds.map((candidateId) => candidateResult(candidateId, routeMetrics.get(candidateId))),
        });
      }
      candidateMetrics.push(metric);
    }

    candidateMetrics.sort(compareRouteMetrics);
    selectedLocationId = candidateMetrics[0].locationId;
    candidates = candidateMetrics.map((metric) => candidateResult(metric.locationId, metric));
  }

  const selectedMetric = routeMetrics.get(selectedLocationId);
  const selectionDetails = { ...commonDetails, candidates, selectedLocationId };

  if ((selectedZone.maxDistanceMiles != null || selectedZone.maxRouteMinutes != null) && !selectedMetric) {
    return failure("ROUTE_METRICS_REQUIRED", selectionDetails);
  }

  if (selectedMetric && selectedZone.maxDistanceMiles != null && selectedMetric.walkingDistanceMiles > selectedZone.maxDistanceMiles) {
    return failure("DISTANCE_EXCEEDED", selectionDetails);
  }

  if (selectedMetric && selectedZone.maxRouteMinutes != null && selectedMetric.walkingDurationMinutes > selectedZone.maxRouteMinutes) {
    return failure("ROUTE_TIME_EXCEEDED", selectionDetails);
  }

  if (selectedZone.minimumOrderCents != null && input.subtotalCents < selectedZone.minimumOrderCents) {
    return failure("MINIMUM_ORDER_NOT_MET", selectionDetails);
  }

  if (input.locationAvailabilityById?.[selectedLocationId] === false) {
    return failure("STORE_NOT_AVAILABLE", selectionDetails);
  }

  const feePolicyId = selectedZone.feePolicyByLocation[selectedLocationId];
  if (input.feePolicyCompletenessById?.[feePolicyId] === false) {
    return failure("FEE_POLICY_INCOMPLETE", selectionDetails);
  }

  const slotPolicyId = selectedZone.slotPolicyByLocation[selectedLocationId];
  if (input.slotPolicyCompletenessById?.[slotPolicyId] === false) {
    return failure("SLOT_POLICY_INCOMPLETE", selectionDetails);
  }

  if (input.slotAvailabilityByLocationId?.[selectedLocationId] === false) {
    return failure("NO_AVAILABLE_SLOTS", selectionDetails);
  }

  return {
    eligible: true,
    reasonCode: "ELIGIBLE",
    ...commonDetails,
    candidates,
    selectedLocationId,
    feePolicyId,
    slotPolicyId,
  };
}
