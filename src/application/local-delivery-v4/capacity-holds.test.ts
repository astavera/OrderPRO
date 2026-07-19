import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCapacityHoldStore,
  InMemoryLocalDeliveryQuoteStore,
} from "../../infrastructure/local-delivery-v4/in-memory-stores";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
  type LocalDeliveryQuoteStorePort,
} from "./contracts";
import {
  confirmCapacityHold,
  createCapacityHold,
  releaseCapacityHold,
} from "./capacity-holds";

const clientId = "storefront-staging";
const cartLines = [{ variantId: "variant-1", quantity: 1 }] as const;
const orderLocations = {
  async resolve() {
    return {
      orderLocationExternalId: "third_avenue",
      decisionCode: "selected-delivery-store",
      decisionVersion: "test-v1",
    };
  },
};

async function saveOffer(
  quotes: LocalDeliveryQuoteStorePort,
  idempotencyKey: string,
  expiresAt = "2026-07-16T16:15:00.000Z",
  holdTtlSeconds = 300,
) {
  return quotes.save({
    clientId,
    idempotencyKey,
    requestHash: `hash-${idempotencyKey}`,
    cartLines,
    persistencePlan: {
      kind: "OFFER",
      calculatedAt: "2026-07-16T16:00:00.000Z",
      holdTtlSeconds,
      preparationBufferSeconds: 180,
      handoffBufferSeconds: 120,
      inventoryLines: [{
        lineNumber: 1,
        variantId: "variant-1",
        productId: "00000000-0000-4000-8000-000000000101",
        quantity: 1,
        readinessStatus: "READY",
        inventoryOwnerLocationId: "00000000-0000-4000-8000-000000000072",
        inventoryOwnerExternalLocationId: "third_avenue",
        inventoryNodeId: "00000000-0000-4000-8000-000000000072",
        inventoryNodeExternalId: "third_avenue",
        containerId: "00000000-0000-4000-8000-000000000201",
        storageLocationId: null,
        transferStatus: "NOT_REQUIRED",
        earliestReadyAt: null,
      }],
    },
    quote: {
      eligible: true,
      bookable: true,
      reasonCode: "ELIGIBLE",
      normalizedAddress: {
        line1: "500 E 80th St",
        line2: null,
        city: "New York",
        state: "NY",
        postalCode: "10075",
        country: "US",
        borough: "Manhattan",
      },
      coordinates: { latitude: 40.775, longitude: -73.95 },
      postalCode: "10075",
      selectedLocationId: "third_avenue",
      selectedLocationName: "3rd Avenue Store",
      assignmentRule: "NEAREST_WALKING_ROUTE",
      walkingDistanceFeet: 4_261,
      walkingDurationSeconds: 1_038,
      roundTripDistanceFeet: 8_522,
      estimatedRoundTripDurationSeconds: 2_076,
      requiredCapacitySeconds: 2_376,
      feeCents: 2_500,
      currency: "USD",
      feeTierId: "whole-zone-25",
      candidateRoutes: [{
        locationId: "third_avenue",
        locationPriority: 1,
        walkingDistanceFeet: 4_261,
        walkingDurationSeconds: 1_038,
        routingProvider: "router",
      }],
      availableSlots: [{
        slotId: "slot-1",
        locationId: "third_avenue",
        startsAt: "2026-07-20T14:00:00-04:00",
        endsAt: "2026-07-20T15:00:00-04:00",
        remainingCapacitySeconds: 2_376,
      }],
      inventoryStatus: "READY",
      transferEarliestReadyAt: null,
      inventoryOwnerLocationIds: ["third_avenue"],
      inventoryNodeIds: ["third_avenue"],
      zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      routingProvider: "router",
      routingProfile: "walking",
      routeCalculatedAt: "2026-07-16T16:00:00.000Z",
      expiresAt,
      correlationId: "correlation-001",
    },
  });
}

function command(quoteId: string, idempotencyKey = "hold-request-001") {
  return {
    clientId,
    idempotencyKey,
    correlationId: "correlation-001",
    quoteId,
    slotId: "slot-1",
  } as const;
}

describe("capacity and inventory holds", () => {
  it("acquires capacity and inventory atomically and replays an idempotent request", async () => {
    let quoteSequence = 0;
    let holdSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore(
      {
        slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
        inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
      },
      () => `hold-resource-${++holdSequence}`,
    );
    const dependencies = {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    };

    const first = await createCapacityHold(command(quote.quoteId), dependencies);
    const replay = await createCapacityHold(command(quote.quoteId), dependencies);

    expect(first).toMatchObject({
      replayed: false,
      hold: {
        capacityHoldId: "hold-resource-1",
        inventoryReservationId: "hold-resource-2",
        correlationId: "correlation-001",
        status: "HELD",
      },
    });
    expect(replay).toEqual({ hold: first.hold, replayed: true });
    expect(holds.capacityRemaining("slot-1")).toBe(0);
    expect(holds.inventoryRemaining("variant-1")).toBe(0);
  });

  it("allows only one of two concurrent orders to reserve the same capacity", async () => {
    let quoteSequence = 0;
    let holdSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const [quoteA, quoteB] = await Promise.all([
      saveOffer(quotes, "source-quote-001"),
      saveOffer(quotes, "source-quote-002"),
    ]);
    const holds = new InMemoryCapacityHoldStore(
      {
        slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
        inventory: [{ variantId: "variant-1", availableQuantity: 2 }],
      },
      () => `resource-${++holdSequence}`,
    );
    const dependencies = {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    };

    const attempts = await Promise.allSettled([
      createCapacityHold(command(quoteA.quoteId, "hold-request-a"), dependencies),
      createCapacityHold(command(quoteB.quoteId, "hold-request-b"), dependencies),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "CAPACITY_HOLD_FAILED" },
    });
    expect(holds.capacityRemaining("slot-1")).toBe(0);
    expect(holds.inventoryRemaining("variant-1")).toBe(1);
  });

  it("does not consume capacity when the inventory reservation fails", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 0 }],
    });

    await expect(createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    })).rejects.toMatchObject({ code: "INVENTORY_NOT_READY" });
    expect(holds.capacityRemaining("slot-1")).toBe(2_376);
    expect(holds.inventoryRemaining("variant-1")).toBe(0);
  });

  it("propagates the audited order-location decision into the atomic acquisition", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
    });
    const acquire = vi.spyOn(holds, "acquire");

    await createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations: {
        async resolve() {
          return {
            orderLocationExternalId: "warehouse_englewood",
            decisionCode: "warehouse-consolidation",
            decisionVersion: "order-location-v2",
          };
        },
      },
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire.mock.calls[0]?.[0]).toMatchObject({
      orderLocationExternalId: "warehouse_englewood",
      orderLocationDecisionCode: "warehouse-consolidation",
      orderLocationDecisionVersion: "order-location-v2",
    });
  });

  it("does not acquire resources when no order location can be resolved", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
    });
    const acquire = vi.spyOn(holds, "acquire");

    await expect(createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations: { async resolve() { return null; } },
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    })).rejects.toMatchObject({ code: "CAPACITY_HOLD_FAILED" });

    expect(acquire).not.toHaveBeenCalled();
    expect(holds.capacityRemaining("slot-1")).toBe(2_376);
    expect(holds.inventoryRemaining("variant-1")).toBe(1);
  });

  it("releases both resources after expiration", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(
      quotes,
      "source-quote-001",
      "2026-07-16T16:15:00.000Z",
      60,
    );
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
    });
    await createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    });

    const expired = await holds.findByIdempotency({
      clientId,
      idempotencyKey: "hold-request-001",
      now: "2026-07-16T16:01:00.000Z",
    });
    expect(expired?.hold.status).toBe("EXPIRED");
    expect(holds.capacityRemaining("slot-1")).toBe(2_376);
    expect(holds.inventoryRemaining("variant-1")).toBe(1);
  });

  it("confirms idempotently and rejects release without coordinated order cancellation", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
    });
    const created = await createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    });
    const transition = {
      clientId,
      correlationId: "correlation-001",
      holdId: created.hold.capacityHoldId,
      action: "confirm" as const,
      orderId: "order-001",
    };

    const confirmed = await confirmCapacityHold(transition, {
      holds,
      now: () => new Date("2026-07-16T16:00:30.000Z"),
    });
    const replay = await confirmCapacityHold(transition, {
      holds,
      now: () => new Date("2026-07-16T16:00:40.000Z"),
    });
    expect(confirmed).toMatchObject({ changed: true, hold: { status: "CONFIRMED" } });
    expect(replay).toMatchObject({ changed: false, hold: { status: "CONFIRMED" } });

    await expect(releaseCapacityHold({
      clientId,
      correlationId: "correlation-001",
      holdId: created.hold.capacityHoldId,
      action: "release",
      reason: "ORDER_CANCELLED",
    }, {
      holds,
      now: () => new Date("2026-07-16T16:00:50.000Z"),
    })).rejects.toMatchObject({ code: "CAPACITY_HOLD_FAILED" });
    expect(holds.capacityRemaining("slot-1")).toBe(0);
    expect(holds.inventoryRemaining("variant-1")).toBe(0);
  });

  it("releases an unconfirmed hold and restores capacity and inventory exactly once", async () => {
    let quoteSequence = 0;
    const quotes = new InMemoryLocalDeliveryQuoteStore(() => `quote-${++quoteSequence}`);
    const quote = await saveOffer(quotes, "source-quote-001");
    const holds = new InMemoryCapacityHoldStore({
      slots: [{ slotId: "slot-1", availableCapacitySeconds: 2_376 }],
      inventory: [{ variantId: "variant-1", availableQuantity: 1 }],
    });
    const created = await createCapacityHold(command(quote.quoteId), {
      quotes,
      holds,
      orderLocations,
      now: () => new Date("2026-07-16T16:00:00.000Z"),
    });
    const releaseCommand = {
      clientId,
      correlationId: "correlation-001",
      holdId: created.hold.capacityHoldId,
      action: "release" as const,
      reason: "PAYMENT_FAILED" as const,
    };
    const released = await releaseCapacityHold(releaseCommand, {
      holds,
      now: () => new Date("2026-07-16T16:00:50.000Z"),
    });
    const replay = await releaseCapacityHold(releaseCommand, {
      holds,
      now: () => new Date("2026-07-16T16:01:00.000Z"),
    });
    expect(released).toMatchObject({
      changed: true,
      hold: { status: "RELEASED", releaseReason: "PAYMENT_FAILED" },
    });
    expect(replay).toMatchObject({ changed: false, hold: { status: "RELEASED" } });
    expect(holds.capacityRemaining("slot-1")).toBe(2_376);
    expect(holds.inventoryRemaining("variant-1")).toBe(1);
  });
});
