import { describe, expect, it, vi } from "vitest";
import { createMachineAuthCheckPostHandler } from "./machine-auth-check";

function request() {
  return new Request("https://orderpro.test/api/v1/local-delivery/auth-check", {
    method: "POST",
    headers: { "X-Correlation-ID": "storefront-check-001" },
  });
}

describe("M2M auth check", () => {
  it("reports an exact active storefront principal without opening delivery", async () => {
    const handler = createMachineAuthCheckPostHandler({
      authenticate: vi.fn(async () => ({
        authenticated: true,
        principal: {
          clientId: "storefront-staging",
          environment: "STAGING",
          scopes: ["local-delivery:holds", "local-delivery:quote"],
        },
      } as const)),
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      result: "AUTHENTICATED",
      clientId: "storefront-staging",
      environment: "STAGING",
      scopes: ["local-delivery:holds", "local-delivery:quote"],
      localDeliveryApiStatus: "DEPENDENCY_BLOCKED",
      correlationId: "storefront-check-001",
    });
  });

  it("fails closed when runtime authentication is disabled", async () => {
    const handler = createMachineAuthCheckPostHandler({
      authenticate: vi.fn(async () => ({
        authenticated: false,
        code: "M2M_AUTH_NOT_CONFIGURED",
      } as const)),
    });
    const response = await handler(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      result: "FAILED_CLOSED",
      code: "M2M_AUTH_NOT_CONFIGURED",
    });
  });

  it("does not certify a token missing either required scope", async () => {
    const handler = createMachineAuthCheckPostHandler({
      authenticate: vi.fn(async () => ({
        authenticated: true,
        principal: {
          clientId: "storefront-staging",
          environment: "STAGING",
          scopes: ["local-delivery:quote"],
        },
      } as const)),
    });
    const response = await handler(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      result: "FORBIDDEN",
      code: "INSUFFICIENT_SCOPE",
    });
  });
});
