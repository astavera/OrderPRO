import { describe, expect, it } from "vitest";
import { hasPermission, type Permission } from "./permissions";

describe("RBAC permissions", () => {
  it("allows owners to administer", () => expect(hasPermission(["OWNER"], "admin.manage")).toBe(true));
  it("prevents store staff from administering", () => expect(hasPermission(["STORE_STAFF"], "admin.manage")).toBe(false));
  it("keeps auditors read-only", () => expect(hasPermission(["AUDITOR"], "boxes.mutate")).toBe(false));

  it("reserves STAGING machine approval for Owners", () => {
    expect(hasPermission(["OWNER"], "m2m.approve")).toBe(true);
    expect(hasPermission(["OPERATIONS_ADMIN"], "m2m.approve")).toBe(false);
    expect(hasPermission(["AUDITOR"], "m2m.approve")).toBe(false);
  });

  it("reserves STAGING machine activation for Owners", () => {
    expect(hasPermission(["OWNER"], "m2m.activate")).toBe(true);
    expect(hasPermission(["OPERATIONS_ADMIN"], "m2m.activate")).toBe(false);
    expect(hasPermission(["AUDITOR"], "m2m.activate")).toBe(false);
  });

  it("allows owners to manage the complete fulfillment lifecycle", () => {
    const permissions: Permission[] = [
      "fulfillment.view",
      "fulfillment.manage",
      "fulfillment.publish",
      "fulfillment.rollback",
    ];

    expect(permissions.every((permission) => hasPermission(["OWNER"], permission))).toBe(true);
  });

  it("allows operations admins to view and manage fulfillment without publishing or rollback", () => {
    expect(hasPermission(["OPERATIONS_ADMIN"], "fulfillment.view")).toBe(true);
    expect(hasPermission(["OPERATIONS_ADMIN"], "fulfillment.manage")).toBe(true);
    expect(hasPermission(["OPERATIONS_ADMIN"], "fulfillment.publish")).toBe(false);
    expect(hasPermission(["OPERATIONS_ADMIN"], "fulfillment.rollback")).toBe(false);
  });

  it.each(["INVENTORY_CONTROLLER", "STORE_MANAGER", "WAREHOUSE_MANAGER", "AUDITOR"] as const)(
    "grants %s read-only fulfillment access",
    (role) => {
      expect(hasPermission([role], "fulfillment.view")).toBe(true);
      expect(hasPermission([role], "fulfillment.manage")).toBe(false);
      expect(hasPermission([role], "fulfillment.publish")).toBe(false);
      expect(hasPermission([role], "fulfillment.rollback")).toBe(false);
    },
  );

  it.each(["STORE_STAFF", "WAREHOUSE_STAFF"] as const)("does not expose fulfillment to %s", (role) => {
    expect(hasPermission([role], "fulfillment.view")).toBe(false);
    expect(hasPermission([role], "fulfillment.manage")).toBe(false);
    expect(hasPermission([role], "fulfillment.publish")).toBe(false);
    expect(hasPermission([role], "fulfillment.rollback")).toBe(false);
  });
});
