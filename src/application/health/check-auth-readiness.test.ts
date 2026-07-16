import { describe, expect, it } from "vitest";
import { checkAuthReadiness } from "./check-auth-readiness";

const instant = () => new Date("2026-07-16T15:00:00.000Z");

describe("auth readiness", () => {
  it("reports ready after a successful provider probe", async () => {
    await expect(checkAuthReadiness({ execute: async () => undefined }, instant)).resolves.toEqual({
      ready: true,
      checkedAt: "2026-07-16T15:00:00.000Z",
    });
  });

  it("uses a stable public error without leaking provider details", async () => {
    const readiness = await checkAuthReadiness(
      { execute: async () => { throw new Error("Invalid API key from private provider response"); } },
      instant,
    );

    expect(readiness).toEqual({
      ready: false,
      checkedAt: "2026-07-16T15:00:00.000Z",
      code: "AUTH_UNAVAILABLE",
    });
    expect(JSON.stringify(readiness)).not.toContain("API key");
  });
});
