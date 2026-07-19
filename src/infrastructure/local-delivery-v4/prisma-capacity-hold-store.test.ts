import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AcquireCapacityHoldInput } from "../../application/local-delivery-v4/capacity-holds";

vi.mock("server-only", () => ({}));

import {
  PrismaCapacityHoldStore,
  type LocalDeliveryInventoryAllocationStrategy,
} from "./prisma-capacity-hold-store";
import { exactPhysicalTupleUniqueSufficientBalanceStrategy } from "./exact-physical-tuple-unique-sufficient-balance";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const quoteId = id(1);
const holdId = id(2);
const reservationId = id(3);
const slotId = id(4);
const productId = id(5);
const lotId = id(6);
const ownerId = id(7);
const nodeId = id(8);
const containerId = id(9);
const orderLocationId = id(10);
const deliveryLocationId = id(11);
const createdAt = "2026-07-17T16:00:00.000Z";
const expiresAt = "2026-07-17T16:05:00.000Z";
const transitionAt = "2026-07-17T16:02:00.000Z";
const databaseDecisionAt = "2026-07-17T16:00:10.000Z";
const databaseFinalAt = "2026-07-17T16:00:20.000Z";

function sqlText(query: unknown) {
  return (query as { strings?: readonly string[] }).strings?.join("?") ?? "";
}

function strategy(
  allocate: LocalDeliveryInventoryAllocationStrategy["allocate"] = () => [{
    lineNumber: 1,
    balanceId: id(12),
  }],
): LocalDeliveryInventoryAllocationStrategy {
  return {
    strategyId: "container_lot_priority",
    strategyVersion: "v1",
    allocate,
  };
}

function acquireInput(): AcquireCapacityHoldInput {
  return {
    clientId: "storefront-staging",
    idempotencyKey: "capacity-hold-0001",
    requestHash: `sha256:${"a".repeat(64)}`,
    correlationId: "correlation-acquire",
    orderLocationExternalId: "warehouse_nj",
    orderLocationDecisionCode: "warehouse_consolidation",
    orderLocationDecisionVersion: "v1",
    quoteId,
    slotId: "slot-2026-07-17-1700",
    locationId: "third_avenue",
    capacitySeconds: 1_140,
    inventoryLines: [{
      lineNumber: 1,
      variantId: "variant-1",
      productId,
      quantity: 1,
      readinessStatus: "READY",
      inventoryOwnerLocationId: ownerId,
      inventoryOwnerExternalLocationId: "warehouse_nj",
      inventoryNodeId: nodeId,
      inventoryNodeExternalId: "third_avenue",
      containerId,
      storageLocationId: null,
      transferStatus: "NOT_REQUIRED",
      earliestReadyAt: null,
    }],
    createdAt,
    expiresAt,
  };
}

function reservation(status: "HELD" | "CONFIRMED" | "RELEASED" | "EXPIRED" = "HELD") {
  const confirmed = status === "CONFIRMED";
  const released = status === "RELEASED" || status === "EXPIRED";
  return {
    id: reservationId,
    quoteId,
    clientId: "storefront-staging",
    idempotencyKey: "capacity-hold-0001",
    requestHash: `sha256:${"a".repeat(64)}`,
    correlationId: "correlation-acquire",
    status,
    deliveryLocationExternalId: "third_avenue",
    expiresAt: new Date(expiresAt),
    confirmedOrderId: confirmed ? "order-1" : null,
    confirmedAt: confirmed ? new Date(transitionAt) : null,
    releasedAt: released ? new Date(transitionAt) : null,
    releaseReason: status === "EXPIRED" ? "QUOTE_EXPIRED" : status === "RELEASED" ? "MANUAL" : null,
    version: status === "HELD" ? 1 : 2,
  };
}

function holdRecord(status: "HELD" | "CONFIRMED" | "RELEASED" | "EXPIRED" = "HELD") {
  const heldReservation = reservation(status);
  return {
    id: holdId,
    quoteId,
    capacitySlotId: slotId,
    clientId: heldReservation.clientId,
    idempotencyKey: heldReservation.idempotencyKey,
    requestHash: heldReservation.requestHash,
    correlationId: heldReservation.correlationId,
    status,
    reservedCapacitySeconds: 1_140,
    expiresAt: heldReservation.expiresAt,
    confirmedOrderId: heldReservation.confirmedOrderId,
    confirmedAt: heldReservation.confirmedAt,
    releasedAt: heldReservation.releasedAt,
    releaseReason: heldReservation.releaseReason,
    version: heldReservation.version,
    createdAt: new Date(createdAt),
    updatedAt: new Date(transitionAt),
    capacitySlot: { slotKey: "slot-2026-07-17-1700" },
    inventoryReservations: [heldReservation],
  };
}

function acquireTransaction() {
  const createHold = vi.fn(async () => ({ id: holdId }));
  const createReservation = vi.fn(async () => ({ id: reservationId }));
  const createLines = vi.fn(async () => ({ count: 1 }));
  const updateHold = vi.fn(async () => ({}));
  const updateReservation = vi.fn(async () => ({}));
  const createAudit = vi.fn(async () => ({}));
  const executeRaw = vi.fn(async () => 0);
  let clockRead = 0;
  const queryRaw = vi.fn(async (query: unknown): Promise<unknown> => {
    const sql = sqlText(query);
    if (sql.includes('FROM "WalkingDeliveryQuote" quote')) {
      return [{
        id: quoteId,
        clientId: "storefront-staging",
        externalSelectedLocationId: "third_avenue",
        selectedOperationalLocationId: deliveryLocationId,
        slotPolicyId: id(13),
        capacityRequiredSeconds: 1_140,
        bookable: true,
        expiresAt: new Date("2026-07-17T17:00:00.000Z"),
        inventoryReadyAt: null,
        holdTtlSeconds: 300,
      }];
    }
    if (sql.includes('FROM "WalkingCapacityHold" hold') && sql.includes("ORDER BY")) {
      return [];
    }
    if (sql.includes('FROM "WalkingCapacitySlot" slot')) {
      return [{
        id: slotId,
        slotPolicyId: id(13),
        operationalLocationId: deliveryLocationId,
        slotKey: "slot-2026-07-17-1700",
        startsAt: new Date("2026-07-17T17:00:00.000Z"),
        endsAt: new Date("2026-07-17T18:00:00.000Z"),
        capacitySeconds: 4_000,
        status: "OPEN",
      }];
    }
    if (sql.includes("clock_timestamp()")) {
      clockRead += 1;
      return [{
        databaseNow: new Date(clockRead === 1 ? databaseDecisionAt : databaseFinalAt),
      }];
    }
    if (sql.includes("COALESCE(SUM")) return [{ reservedCapacitySeconds: BigInt(0) }];
    if (sql.includes('FROM "InventoryNodeBalance" balance')) {
      return [{
        id: id(12),
        productId,
        inventoryLotId: lotId,
        inventoryOwnerLocationId: ownerId,
        inventoryNodeId: nodeId,
        containerId,
        storageLocationId: null,
        available: new Prisma.Decimal(3),
      }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const findIdentity = vi.fn(async ({ where }: { where: { externalLocationId: string } }) =>
    where.externalLocationId === "warehouse_nj"
      ? {
          id: id(14),
          externalLocationId: "warehouse_nj",
          operationalLocationId: orderLocationId,
          active: true,
          operationalLocation: { active: true },
        }
      : {
          id: id(15),
          externalLocationId: "third_avenue",
          operationalLocationId: deliveryLocationId,
          active: true,
          operationalLocation: { active: true },
        });
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    localDeliveryLocationIdentity: { findUnique: findIdentity },
    walkingDeliveryQuoteInventoryLine: {
      findMany: vi.fn(async () => [{
        lineNumber: 1,
        variantId: "variant-1",
        productId,
        quantity: 1,
        readinessStatus: "READY",
        inventoryOwnerLocationId: ownerId,
        inventoryOwnerExternalLocationId: "warehouse_nj",
        inventoryNodeId: nodeId,
        inventoryNodeExternalId: "third_avenue",
        containerId,
        storageLocationId: null,
        transferStatus: "NOT_REQUIRED",
        earliestReadyAt: null,
      }]),
    },
    walkingCapacityHold: {
      create: createHold,
      update: updateHold,
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        void args;
        return holdRecord();
      }),
    },
    walkingInventoryReservation: {
      create: createReservation,
      update: updateReservation,
    },
    walkingInventoryReservationLine: { createMany: createLines },
    auditEvent: { create: createAudit },
  };
  return {
    tx,
    queryRaw,
    createHold,
    createReservation,
    createLines,
    updateHold,
    updateReservation,
    createAudit,
    executeRaw,
  };
}

describe("PrismaCapacityHoldStore", () => {
  it("requires an explicitly identified and versioned allocation strategy", () => {
    expect(() => new PrismaCapacityHoldStore({
      strategyId: "",
      strategyVersion: "v1",
      allocate: () => [],
    })).toThrow("VERSIONED_INVENTORY_ALLOCATION_STRATEGY_REQUIRED");
  });

  it("locks in canonical order and atomically persists the versioned decisions", async () => {
    const fixture = acquireTransaction();
    const allocate = vi.fn(strategy().allocate);
    const transaction = vi.fn(async (
      operation: (client: typeof fixture.tx) => Promise<unknown>,
    ) => operation(fixture.tx));
    const db = {
      $transaction: transaction,
      walkingCapacityHold: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(allocate), db).acquire(acquireInput());

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    const sqlCalls = fixture.queryRaw.mock.calls.map(([query]) => sqlText(query));
    expect(sqlCalls[0]).toContain('FROM "WalkingDeliveryQuote" quote');
    expect(sqlCalls[1]).toContain('FROM "WalkingCapacityHold" hold');
    expect(sqlCalls[2]).toContain('FROM "WalkingCapacitySlot" slot');
    const clockIndexes = sqlCalls
      .map((sql, index) => sql.includes("clock_timestamp()") ? index : -1)
      .filter((index) => index >= 0);
    const balanceIndex = sqlCalls.findIndex((sql) =>
      sql.includes('FROM "InventoryNodeBalance" balance'));
    expect(clockIndexes).toHaveLength(2);
    expect(clockIndexes[0]).toBeGreaterThan(2);
    expect(balanceIndex).toBeGreaterThan(clockIndexes[0]!);
    expect(clockIndexes[1]).toBeGreaterThan(balanceIndex);
    expect(sqlCalls[balanceIndex]).toContain('ORDER BY balance."id"');
    expect(sqlCalls[balanceIndex]).toContain("FOR UPDATE OF balance");
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({
      quoteId,
      candidates: [expect.objectContaining({
        balanceId: id(12),
        availableQuantity: "3",
      })],
    }));
    expect(allocate.mock.results[0]?.value).not.toBeInstanceOf(Promise);
    expect(allocate.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.queryRaw.mock.invocationCallOrder[clockIndexes[1]!]!,
    );
    expect(fixture.createHold).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdAt: new Date(databaseFinalAt),
        expiresAt: new Date("2026-07-17T16:05:20.000Z"),
      }),
      select: { id: true },
    });
    expect(fixture.createReservation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderLocationExternalId: "warehouse_nj",
        deliveryLocationExternalId: "third_avenue",
        orderLocationDecisionCode: "warehouse_consolidation",
        orderLocationDecisionVersion: "v1",
        inventoryAllocationStrategyId: "container_lot_priority",
        inventoryAllocationStrategyVersion: "v1",
      }),
      select: { id: true },
    });
    expect(fixture.createHold.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.createReservation.mock.invocationCallOrder[0]!,
    );
    expect(fixture.createReservation.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.createLines.mock.invocationCallOrder[0]!,
    );
    expect(fixture.createLines.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({
      kind: "ACQUIRED",
      hold: {
        capacityHoldId: holdId,
        inventoryReservationId: reservationId,
        correlationId: "correlation-acquire",
        status: "HELD",
      },
    });
  });

  it("rejects two sufficient balances without creating or mutating resources", async () => {
    const fixture = acquireTransaction();
    const baseQuery = fixture.queryRaw.getMockImplementation()!;
    fixture.queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (sql.includes('FROM "InventoryNodeBalance" balance')) {
        return [
          {
            id: id(12),
            productId,
            inventoryLotId: lotId,
            inventoryOwnerLocationId: ownerId,
            inventoryNodeId: nodeId,
            containerId,
            storageLocationId: null,
            available: new Prisma.Decimal(3),
          },
          {
            id: id(18),
            productId,
            inventoryLotId: id(19),
            inventoryOwnerLocationId: ownerId,
            inventoryNodeId: nodeId,
            containerId,
            storageLocationId: null,
            available: new Prisma.Decimal(2),
          },
        ];
      }
      return baseQuery(query);
    });
    const db = {
      $transaction: vi.fn(async (
        operation: (client: typeof fixture.tx) => Promise<unknown>,
      ) => operation(fixture.tx)),
      walkingCapacityHold: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(
      exactPhysicalTupleUniqueSufficientBalanceStrategy,
      db,
    ).acquire(acquireInput());

    expect(result).toEqual({ kind: "INVENTORY_UNAVAILABLE" });
    expect(fixture.createHold).not.toHaveBeenCalled();
    expect(fixture.createReservation).not.toHaveBeenCalled();
    expect(fixture.createLines).not.toHaveBeenCalled();
    expect(fixture.updateHold).not.toHaveBeenCalled();
    expect(fixture.updateReservation).not.toHaveBeenCalled();
    expect(fixture.createAudit).not.toHaveBeenCalled();
    expect(fixture.executeRaw).not.toHaveBeenCalled();
  });

  it("does not reinterpret a final serialization failure as a capacity outcome", async () => {
    const p2034 = new Prisma.PrismaClientKnownRequestError("serialization failure", {
      code: "P2034",
      clientVersion: "test",
    });
    const transaction = vi.fn(async () => {
      throw p2034;
    });
    const db = {
      $transaction: transaction,
      walkingCapacityHold: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      new PrismaCapacityHoldStore(strategy(), db).acquire(acquireInput()),
    ).rejects.toBe(p2034);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("expires a prior due hold before acquiring the same quote with a new key", async () => {
    const fixture = acquireTransaction();
    const previousHoldId = id(16);
    const previousReservationId = id(17);
    const previousExpiry = new Date("2026-07-17T15:59:00.000Z");
    const previous = {
      ...holdRecord(),
      id: previousHoldId,
      idempotencyKey: "capacity-hold-previous",
      expiresAt: previousExpiry,
      inventoryReservations: [{
        ...reservation(),
        id: previousReservationId,
        idempotencyKey: "capacity-hold-previous",
        expiresAt: previousExpiry,
      }],
    };
    const baseQuery = fixture.queryRaw.getMockImplementation()!;
    fixture.queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query);
      if (sql.includes('FROM "WalkingCapacityHold" hold') && sql.includes("ORDER BY")) {
        return [{
          id: previousHoldId,
          capacitySlotId: slotId,
          clientId: "storefront-staging",
          idempotencyKey: "capacity-hold-previous",
          requestHash: `sha256:${"c".repeat(64)}`,
          status: "HELD",
          expiresAt: previousExpiry,
        }];
      }
      return baseQuery(query);
    });
    fixture.tx.walkingCapacityHold.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === previousHoldId ? previous : holdRecord(),
    );
    const db = {
      $transaction: vi.fn(async (
        operation: (client: typeof fixture.tx) => Promise<unknown>,
      ) => operation(fixture.tx)),
      walkingCapacityHold: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(), db).acquire(acquireInput());

    expect(fixture.updateHold).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: previousHoldId },
      data: expect.objectContaining({ status: "EXPIRED", releaseReason: "QUOTE_EXPIRED" }),
    }));
    expect(fixture.updateReservation).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: previousReservationId },
      data: expect.objectContaining({ status: "EXPIRED", releaseReason: "QUOTE_EXPIRED" }),
    }));
    expect(fixture.updateReservation.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.createHold.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ kind: "ACQUIRED", hold: { capacityHoldId: holdId } });
  });

  it("rethrows P2002 when no hold exists for the idempotency tuple", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unrelated unique conflict", {
      code: "P2002",
      clientVersion: "test",
    });
    const findUnique = vi.fn(async () => null);
    const db = {
      $transaction: vi.fn(async () => {
        throw p2002;
      }),
      walkingCapacityHold: { findUnique },
    } as unknown as PrismaClient;

    await expect(
      new PrismaCapacityHoldStore(strategy(), db).acquire(acquireInput()),
    ).rejects.toBe(p2002);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        clientId_idempotencyKey: {
          clientId: "storefront-staging",
          idempotencyKey: "capacity-hold-0001",
        },
      },
    }));
  });

  it.each([
    ["same request", `sha256:${"a".repeat(64)}`, "REPLAY"],
    ["different request", `sha256:${"b".repeat(64)}`, "IDEMPOTENCY_CONFLICT"],
  ])("handles P2002 for an existing tuple with the %s", async (_label, requestHash, kind) => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("idempotency conflict", {
      code: "P2002",
      clientVersion: "test",
    });
    const existing = { ...holdRecord(), requestHash };
    const db = {
      $transaction: vi.fn(async () => {
        throw p2002;
      }),
      walkingCapacityHold: { findUnique: vi.fn(async () => existing) },
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(), db).acquire(acquireInput());

    expect(result.kind).toBe(kind);
    if (kind === "REPLAY") expect(result).toMatchObject({ hold: { capacityHoldId: holdId } });
  });

  it("uses the post-lock database clock when findByIdempotency expires a hold", async () => {
    const databaseFindAt = "2026-07-17T16:06:00.000Z";
    const holdUpdate = vi.fn(async () => ({}));
    const reservationUpdate = vi.fn(async () => ({}));
    const queryRaw = vi.fn(async (query: unknown) =>
      sqlText(query).includes("clock_timestamp()")
        ? [{ databaseNow: new Date(databaseFindAt) }]
        : [{ id: holdId }]);
    const expiredRecord = {
      ...holdRecord("EXPIRED"),
      releasedAt: new Date(databaseFindAt),
      inventoryReservations: [{
        ...reservation("EXPIRED"),
        releasedAt: new Date(databaseFindAt),
      }],
    };
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn(async () => 0),
      walkingCapacityHold: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(holdRecord())
          .mockResolvedValueOnce(expiredRecord),
        update: holdUpdate,
      },
      walkingInventoryReservation: { update: reservationUpdate },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(), db).findByIdempotency({
      clientId: "storefront-staging",
      idempotencyKey: "capacity-hold-0001",
      now: "2026-07-17T15:00:00.000Z",
    });

    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(sqlText(queryRaw.mock.calls[1]?.[0])).toContain("clock_timestamp()");
    expect(holdUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "EXPIRED",
        releasedAt: new Date(databaseFindAt),
      }),
    }));
    expect(reservationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ releasedAt: new Date(databaseFindAt) }),
    }));
    expect(result).toMatchObject({ hold: { status: "EXPIRED" } });
  });

  it("confirms hold first, reservation second, and audits transition correlation separately", async () => {
    const holdUpdate = vi.fn(async () => ({}));
    const reservationUpdate = vi.fn(async () => ({}));
    const auditCreate = vi.fn(async () => ({}));
    const executeRaw = vi.fn(async () => 0);
    const queryRaw = vi.fn(async (query: unknown) =>
      sqlText(query).includes("clock_timestamp()")
        ? [{ databaseNow: new Date(transitionAt) }]
        : [{ id: holdId }]);
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      walkingCapacityHold: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(holdRecord())
          .mockResolvedValueOnce(holdRecord("CONFIRMED")),
        update: holdUpdate,
      },
      walkingInventoryReservation: { update: reservationUpdate },
      auditEvent: { create: auditCreate },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(), db).confirm({
      clientId: "storefront-staging",
      correlationId: "correlation-confirm-request",
      holdId,
      orderId: "order-1",
      now: "2026-07-17T15:00:00.000Z",
    });

    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain('FROM "WalkingCapacityHold" hold');
    expect(sqlText(queryRaw.mock.calls[1]?.[0])).toContain("clock_timestamp()");
    expect(holdUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      reservationUpdate.mock.invocationCallOrder[0]!,
    );
    expect(holdUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ correlationId: expect.anything() }),
    }));
    expect(reservationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ correlationId: expect.anything() }),
    }));
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "correlation-confirm-request",
        action: "walking_delivery.capacity_hold.confirmed.transition_context",
      }),
    });
    expect(result).toMatchObject({ kind: "UPDATED", hold: { status: "CONFIRMED" } });
  });

  it("returns UPDATED when release expires a HELD pair using the post-lock database clock", async () => {
    const databaseReleaseAt = "2026-07-17T16:06:00.000Z";
    const holdUpdate = vi.fn(async () => ({}));
    const reservationUpdate = vi.fn(async () => ({}));
    const queryRaw = vi.fn(async (query: unknown) =>
      sqlText(query).includes("clock_timestamp()")
        ? [{ databaseNow: new Date(databaseReleaseAt) }]
        : [{ id: holdId }]);
    const expiredRecord = {
      ...holdRecord("EXPIRED"),
      releasedAt: new Date(databaseReleaseAt),
      inventoryReservations: [{
        ...reservation("EXPIRED"),
        releasedAt: new Date(databaseReleaseAt),
      }],
    };
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn(async () => 0),
      walkingCapacityHold: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(holdRecord())
          .mockResolvedValueOnce(expiredRecord),
        update: holdUpdate,
      },
      walkingInventoryReservation: { update: reservationUpdate },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
    } as unknown as PrismaClient;

    const result = await new PrismaCapacityHoldStore(strategy(), db).release({
      clientId: "storefront-staging",
      correlationId: "correlation-release-request",
      holdId,
      reason: "MANUAL",
      now: "2026-07-17T16:01:00.000Z",
    });

    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain('FROM "WalkingCapacityHold" hold');
    expect(sqlText(queryRaw.mock.calls[1]?.[0])).toContain("clock_timestamp()");
    expect(holdUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "EXPIRED",
        releasedAt: new Date(databaseReleaseAt),
        releaseReason: "QUOTE_EXPIRED",
      }),
    }));
    expect(result).toMatchObject({ kind: "UPDATED", hold: { status: "EXPIRED" } });
  });

  it("expires due holds with SKIP LOCKED and restores the pair exactly once", async () => {
    const holdUpdate = vi.fn(async () => ({}));
    const reservationUpdate = vi.fn(async () => ({}));
    const auditCreate = vi.fn(async () => ({}));
    const executeRaw = vi.fn(async () => 0);
    const databaseExpiryAt = "2026-07-17T16:01:00.000Z";
    let dueRead = 0;
    const queryRaw = vi.fn(async (query: unknown) => {
      const sql = sqlText(query);
      if (sql.includes("clock_timestamp() AS")) {
        return [{ databaseNow: new Date(databaseExpiryAt) }];
      }
      dueRead += 1;
      return dueRead === 1 ? [{ id: holdId }] : [];
    });
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      walkingCapacityHold: {
        findUnique: vi.fn(async () => ({
          ...holdRecord(),
          expiresAt: new Date("2026-07-17T15:59:00.000Z"),
          inventoryReservations: [{
            ...reservation(),
            expiresAt: new Date("2026-07-17T15:59:00.000Z"),
          }],
        })),
        update: holdUpdate,
      },
      walkingInventoryReservation: { update: reservationUpdate },
      auditEvent: { create: auditCreate },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
    } as unknown as PrismaClient;

    const store = new PrismaCapacityHoldStore(strategy(), db);
    const count = await store.expireDue({
      now: "2026-07-17T15:00:00.000Z",
      correlationId: "walking-v4-expiry-worker",
      batchSize: 25,
    });
    const replayCount = await store.expireDue({
      now: "2026-07-17T15:00:00.000Z",
      correlationId: "walking-v4-expiry-worker",
      batchSize: 25,
    });

    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain(
      'hold."expiresAt" <= clock_timestamp()',
    );
    expect(sqlText(queryRaw.mock.calls[1]?.[0])).toContain("clock_timestamp() AS");
    expect(sqlText(queryRaw.mock.calls[0]?.[0])).toContain(
      'ORDER BY hold."capacitySlotId", hold."id", hold."expiresAt"',
    );
    expect(holdUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      reservationUpdate.mock.invocationCallOrder[0]!,
    );
    expect(holdUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "EXPIRED",
        releasedAt: new Date(databaseExpiryAt),
        releaseReason: "QUOTE_EXPIRED",
      }),
    }));
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ correlationId: "walking-v4-expiry-worker" }),
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
    expect(replayCount).toBe(0);
  });
});
