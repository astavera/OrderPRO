import type { WalkingAssignmentStrategy, WalkingWeekday } from "@prisma/client";
import { validateWalkingGeometry } from "../../domain/walking-delivery";

export type WalkingZoneDraftInput = {
  name: string;
  postalCodes: readonly string[];
  priority: number | null;
  assignmentStrategy: WalkingAssignmentStrategy;
  candidateLocationIds: readonly string[];
  geometry: unknown | null;
  activeDays: readonly WalkingWeekday[];
  maxDistanceMiles: number | null;
  maxRouteMinutes: number | null;
  minimumOrderCents: number | null;
};

export type WalkingZoneDraftFailure =
  | "NAME_REQUIRED"
  | "POSTAL_CODE_REQUIRED"
  | "POSTAL_CODE_INVALID"
  | "PRIORITY_INVALID"
  | "CANDIDATE_REQUIRED"
  | "CANDIDATE_DUPLICATE"
  | "FIXED_CANDIDATE_COUNT_INVALID"
  | "NEAREST_CANDIDATE_COUNT_INVALID"
  | "GEOMETRY_INVALID"
  | "ACTIVE_DAY_DUPLICATE"
  | "LIMIT_INVALID";

export function validateWalkingZoneDraft(input: WalkingZoneDraftInput): WalkingZoneDraftFailure[] {
  const failures: WalkingZoneDraftFailure[] = [];
  if (input.name.trim().length < 2 || input.name.trim().length > 120) failures.push("NAME_REQUIRED");

  const postalCodes = input.postalCodes.map((code) => code.trim());
  if (postalCodes.length === 0) failures.push("POSTAL_CODE_REQUIRED");
  if (postalCodes.some((code) => !/^\d{5}$/.test(code)) || new Set(postalCodes).size !== postalCodes.length) {
    failures.push("POSTAL_CODE_INVALID");
  }

  if (input.priority !== null && !Number.isInteger(input.priority)) failures.push("PRIORITY_INVALID");
  if (input.candidateLocationIds.length === 0) failures.push("CANDIDATE_REQUIRED");
  if (new Set(input.candidateLocationIds).size !== input.candidateLocationIds.length) {
    failures.push("CANDIDATE_DUPLICATE");
  }
  if (input.assignmentStrategy === "FIXED" && input.candidateLocationIds.length !== 1) {
    failures.push("FIXED_CANDIDATE_COUNT_INVALID");
  }
  if (input.assignmentStrategy === "NEAREST_WALKING_ROUTE" && input.candidateLocationIds.length < 2) {
    failures.push("NEAREST_CANDIDATE_COUNT_INVALID");
  }

  if (input.geometry !== null && !validateWalkingGeometry(input.geometry).valid) failures.push("GEOMETRY_INVALID");
  if (new Set(input.activeDays).size !== input.activeDays.length) failures.push("ACTIVE_DAY_DUPLICATE");

  const invalidLimit = [input.maxDistanceMiles, input.maxRouteMinutes, input.minimumOrderCents].some(
    (value) => value !== null && (!Number.isFinite(value) || value < 0),
  );
  if (
    invalidLimit ||
    (input.maxRouteMinutes !== null && !Number.isInteger(input.maxRouteMinutes)) ||
    (input.minimumOrderCents !== null && !Number.isInteger(input.minimumOrderCents))
  ) {
    failures.push("LIMIT_INVALID");
  }

  return [...new Set(failures)];
}
