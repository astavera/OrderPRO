import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /v1/walking-delivery/quotes safety lock", () => {
  it("does not evaluate or accept a human session before M2M auth is configured", async () => {
    const response = await POST(new Request("http://orderpro.test/v1/walking-delivery/quotes", {
      method: "POST",
      headers: {
        Cookie: "human-session=must-not-be-used",
        "Content-Type": "application/json",
        "X-Correlation-ID": "quote-correlation-1",
      },
      body: JSON.stringify({ address: "310 E 75th St" }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toBe("quote-correlation-1");
    await expect(response.json()).resolves.toEqual({
      code: "M2M_AUTH_NOT_CONFIGURED",
      message: "Walking quote evaluation is locked until machine authentication is configured.",
      correlationId: "quote-correlation-1",
    });
  });
});
