import { randomUUID } from "node:crypto";
import {
  LocalDeliveryApplicationError,
  type LocalDeliveryCartLine,
  type LocalDeliveryQuotePersistencePlan,
  type LocalDeliveryQuoteResult,
  type LocalDeliveryQuoteSaveInput,
  type LocalDeliveryQuoteStorePort,
} from "../../application/local-delivery-v4/contracts";
import type {
  AcquireCapacityHoldInput,
  AcquireCapacityHoldOutcome,
  CapacityHold,
  CapacityHoldReleaseReason,
  CapacityHoldPort,
  TransitionCapacityHoldOutcome,
} from "../../application/local-delivery-v4/capacity-holds";

type StoredQuote = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly cartLines: readonly LocalDeliveryCartLine[];
  readonly quote: LocalDeliveryQuoteResult;
  readonly persistencePlan: LocalDeliveryQuotePersistencePlan;
};

export class InMemoryLocalDeliveryQuoteStore implements LocalDeliveryQuoteStorePort {
  private readonly byIdempotency = new Map<string, StoredQuote>();
  private readonly byId = new Map<string, StoredQuote>();

  constructor(private readonly idFactory: () => string = randomUUID) {}

  async findByIdempotency(input: { clientId: string; idempotencyKey: string }) {
    const stored = this.byIdempotency.get(`${input.clientId}:${input.idempotencyKey}`);
    return stored ? { requestHash: stored.requestHash, quote: stored.quote } : null;
  }

  async save(input: LocalDeliveryQuoteSaveInput) {
    const key = `${input.clientId}:${input.idempotencyKey}`;
    const existing = this.byIdempotency.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new LocalDeliveryApplicationError("IDEMPOTENCY_CONFLICT");
      }
      return { ...existing.quote, replayed: true };
    }
    const quote = {
      ...input.quote,
      quoteId: this.idFactory(),
      replayed: false,
    } as LocalDeliveryQuoteResult;
    const stored: StoredQuote = {
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      cartLines: input.cartLines.map((line) => ({ ...line })),
      quote,
      persistencePlan: input.persistencePlan.kind === "OFFER"
        ? {
            ...input.persistencePlan,
            inventoryLines: input.persistencePlan.inventoryLines.map((line) => ({ ...line })),
          }
        : { ...input.persistencePlan },
    };
    this.byIdempotency.set(key, stored);
    this.byId.set(quote.quoteId, stored);
    return quote;
  }

  async findById(quoteId: string) {
    const stored = this.byId.get(quoteId);
    return stored
      ? {
          clientId: stored.clientId,
          cartLines: stored.cartLines,
          quote: stored.quote,
          persistencePlan: stored.persistencePlan,
        }
      : null;
  }
}

type InventorySeed = {
  readonly variantId: string;
  readonly availableQuantity: number;
};

type SlotSeed = {
  readonly slotId: string;
  readonly availableCapacitySeconds: number;
};

type StoredHold = {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  hold: CapacityHold;
  readonly inventoryLines: AcquireCapacityHoldInput["inventoryLines"];
  restored: boolean;
};

/**
 * Test/staging adapter that commits capacity and inventory in one synchronous
 * critical section. A real adapter must provide the same atomic guarantee in
 * its database transaction.
 */
export class InMemoryCapacityHoldStore implements CapacityHoldPort {
  private readonly availableCapacity = new Map<string, number>();
  private readonly availableInventory = new Map<string, number>();
  private readonly holds = new Map<string, StoredHold>();
  private readonly idempotency = new Map<string, StoredHold>();

  constructor(
    seeds: { readonly slots: readonly SlotSeed[]; readonly inventory: readonly InventorySeed[] },
    private readonly idFactory: () => string = randomUUID,
  ) {
    for (const slot of seeds.slots) {
      if (this.availableCapacity.has(slot.slotId)) throw new Error("Duplicate slot seed");
      if (
        !Number.isSafeInteger(slot.availableCapacitySeconds) ||
        slot.availableCapacitySeconds <= 0
      ) {
        throw new Error("Slot capacity seed must be a positive integer");
      }
      this.availableCapacity.set(slot.slotId, slot.availableCapacitySeconds);
    }
    for (const item of seeds.inventory) {
      if (this.availableInventory.has(item.variantId)) throw new Error("Duplicate inventory seed");
      if (
        !Number.isSafeInteger(item.availableQuantity) ||
        item.availableQuantity < 0
      ) {
        throw new Error("Inventory seed must be a non-negative integer");
      }
      this.availableInventory.set(item.variantId, item.availableQuantity);
    }
  }

  private restore(stored: StoredHold) {
    if (stored.restored) return;
    this.availableCapacity.set(
      stored.hold.slotId,
      (this.availableCapacity.get(stored.hold.slotId) ?? 0) + stored.hold.capacitySeconds,
    );
    for (const line of stored.inventoryLines) {
      this.availableInventory.set(
        line.variantId,
        (this.availableInventory.get(line.variantId) ?? 0) + line.quantity,
      );
    }
    stored.restored = true;
  }

  private expire(now: string) {
    const timestamp = Date.parse(now);
    for (const stored of this.holds.values()) {
      if (stored.hold.status === "HELD" && Date.parse(stored.hold.expiresAt) <= timestamp) {
        stored.hold = {
          ...stored.hold,
          status: "EXPIRED",
          releasedAt: now,
          releaseReason: "QUOTE_EXPIRED",
        };
        this.restore(stored);
      }
    }
  }

  async findByIdempotency(input: { clientId: string; idempotencyKey: string; now: string }) {
    this.expire(input.now);
    const stored = this.idempotency.get(`${input.clientId}:${input.idempotencyKey}`);
    return stored ? { requestHash: stored.requestHash, hold: stored.hold } : null;
  }

  async acquire(input: AcquireCapacityHoldInput): Promise<AcquireCapacityHoldOutcome> {
    this.expire(input.createdAt);
    const idempotencyKey = `${input.clientId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) {
      return existing.requestHash === input.requestHash
        ? { kind: "REPLAY", hold: existing.hold }
        : { kind: "IDEMPOTENCY_CONFLICT" };
    }

    if (
      !Number.isSafeInteger(input.capacitySeconds) ||
      input.capacitySeconds <= 0 ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
    ) {
      return { kind: "INSUFFICIENT_CAPACITY" };
    }

    const availableCapacity = this.availableCapacity.get(input.slotId) ?? 0;
    if (availableCapacity < input.capacitySeconds) return { kind: "INSUFFICIENT_CAPACITY" };

    const requestedInventory = new Map<string, number>();
    for (const line of input.inventoryLines) {
      if (
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        !line.variantId
      ) {
        return { kind: "INVENTORY_UNAVAILABLE" };
      }
      requestedInventory.set(
        line.variantId,
        (requestedInventory.get(line.variantId) ?? 0) + line.quantity,
      );
    }
    for (const [variantId, quantity] of requestedInventory) {
      if ((this.availableInventory.get(variantId) ?? 0) < quantity) {
        return { kind: "INVENTORY_UNAVAILABLE" };
      }
    }

    // All checks precede both mutations: neither resource can be partially held.
    this.availableCapacity.set(input.slotId, availableCapacity - input.capacitySeconds);
    for (const [variantId, quantity] of requestedInventory) {
      this.availableInventory.set(
        variantId,
        (this.availableInventory.get(variantId) ?? 0) - quantity,
      );
    }
    const holdId = this.idFactory();
    const hold: CapacityHold = {
      capacityHoldId: holdId,
      quoteId: input.quoteId,
      slotId: input.slotId,
      locationId: input.locationId,
      clientId: input.clientId,
      correlationId: input.correlationId,
      inventoryReservationId: this.idFactory(),
      capacitySeconds: input.capacitySeconds,
      status: "HELD",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      confirmedOrderId: null,
      confirmedAt: null,
      releasedAt: null,
      releaseReason: null,
    };
    const stored: StoredHold = {
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      hold,
      inventoryLines: input.inventoryLines.map((line) => ({ ...line })),
      restored: false,
    };
    this.holds.set(holdId, stored);
    this.idempotency.set(idempotencyKey, stored);
    return { kind: "ACQUIRED", hold };
  }

  async confirm(input: { clientId: string; correlationId: string; holdId: string; orderId: string; now: string }): Promise<TransitionCapacityHoldOutcome> {
    this.expire(input.now);
    const stored = this.holds.get(input.holdId);
    if (!stored || stored.hold.clientId !== input.clientId) return { kind: "NOT_FOUND" };
    if (stored.hold.status === "CONFIRMED") {
      return stored.hold.confirmedOrderId === input.orderId
        ? { kind: "UNCHANGED", hold: stored.hold }
        : { kind: "INVALID_STATE" };
    }
    if (stored.hold.status !== "HELD") return { kind: "INVALID_STATE" };
    stored.hold = {
      ...stored.hold,
      status: "CONFIRMED",
      confirmedOrderId: input.orderId,
      confirmedAt: input.now,
    };
    return { kind: "UPDATED", hold: stored.hold };
  }

  async release(input: { clientId: string; correlationId: string; holdId: string; reason: CapacityHoldReleaseReason; now: string }): Promise<TransitionCapacityHoldOutcome> {
    this.expire(input.now);
    const stored = this.holds.get(input.holdId);
    if (!stored || stored.hold.clientId !== input.clientId) return { kind: "NOT_FOUND" };
    if (stored.hold.status === "RELEASED") {
      if (stored.hold.releaseReason !== input.reason) return { kind: "INVALID_STATE" };
      return { kind: "UNCHANGED", hold: stored.hold };
    }
    if (stored.hold.status === "EXPIRED") return { kind: "UNCHANGED", hold: stored.hold };
    if (stored.hold.status === "CONFIRMED") return { kind: "INVALID_STATE" };
    stored.hold = {
      ...stored.hold,
      status: "RELEASED",
      releasedAt: input.now,
      releaseReason: input.reason,
    };
    this.restore(stored);
    return { kind: "UPDATED", hold: stored.hold };
  }

  capacityRemaining(slotId: string) {
    return this.availableCapacity.get(slotId) ?? 0;
  }

  inventoryRemaining(variantId: string) {
    return this.availableInventory.get(variantId) ?? 0;
  }
}
