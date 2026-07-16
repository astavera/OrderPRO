import type { RoleCode } from "@prisma/client";
import { hasPermission } from "../auth/permissions";

export type UserAccessDraft = {
  active: boolean;
  roles: readonly RoleCode[];
  locationIds: readonly string[];
};

export type UserAccessPolicyFailure =
  | "ROLE_REQUIRED"
  | "LOCATION_REQUIRED"
  | "SELF_LOCKOUT"
  | "LAST_OWNER_REQUIRED"
  | "OWNER_MANAGEMENT_FORBIDDEN"
  | "ROLE_LOCATION_MISMATCH";

export function uniqueValues<T extends string>(values: readonly T[]) {
  return [...new Set(values)];
}

export function validateUserAccessDraft(input: UserAccessDraft): UserAccessPolicyFailure | null {
  if (input.roles.length === 0) return "ROLE_REQUIRED";
  if (input.locationIds.length === 0) return "LOCATION_REQUIRED";
  return null;
}

export function validateAdministrativeSafety(input: {
  actorUserId: string;
  actorRoles: readonly RoleCode[];
  targetUserId: string;
  targetCurrentlyOwner: boolean;
  nextAccess: UserAccessDraft;
  otherActiveOwnerCount: number;
}): UserAccessPolicyFailure | null {
  const nextIsAdmin = input.nextAccess.active && hasPermission([...input.nextAccess.roles], "admin.manage");
  const nextIsOwner = input.nextAccess.active && input.nextAccess.roles.includes("OWNER");
  const actorIsOwner = input.actorRoles.includes("OWNER");

  if (input.actorUserId === input.targetUserId && !nextIsAdmin) return "SELF_LOCKOUT";
  if (!actorIsOwner && (input.targetCurrentlyOwner || input.nextAccess.roles.includes("OWNER"))) {
    return "OWNER_MANAGEMENT_FORBIDDEN";
  }
  if (input.targetCurrentlyOwner && !nextIsOwner && input.otherActiveOwnerCount === 0) return "LAST_OWNER_REQUIRED";
  return null;
}

export function validateRoleLocationCompatibility(
  roles: readonly RoleCode[],
  locations: readonly { type: "STORE" | "WAREHOUSE" }[],
): UserAccessPolicyFailure | null {
  const unrestricted = roles.some((role) => ["OWNER", "OPERATIONS_ADMIN", "INVENTORY_CONTROLLER", "AUDITOR"].includes(role));
  if (unrestricted) return null;

  const allowsStore = roles.some((role) => role === "STORE_MANAGER" || role === "STORE_STAFF");
  const allowsWarehouse = roles.some((role) => role === "WAREHOUSE_MANAGER" || role === "WAREHOUSE_STAFF");
  const mismatch = locations.some(
    ({ type }) => (type === "STORE" && !allowsStore) || (type === "WAREHOUSE" && !allowsWarehouse),
  );
  return mismatch ? "ROLE_LOCATION_MISMATCH" : null;
}
