export type StoreOnlineFulfillmentPolicyDraft = {
  sourceLocationId: string;
  consolidationLocationId: string;
  onlineSalesEnabled: boolean;
  availableOnlyAfterStoreActivation: boolean;
  addedBusinessDays: number;
  businessCalendarCode: string | null;
  cutoffLocalTime: string | null;
  pickupWeekdays: readonly number[];
};

export type StoreOnlinePolicyBlocker =
  | "SOURCE_LOCATION_REQUIRED"
  | "CONSOLIDATION_WAREHOUSE_REQUIRED"
  | "CONSOLIDATION_MUST_DIFFER_FROM_SOURCE"
  | "ACTIVATION_GATE_REQUIRED"
  | "ADDED_BUSINESS_DAYS_INVALID"
  | "BUSINESS_CALENDAR_REQUIRED"
  | "CUTOFF_REQUIRED"
  | "PICKUP_SCHEDULE_REQUIRED"
  | "PICKUP_WEEKDAY_INVALID";

const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateStoreOnlineFulfillmentPolicy(
  policy: StoreOnlineFulfillmentPolicyDraft,
): StoreOnlinePolicyBlocker[] {
  const blockers: StoreOnlinePolicyBlocker[] = [];
  if (!policy.sourceLocationId.trim()) blockers.push("SOURCE_LOCATION_REQUIRED");
  if (!policy.consolidationLocationId.trim()) blockers.push("CONSOLIDATION_WAREHOUSE_REQUIRED");
  if (
    policy.sourceLocationId.trim() &&
    policy.consolidationLocationId.trim() &&
    policy.sourceLocationId === policy.consolidationLocationId
  ) {
    blockers.push("CONSOLIDATION_MUST_DIFFER_FROM_SOURCE");
  }
  if (!policy.availableOnlyAfterStoreActivation) blockers.push("ACTIVATION_GATE_REQUIRED");
  if (!Number.isInteger(policy.addedBusinessDays) || policy.addedBusinessDays < 0) {
    blockers.push("ADDED_BUSINESS_DAYS_INVALID");
  }
  if (!policy.businessCalendarCode?.trim()) blockers.push("BUSINESS_CALENDAR_REQUIRED");
  if (!policy.cutoffLocalTime || !localTimePattern.test(policy.cutoffLocalTime)) blockers.push("CUTOFF_REQUIRED");
  if (policy.pickupWeekdays.length === 0) blockers.push("PICKUP_SCHEDULE_REQUIRED");
  if (policy.pickupWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    blockers.push("PICKUP_WEEKDAY_INVALID");
  }
  return blockers;
}

export function canActivateStoreOnlineFulfillment(policy: StoreOnlineFulfillmentPolicyDraft) {
  return policy.onlineSalesEnabled && validateStoreOnlineFulfillmentPolicy(policy).length === 0;
}
