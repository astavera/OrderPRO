import type { RoleCode } from "@prisma/client";

export const roleCodes = [
  "OWNER",
  "OPERATIONS_ADMIN",
  "INVENTORY_CONTROLLER",
  "STORE_MANAGER",
  "STORE_STAFF",
  "WAREHOUSE_MANAGER",
  "WAREHOUSE_STAFF",
  "AUDITOR",
] as const satisfies readonly RoleCode[];

export const permissionCodes = [
  "dashboard.view",
  "boxes.view",
  "boxes.mutate",
  "inventory.view",
  "fulfillment.view",
  "fulfillment.manage",
  "fulfillment.publish",
  "fulfillment.rollback",
  "admin.manage",
  "m2m.approve",
] as const;

export type Permission = (typeof permissionCodes)[number];

export const permissionsByRole: Record<RoleCode, readonly Permission[]> = {
  OWNER: [
    "dashboard.view",
    "boxes.view",
    "boxes.mutate",
    "inventory.view",
    "fulfillment.view",
    "fulfillment.manage",
    "fulfillment.publish",
    "fulfillment.rollback",
    "admin.manage",
    "m2m.approve",
  ],
  OPERATIONS_ADMIN: [
    "dashboard.view",
    "boxes.view",
    "boxes.mutate",
    "inventory.view",
    "fulfillment.view",
    "fulfillment.manage",
    "admin.manage",
  ],
  INVENTORY_CONTROLLER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view", "fulfillment.view"],
  STORE_MANAGER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view", "fulfillment.view"],
  STORE_STAFF: ["dashboard.view", "boxes.view", "boxes.mutate"],
  WAREHOUSE_MANAGER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view", "fulfillment.view"],
  WAREHOUSE_STAFF: ["dashboard.view", "boxes.view", "boxes.mutate"],
  AUDITOR: ["dashboard.view", "boxes.view", "inventory.view", "fulfillment.view"],
};

export const roleLabels: Record<RoleCode, string> = {
  OWNER: "Owner",
  OPERATIONS_ADMIN: "Operations admin",
  INVENTORY_CONTROLLER: "Inventory controller",
  STORE_MANAGER: "Store manager",
  STORE_STAFF: "Store staff",
  WAREHOUSE_MANAGER: "Warehouse manager",
  WAREHOUSE_STAFF: "Warehouse staff",
  AUDITOR: "Auditor",
};

export const permissionLabels: Record<Permission, string> = {
  "dashboard.view": "View dashboard",
  "boxes.view": "View boxes",
  "boxes.mutate": "Modify boxes",
  "inventory.view": "View inventory",
  "fulfillment.view": "View fulfillment",
  "fulfillment.manage": "Manage fulfillment",
  "fulfillment.publish": "Publish fulfillment",
  "fulfillment.rollback": "Rollback fulfillment",
  "admin.manage": "Manage users",
  "m2m.approve": "Approve STAGING machine access",
};

export function hasPermission(roles: RoleCode[], permission: Permission) {
  return roles.some((role) => permissionsByRole[role].includes(permission));
}
