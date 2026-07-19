import { describe, expect, it, vi } from "vitest";
import { LocalDeliveryApplicationError } from "./contracts";
import {
  createCapacityHoldPostHandler,
  createCapacityHoldTransitionPostHandler,
  createLocalDeliveryQuotePostHandler,
} from "./local-delivery-http-handlers";

const validQuoteBody = {
  address: {
    line1: "500 E 80th St",
    line2: null,
    city: "New York",
    state: "NY",
    postalCode: "10075",
    country: "US",
  },
  cartLines: [{ variantId: "variant-1", quantity: 1 }],
  requestedDate: "2026-07-20",
};

function request(path: string, body?: unknown) {
  return new Request(`http://orderpro.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "request-key-001",
      "X-Correlation-ID": "correlation-001",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function authenticate(scopes: readonly string[]) {
  return async () => ({
    authenticated: true,
    principal: { clientId: "storefront-staging", environment: "STAGING", scopes },
  } as const);
}

describe("local delivery HTTP handlers", () => {
  it("returns 503 before parsing PII when M2M authentication is not configured", async () => {
    const evaluate = vi.fn();
    const handler = createLocalDeliveryQuotePostHandler({
      async authenticate() {
        return {
          authenticated: false,
          code: "M2M_AUTH_NOT_CONFIGURED",
        } as const;
      },
      evaluate,
    });
    const response = await handler(request("/api/v1/local-delivery/quote", "customer-pii-is-not-parsed"));
    expect(response.status).toBe(503);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "M2M_AUTH_NOT_CONFIGURED" });
  });

  it("never reflects authentication secrets or thrown verifier details", async () => {
    const secret = "Bearer secret-token-must-never-escape";
    const evaluate = vi.fn();
    const rejected = createLocalDeliveryQuotePostHandler({
      async authenticate() {
        return {
          authenticated: false,
          code: "UNAUTHORIZED",
        } as const;
      },
      evaluate,
    });
    const unavailable = createLocalDeliveryQuotePostHandler({
      async authenticate() {
        throw new Error(`${secret}; jwks timeout`);
      },
      evaluate,
    });

    const rejectedResponse = await rejected(
      request("/api/v1/local-delivery/quote", "customer-pii-is-not-parsed"),
    );
    const unavailableResponse = await unavailable(
      request("/api/v1/local-delivery/quote", "customer-pii-is-not-parsed"),
    );
    expect(rejectedResponse.status).toBe(401);
    expect(unavailableResponse.status).toBe(503);
    expect(rejectedResponse.headers.get("cache-control")).toBe("no-store");
    expect(unavailableResponse.headers.get("cache-control")).toBe("no-store");
    const rejectedBody = await rejectedResponse.text();
    const unavailableBody = await unavailableResponse.text();
    expect(rejectedBody).not.toContain(secret);
    expect(unavailableBody).not.toContain(secret);
    expect(rejectedBody).not.toContain("private-idp");
    expect(unavailableBody).not.toContain("jwks");
    expect(JSON.parse(rejectedBody)).toMatchObject({
      code: "UNAUTHORIZED",
      message: "The machine credential is invalid.",
    });
    expect(JSON.parse(unavailableBody)).toMatchObject({
      code: "M2M_AUTH_NOT_CONFIGURED",
      message: "Machine authentication is not configured.",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("authenticates and authorizes before parsing customer address data", async () => {
    const evaluate = vi.fn();
    const handler = createLocalDeliveryQuotePostHandler({
      authenticate: authenticate([]),
      evaluate,
    });
    const response = await handler(request("/api/v1/local-delivery/quote", "not-a-request"));
    expect(response.status).toBe(403);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("accepts the structured quote contract and derives caller fields from M2M", async () => {
    const evaluate = vi.fn(async (command) => ({
      quoteId: "quote-1",
      replayed: false,
      eligible: false as const,
      bookable: false as const,
      reasonCode: "CONTACT_STORE" as const,
      storefrontMessage: "Contact store" as const,
      normalizedAddress: { ...command.address, borough: "Manhattan" as const },
      coordinates: { latitude: 40.75, longitude: -73.97 },
      postalCode: "10022",
      correlationId: command.correlationId,
      expiresAt: "2026-07-16T16:05:00.000Z",
    }));
    const handler = createLocalDeliveryQuotePostHandler({
      authenticate: authenticate(["local-delivery:quote"]),
      evaluate,
    });
    const response = await handler(request("/api/v1/local-delivery/quote", validQuoteBody));

    expect(response.status).toBe(200);
    expect(evaluate).toHaveBeenCalledWith({
      clientId: "storefront-staging",
      environment: "STAGING",
      idempotencyKey: "request-key-001",
      correlationId: "correlation-001",
      ...validQuoteBody,
    });
    await expect(response.json()).resolves.toMatchObject({
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
    });
  });

  it("requires a valid idempotency key and validates the structured body", async () => {
    const evaluate = vi.fn();
    const handler = createLocalDeliveryQuotePostHandler({
      authenticate: authenticate(["local-delivery:quote"]),
      evaluate,
    });
    const missingKey = new Request("http://orderpro.test/api/v1/local-delivery/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": "correlation-001",
      },
      body: JSON.stringify(validQuoteBody),
    });
    const missingKeyResponse = await handler(missingKey);
    expect(missingKeyResponse.status).toBe(422);
    await expect(missingKeyResponse.json()).resolves.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });

    const invalidBodyResponse = await handler(request("/api/v1/local-delivery/quote", {
      ...validQuoteBody,
      cartLines: [],
    }));
    expect(invalidBodyResponse.status).toBe(422);
    await expect(invalidBodyResponse.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("returns controlled address outcomes without leaking provider errors", async () => {
    const handler = createLocalDeliveryQuotePostHandler({
      authenticate: authenticate(["local-delivery:quote"]),
      async evaluate() {
        throw new LocalDeliveryApplicationError("ADDRESS_NOT_IN_MANHATTAN");
      },
    });
    const response = await handler(request("/api/v1/local-delivery/quote", validQuoteBody));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "ADDRESS_NOT_IN_MANHATTAN",
      message: "The local delivery quote could not be evaluated.",
      correlationId: "correlation-001",
    });
  });

  it("returns both capacity and inventory reservation identifiers for a new hold", async () => {
    const result = {
      replayed: false,
      hold: {
        capacityHoldId: "capacity-hold-1",
        inventoryReservationId: "inventory-reservation-1",
        quoteId: "quote-1",
        slotId: "slot-1",
        locationId: "third_avenue",
        clientId: "storefront-staging",
        correlationId: "correlation-001",
        capacitySeconds: 2_376,
        status: "HELD" as const,
        createdAt: "2026-07-16T16:00:00.000Z",
        expiresAt: "2026-07-16T16:05:00.000Z",
        confirmedOrderId: null,
        confirmedAt: null,
        releasedAt: null,
        releaseReason: null,
      },
    };
    const create = vi.fn()
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ ...result, replayed: true });
    const handler = createCapacityHoldPostHandler({
      authenticate: authenticate(["local-delivery:holds"]),
      create,
    });
    const response = await handler(request("/api/v1/local-delivery/holds", {
      quoteId: "quote-1",
      slotId: "slot-1",
    }));

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      clientId: "storefront-staging",
      idempotencyKey: "request-key-001",
      correlationId: "correlation-001",
      quoteId: "quote-1",
      slotId: "slot-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      hold: {
        capacityHoldId: "capacity-hold-1",
        inventoryReservationId: "inventory-reservation-1",
      },
    });
    const replay = await handler(request("/api/v1/local-delivery/holds", {
      quoteId: "quote-1",
      slotId: "slot-1",
    }));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true });
  });

  it("passes the hold path identifier to confirm/release transitions", async () => {
    const transition = vi.fn(async () => ({
      changed: true,
      hold: {
        capacityHoldId: "capacity-hold-1",
        inventoryReservationId: "inventory-reservation-1",
        quoteId: "quote-1",
        slotId: "slot-1",
        locationId: "third_avenue",
        clientId: "storefront-staging",
        correlationId: "correlation-001",
        capacitySeconds: 2_376,
        status: "CONFIRMED" as const,
        createdAt: "2026-07-16T16:00:00.000Z",
        expiresAt: "2026-07-16T16:05:00.000Z",
        confirmedOrderId: "order-1",
        confirmedAt: "2026-07-16T16:01:00.000Z",
        releasedAt: null,
        releaseReason: null,
      },
    }));
    const handler = createCapacityHoldTransitionPostHandler({
      authenticate: authenticate(["local-delivery:holds"]),
      action: "confirm",
      transition,
    });
    const response = await handler(
      request("/api/v1/local-delivery/holds/capacity-hold-1/confirm", { orderId: "order-1" }),
      { params: Promise.resolve({ holdId: "capacity-hold-1" }) },
    );
    expect(response.status).toBe(200);
    expect(transition).toHaveBeenCalledWith({
      clientId: "storefront-staging",
      correlationId: "correlation-001",
      holdId: "capacity-hold-1",
      action: "confirm",
      orderId: "order-1",
    });
  });
});
