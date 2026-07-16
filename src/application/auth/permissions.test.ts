import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

describe("RBAC permissions", () => {
  it("allows owners to administer", () => expect(hasPermission(["OWNER"], "admin.manage")).toBe(true));
  it("prevents store staff from administering", () => expect(hasPermission(["STORE_STAFF"], "admin.manage")).toBe(false));
  it("keeps auditors read-only", () => expect(hasPermission(["AUDITOR"], "boxes.mutate")).toBe(false));
});
