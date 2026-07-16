import { describe, expect, it } from "vitest";
import { checkDatabaseReadiness } from "./check-database-readiness";

const instant = () => new Date("2026-07-15T22:45:00.000Z");

describe("database readiness", () => {
  it("reports ready after a successful probe", async () => {
    const result = await checkDatabaseReadiness({ execute: async () => undefined }, instant);
    expect(result).toEqual({ ready: true, checkedAt: "2026-07-15T22:45:00.000Z" });
  });

  it("uses a stable public error without leaking provider details", async () => {
    const result = await checkDatabaseReadiness({ execute: async () => { throw new Error("secret connection detail"); } }, instant);
    expect(result).toEqual({ ready: false, checkedAt: "2026-07-15T22:45:00.000Z", code: "DATABASE_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("secret connection detail");
  });
});
