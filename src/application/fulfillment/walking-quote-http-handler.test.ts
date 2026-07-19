import { describe, expect, it, vi } from "vitest";
import { createWalkingQuotePostHandler } from "./walking-quote-http-handler";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://orderpro.test/v1/walking-delivery/quotes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "quote-command-123",
      "X-Correlation-ID": "correlation-123",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  address: "310 E 75th St, New York, NY 10021",
  serviceAt: "2026-07-20T14:00:00-04:00",
  subtotalCents: 5_000,
};

describe("walking quote HTTP handler", () => {
  it("never reflects verifier failures or thrown secrets", async () => {
    const secret = "Bearer walking-token-must-never-escape";
    const evaluate = vi.fn();
    const rejected = createWalkingQuotePostHandler({
      async authenticate() {
        return { authenticated: false, code: "UNAUTHORIZED" } as const;
      },
      evaluate,
    });
    const unavailable = createWalkingQuotePostHandler({
      async authenticate() {
        throw new Error(`${secret}; jwks timeout`);
      },
      evaluate,
    });

    const rejectedResponse = await rejected(request(validBody));
    const unavailableResponse = await unavailable(request(validBody));
    expect(rejectedResponse.status).toBe(401);
    expect(unavailableResponse.status).toBe(503);
    const rejectedBody = await rejectedResponse.text();
    const unavailableBody = await unavailableResponse.text();
    expect(rejectedBody).not.toContain(secret);
    expect(unavailableBody).not.toContain(secret);
    expect(unavailableBody).not.toContain("jwks");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("requires both read scopes before parsing customer data", async () => {
    const evaluate = vi.fn();
    const handler = createWalkingQuotePostHandler({
      async authenticate() {
        return { authenticated: true, principal: { clientId: "ecommerce", environment: "STAGING", scopes: ["walking-zones:read"] } };
      },
      evaluate,
    });
    const response = await handler(request(validBody));
    expect(response.status).toBe(403);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("derives client and environment from the machine principal", async () => {
    const evaluate = vi.fn(async (command) => ({
      schemaVersion: "orderpro.walking-delivery-quote.v1" as const,
      quoteId: "quote-1",
      replayed: false,
      eligible: true,
      normalizedAddress: command.address,
      customerCoordinates: [-73.95, 40.8] as const,
      postalCode: "10021",
      selectedLocationId: "store-3rd-avenue",
      zoneVersionId: "zone-v1",
      feePolicyVersionId: "fee-v1",
      routingProvider: "router",
      routingProfile: "walking" as const,
      distanceFeet: 1_760,
      durationSeconds: 600,
      feeCents: 1_000,
      tierId: "UP_TO_2300_FT" as const,
      reasonCode: "ELIGIBLE" as const,
      calculatedAt: "2026-07-16T20:00:00.000Z",
      slots: [],
      correlationId: command.correlationId,
    }));
    const handler = createWalkingQuotePostHandler({
      async authenticate() {
        return {
          authenticated: true,
          principal: {
            clientId: "ecommerce-staging",
            environment: "STAGING",
            scopes: ["walking-zones:read", "availability:read"],
          },
        };
      },
      evaluate,
    });
    const response = await handler(request(validBody));
    expect(response.status).toBe(200);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "ecommerce-staging",
      environment: "STAGING",
      idempotencyKey: "quote-command-123",
      correlationId: "correlation-123",
    }));
  });

  it("requires a caller correlation ID after authentication", async () => {
    const evaluate = vi.fn();
    const handler = createWalkingQuotePostHandler({
      async authenticate() {
        return {
          authenticated: true,
          principal: {
            clientId: "ecommerce-staging",
            environment: "STAGING",
            scopes: ["walking-zones:read", "availability:read"],
          },
        } as const;
      },
      evaluate,
    });
    const response = await handler(request(validBody, { "X-Correlation-ID": "" }));
    expect(response.status).toBe(422);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
