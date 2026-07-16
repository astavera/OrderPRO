import { describe, expect, it } from "vitest";
import { hasBoxLocationAccess, visibleBoxWhere } from "./box-visibility";

describe("box location visibility", () => {
  const box = { ownerLocationId: "store-72", currentLocationId: "warehouse-01" };

  it("allows the commercial owner location", () => {
    expect(hasBoxLocationAccess(["store-72"], box)).toBe(true);
  });

  it("allows the current physical location", () => {
    expect(hasBoxLocationAccess(["warehouse-01"], box)).toBe(true);
  });

  it("does not reveal boxes outside every assigned location", () => {
    expect(hasBoxLocationAccess(["store-86"], box)).toBe(false);
  });

  it("builds the same owner-or-physical database scope", () => {
    expect(visibleBoxWhere(["store-72", "warehouse-01"])).toEqual({
      type: "BOX",
      OR: [
        { ownerLocationId: { in: ["store-72", "warehouse-01"] } },
        { currentLocationId: { in: ["store-72", "warehouse-01"] } },
      ],
    });
  });
});
