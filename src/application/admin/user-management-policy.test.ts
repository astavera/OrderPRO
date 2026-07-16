import { describe, expect, it } from "vitest";
import {
  uniqueValues,
  validateAdministrativeSafety,
  validateRoleLocationCompatibility,
  validateUserAccessDraft,
} from "./user-management-policy";

describe("user management policy", () => {
  const adminAccess = { active: true, roles: ["OWNER"] as const, locationIds: ["location"] };

  it("requires at least one role and location", () => {
    expect(validateUserAccessDraft({ ...adminAccess, roles: [] })).toBe("ROLE_REQUIRED");
    expect(validateUserAccessDraft({ ...adminAccess, locationIds: [] })).toBe("LOCATION_REQUIRED");
    expect(validateUserAccessDraft(adminAccess)).toBeNull();
  });

  it("blocks administrators from removing their own administrative access", () => {
    expect(
      validateAdministrativeSafety({
        actorUserId: "self",
        actorRoles: ["OWNER"],
        targetUserId: "self",
        targetCurrentlyOwner: true,
        nextAccess: { active: true, roles: ["AUDITOR"], locationIds: ["location"] },
        otherActiveOwnerCount: 2,
      }),
    ).toBe("SELF_LOCKOUT");
  });

  it("preserves the final active owner", () => {
    expect(
      validateAdministrativeSafety({
        actorUserId: "actor",
        actorRoles: ["OWNER"],
        targetUserId: "target",
        targetCurrentlyOwner: true,
        nextAccess: { active: false, roles: ["OWNER"], locationIds: ["location"] },
        otherActiveOwnerCount: 0,
      }),
    ).toBe("LAST_OWNER_REQUIRED");
  });

  it("allows an owner change when another owner remains", () => {
    expect(
      validateAdministrativeSafety({
        actorUserId: "actor",
        actorRoles: ["OWNER"],
        targetUserId: "target",
        targetCurrentlyOwner: true,
        nextAccess: { active: true, roles: ["AUDITOR"], locationIds: ["location"] },
        otherActiveOwnerCount: 1,
      }),
    ).toBeNull();
  });

  it("prevents operations admins from granting or modifying owner access", () => {
    expect(
      validateAdministrativeSafety({
        actorUserId: "actor",
        actorRoles: ["OPERATIONS_ADMIN"],
        targetUserId: "target",
        targetCurrentlyOwner: false,
        nextAccess: adminAccess,
        otherActiveOwnerCount: 1,
      }),
    ).toBe("OWNER_MANAGEMENT_FORBIDDEN");
  });

  it("keeps store and warehouse roles within compatible locations", () => {
    expect(validateRoleLocationCompatibility(["STORE_STAFF"], [{ type: "STORE" }])).toBeNull();
    expect(validateRoleLocationCompatibility(["STORE_STAFF"], [{ type: "WAREHOUSE" }])).toBe(
      "ROLE_LOCATION_MISMATCH",
    );
    expect(
      validateRoleLocationCompatibility(["STORE_MANAGER", "WAREHOUSE_STAFF"], [{ type: "STORE" }, { type: "WAREHOUSE" }]),
    ).toBeNull();
    expect(validateRoleLocationCompatibility(["OWNER"], [{ type: "STORE" }, { type: "WAREHOUSE" }])).toBeNull();
  });

  it("deduplicates repeated form values", () => {
    expect(uniqueValues(["OWNER", "OWNER", "AUDITOR"])).toEqual(["OWNER", "AUDITOR"]);
  });
});
