import type { RoleCode } from "@prisma/client";

export type Permission = "dashboard.view" | "boxes.view" | "boxes.mutate" | "inventory.view" | "admin.manage";

const permissionsByRole: Record<RoleCode, readonly Permission[]> = {
  OWNER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view", "admin.manage"],
  OPERATIONS_ADMIN: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view", "admin.manage"],
  INVENTORY_CONTROLLER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view"],
  STORE_MANAGER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view"],
  STORE_STAFF: ["dashboard.view", "boxes.view", "boxes.mutate"],
  WAREHOUSE_MANAGER: ["dashboard.view", "boxes.view", "boxes.mutate", "inventory.view"],
  WAREHOUSE_STAFF: ["dashboard.view", "boxes.view", "boxes.mutate"],
  AUDITOR: ["dashboard.view", "boxes.view", "inventory.view"],
};

export function hasPermission(roles: RoleCode[], permission: Permission) {
  return roles.some((role) => permissionsByRole[role].includes(permission));
}
