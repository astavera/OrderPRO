import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LocalDeliveryApplicationError,
  type LocalDeliveryInventoryLineEvidence,
} from "../../application/local-delivery-v4/contracts";
import {
  type AcquireCapacityHoldInput,
  type AcquireCapacityHoldOutcome,
  type CapacityHold,
  type CapacityHoldPort,
  type CapacityHoldReleaseReason,
  type TransitionCapacityHoldOutcome,
} from "../../application/local-delivery-v4/capacity-holds";
import { prisma } from "../database/prisma";

const serializableAttempts = 3;
const defaultExpiryBatchSize = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stableDecisionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export type LocalDeliveryInventoryBalanceCandidate = {
  readonly balanceId: string;
  readonly productId: string;
  readonly inventoryLotId: string;
  readonly inventoryOwnerLocationId: string;
  readonly inventoryNodeId: string;
  readonly containerId: string | null;
  readonly storageLocationId: string | null;
  /** Decimal text is used so a strategy never loses precision through IEEE-754. */
  readonly availableQuantity: string;
};

export type LocalDeliveryInventoryBalanceAllocation = {
  readonly lineNumber: number;
  readonly balanceId: string;
};

/**
 * A business-owned allocation rule. Candidate ordering is only the database
 * lock protocol; it must not be interpreted as FIFO or as allocation priority.
 * Implementations must be synchronous, pure and deterministic for the same
 * versioned input. They must not perform I/O, read clocks/randomness, or mutate
 * external state while database locks are held.
 */
export interface LocalDeliveryInventoryAllocationStrategy {
  readonly strategyId: string;
  readonly strategyVersion: string;
  allocate(input: {
    readonly quoteId: string;
    readonly lines: readonly LocalDeliveryInventoryLineEvidence[];
    readonly candidates: readonly LocalDeliveryInventoryBalanceCandidate[];
  }): readonly LocalDeliveryInventoryBalanceAllocation[];
}

export type ExpireDueCapacityHoldsInput = {
  readonly now: string;
  readonly correlationId: string;
  readonly batchSize?: number;
};

const holdInclude = {
  capacitySlot: { select: { slotKey: true } },
  inventoryReservations: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      quoteId: true,
      clientId: true,
      idempotencyKey: true,
      requestHash: true,
      correlationId: true,
      status: true,
      deliveryLocationExternalId: true,
      expiresAt: true,
      confirmedOrderId: true,
      confirmedAt: true,
      releasedAt: true,
      releaseReason: true,
      version: true,
    },
  },
} satisfies Prisma.WalkingCapacityHoldInclude;

type HoldRecord = Prisma.WalkingCapacityHoldGetPayload<{ include: typeof holdInclude }>;

type LockedQuoteRow = {
  readonly id: string;
  readonly clientId: string;
  readonly externalSelectedLocationId: string | null;
  readonly selectedOperationalLocationId: string | null;
  readonly slotPolicyId: string | null;
  readonly capacityRequiredSeconds: number | null;
  readonly bookable: boolean | null;
  readonly expiresAt: Date | null;
  readonly inventoryReadyAt: Date | null;
  readonly holdTtlSeconds: number | null;
};

type LockedHoldRow = {
  readonly id: string;
  readonly capacitySlotId: string;
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: "HELD" | "CONFIRMED" | "RELEASED" | "EXPIRED";
  readonly expiresAt: Date;
};

type LockedSlotRow = {
  readonly id: string;
  readonly slotPolicyId: string;
  readonly operationalLocationId: string;
  readonly slotKey: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly capacitySeconds: number;
  readonly status: "OPEN" | "CLOSED" | "CANCELLED";
};

type BalanceRow = {
  readonly id: string;
  readonly productId: string;
  readonly inventoryLotId: string;
  readonly inventoryOwnerLocationId: string;
  readonly inventoryNodeId: string;
  readonly containerId: string | null;
  readonly storageLocationId: string | null;
  readonly available: Prisma.Decimal | string | number;
};

type ActiveCapacityRow = { readonly reservedCapacitySeconds: bigint | number | string };

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function strictInstant(value: string, label: string) {
  const match = rfc3339.exec(value);
  if (!match) throw new Error(`INVALID_${label}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(`INVALID_${label}`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`INVALID_${label}`);
  return instant;
}

function sameNullable(left: string | null, right: string | null) {
  return left === right;
}

function isP2002(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function serializable<T>(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= serializableAttempts; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt === serializableAttempts
      ) {
        throw error;
      }
    }
  }
  throw new Error("UNREACHABLE_SERIALIZABLE_RETRY");
}

function mapHold(record: HoldRecord): CapacityHold {
  const reservation = record.inventoryReservations[0];
  if (
    record.inventoryReservations.length !== 1 ||
    !reservation ||
    reservation.quoteId !== record.quoteId ||
    reservation.clientId !== record.clientId ||
    reservation.idempotencyKey !== record.idempotencyKey ||
    reservation.requestHash !== record.requestHash ||
    reservation.correlationId !== record.correlationId ||
    reservation.status !== record.status ||
    reservation.expiresAt.getTime() !== record.expiresAt.getTime() ||
    reservation.confirmedOrderId !== record.confirmedOrderId ||
    reservation.confirmedAt?.getTime() !== record.confirmedAt?.getTime() ||
    reservation.releasedAt?.getTime() !== record.releasedAt?.getTime() ||
    reservation.releaseReason !== record.releaseReason
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_HOLD_RESERVATION_PAIR");
  }
  return {
    capacityHoldId: record.id,
    quoteId: record.quoteId,
    slotId: record.capacitySlot.slotKey,
    locationId: reservation.deliveryLocationExternalId,
    clientId: record.clientId,
    correlationId: record.correlationId,
    inventoryReservationId: reservation.id,
    capacitySeconds: record.reservedCapacitySeconds,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    confirmedOrderId: record.confirmedOrderId,
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    releasedAt: record.releasedAt?.toISOString() ?? null,
    releaseReason: record.releaseReason,
  };
}

async function loadHold(
  client: Prisma.TransactionClient | PrismaClient,
  holdId: string,
) {
  return client.walkingCapacityHold.findUnique({
    where: { id: holdId },
    include: holdInclude,
  });
}

async function setDeferredConstraintsImmediate(tx: Prisma.TransactionClient) {
  await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`);
}

async function databaseClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "databaseNow"`,
  );
  const now = rows[0]?.databaseNow;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("INVALID_DATABASE_CLOCK");
  }
  return now;
}

async function lockQuote(tx: Prisma.TransactionClient, input: AcquireCapacityHoldInput) {
  return tx.$queryRaw<LockedQuoteRow[]>(Prisma.sql`
    SELECT
      quote."id", quote."clientId", quote."externalSelectedLocationId",
      quote."selectedOperationalLocationId", quote."slotPolicyId",
      quote."capacityRequiredSeconds", quote."bookable", quote."expiresAt",
      quote."inventoryReadyAt", fee_version."holdTtlSeconds"
    FROM "WalkingDeliveryQuote" quote
    LEFT JOIN "FeeCalculationPolicyVersion" fee_version
      ON fee_version."id" = quote."feePolicyVersionId"
    WHERE quote."id" = CAST(${input.quoteId} AS UUID)
    FOR UPDATE OF quote
  `);
}

async function lockExistingHolds(tx: Prisma.TransactionClient, input: AcquireCapacityHoldInput) {
  return tx.$queryRaw<LockedHoldRow[]>(Prisma.sql`
    SELECT hold."id", hold."capacitySlotId", hold."clientId", hold."idempotencyKey",
           hold."requestHash", hold."status", hold."expiresAt"
    FROM "WalkingCapacityHold" hold
    WHERE (hold."clientId" = ${input.clientId} AND hold."idempotencyKey" = ${input.idempotencyKey})
       OR (hold."quoteId" = CAST(${input.quoteId} AS UUID)
           AND hold."status" IN ('HELD', 'CONFIRMED'))
    ORDER BY hold."id"
    FOR UPDATE
  `);
}

async function lockSlotsForAcquire(
  tx: Prisma.TransactionClient,
  slotPolicyId: string,
  slotKey: string,
  existingCapacitySlotIds: readonly string[],
) {
  const existingSlots = existingCapacitySlotIds.length > 0
    ? Prisma.sql`OR slot."id" IN (${Prisma.join(
        existingCapacitySlotIds.map((id) => Prisma.sql`CAST(${id} AS UUID)`),
      )})`
    : Prisma.empty;
  return tx.$queryRaw<LockedSlotRow[]>(Prisma.sql`
    SELECT slot."id", slot."slotPolicyId", slot."operationalLocationId", slot."slotKey",
           slot."startsAt", slot."endsAt", slot."capacitySeconds", slot."status"
    FROM "WalkingCapacitySlot" slot
    WHERE (slot."slotPolicyId" = CAST(${slotPolicyId} AS UUID)
      AND slot."slotKey" = ${slotKey})
      ${existingSlots}
    ORDER BY slot."id"
    FOR UPDATE
  `);
}

async function activeCapacity(
  tx: Prisma.TransactionClient,
  capacitySlotId: string,
  now: Date,
) {
  const rows = await tx.$queryRaw<ActiveCapacityRow[]>(Prisma.sql`
    SELECT COALESCE(SUM(hold."reservedCapacitySeconds"), 0)::BIGINT
      AS "reservedCapacitySeconds"
    FROM "WalkingCapacityHold" hold
    WHERE hold."capacitySlotId" = CAST(${capacitySlotId} AS UUID)
      AND (
        hold."status" = 'CONFIRMED' OR
        (hold."status" = 'HELD' AND hold."expiresAt" > ${now})
      )
  `);
  return BigInt(rows[0]?.reservedCapacitySeconds ?? 0);
}

async function lockCompatibleBalances(
  tx: Prisma.TransactionClient,
  lines: readonly LocalDeliveryInventoryLineEvidence[],
) {
  const physicalPredicates = lines.map((line) => Prisma.sql`
    (balance."productId" = CAST(${line.productId} AS UUID)
      AND balance."inventoryOwnerLocationId" = CAST(${line.inventoryOwnerLocationId} AS UUID)
      AND balance."inventoryNodeId" = CAST(${line.inventoryNodeId} AS UUID)
      AND balance."containerId" IS NOT DISTINCT FROM CAST(${line.containerId} AS UUID)
      AND balance."storageLocationId" IS NOT DISTINCT FROM CAST(${line.storageLocationId} AS UUID))
  `);
  return tx.$queryRaw<BalanceRow[]>(Prisma.sql`
    SELECT balance."id", balance."productId", balance."inventoryLotId",
           balance."inventoryOwnerLocationId", balance."inventoryNodeId",
           balance."containerId", balance."storageLocationId", balance."available"
    FROM "InventoryNodeBalance" balance
    JOIN "Product" product ON product."id" = balance."productId"
    JOIN "InventoryLedgerEntry" ledger ON ledger."sequence" = balance."ledgerSequence"
    WHERE (${Prisma.join(physicalPredicates, " OR ")})
      AND balance."available" > 0
      AND product."active" = true
      AND ledger."productId" = balance."productId"
      AND ledger."inventoryLotId" = balance."inventoryLotId"
      AND ledger."containerId" IS NOT DISTINCT FROM balance."containerId"
      AND ledger."toLocationId" = balance."inventoryNodeId"
      AND ledger."toStorageLocationId" IS NOT DISTINCT FROM balance."storageLocationId"
      AND ledger."metadata" ->> 'inventoryNodeBalanceId' = balance."id"::TEXT
    ORDER BY balance."id"
    FOR UPDATE OF balance
  `);
}

function quoteLinesMatch(
  storedLines: readonly {
    readonly lineNumber: number;
    readonly variantId: string;
    readonly productId: string | null;
    readonly quantity: number;
    readonly readinessStatus: string;
    readonly inventoryOwnerLocationId: string | null;
    readonly inventoryOwnerExternalLocationId: string | null;
    readonly inventoryNodeId: string | null;
    readonly inventoryNodeExternalId: string | null;
    readonly containerId: string | null;
    readonly storageLocationId: string | null;
    readonly transferStatus: string;
    readonly earliestReadyAt: Date | null;
  }[],
  inputLines: readonly LocalDeliveryInventoryLineEvidence[],
) {
  if (storedLines.length === 0 || storedLines.length !== inputLines.length) return false;
  const inputByLine = new Map(inputLines.map((line) => [line.lineNumber, line]));
  if (inputByLine.size !== inputLines.length) return false;
  return storedLines.every((stored, index) => {
    const input = inputByLine.get(stored.lineNumber);
    return Boolean(
      stored.lineNumber === index + 1 &&
      input &&
      input.variantId === stored.variantId &&
      input.productId === stored.productId &&
      input.quantity === stored.quantity &&
      input.readinessStatus === stored.readinessStatus &&
      input.inventoryOwnerLocationId === stored.inventoryOwnerLocationId &&
      input.inventoryOwnerExternalLocationId === stored.inventoryOwnerExternalLocationId &&
      input.inventoryNodeId === stored.inventoryNodeId &&
      input.inventoryNodeExternalId === stored.inventoryNodeExternalId &&
      sameNullable(input.containerId, stored.containerId) &&
      sameNullable(input.storageLocationId, stored.storageLocationId) &&
      input.transferStatus === stored.transferStatus &&
      (input.earliestReadyAt ? strictInstant(input.earliestReadyAt, "INVENTORY_READY_AT").getTime() : null) ===
        (stored.earliestReadyAt?.getTime() ?? null),
    );
  });
}

function validateAllocations(
  lines: readonly LocalDeliveryInventoryLineEvidence[],
  balances: readonly BalanceRow[],
  allocations: readonly LocalDeliveryInventoryBalanceAllocation[],
) {
  if (allocations.length !== lines.length) return null;
  const lineByNumber = new Map(lines.map((line) => [line.lineNumber, line]));
  const balanceById = new Map(balances.map((balance) => [balance.id, balance]));
  const selectedLines = new Set<number>();
  const selectedQuantity = new Map<string, Prisma.Decimal>();
  const result: Array<{ line: LocalDeliveryInventoryLineEvidence; balance: BalanceRow }> = [];

  for (const allocation of allocations) {
    const line = lineByNumber.get(allocation.lineNumber);
    const balance = balanceById.get(allocation.balanceId);
    if (
      !line ||
      !balance ||
      selectedLines.has(allocation.lineNumber) ||
      balance.productId !== line.productId ||
      balance.inventoryOwnerLocationId !== line.inventoryOwnerLocationId ||
      balance.inventoryNodeId !== line.inventoryNodeId ||
      !sameNullable(balance.containerId, line.containerId) ||
      !sameNullable(balance.storageLocationId, line.storageLocationId)
    ) {
      return null;
    }
    selectedLines.add(allocation.lineNumber);
    const quantity = (selectedQuantity.get(balance.id) ?? new Prisma.Decimal(0)).add(line.quantity);
    if (quantity.gt(new Prisma.Decimal(balance.available))) return null;
    selectedQuantity.set(balance.id, quantity);
    result.push({ line, balance });
  }
  return selectedLines.size === lines.length
    ? result.sort((left, right) => left.line.lineNumber - right.line.lineNumber)
    : null;
}

async function createTransitionAudit(
  tx: Prisma.TransactionClient,
  input: {
    readonly hold: HoldRecord;
    readonly correlationId: string;
    readonly action: string;
    readonly reason: string;
    readonly occurredAt: Date;
    readonly nextStatus: "CONFIRMED" | "RELEASED" | "EXPIRED";
  },
) {
  await tx.auditEvent.create({
    data: {
      action: input.action,
      entityType: "WalkingCapacityHold",
      entityId: input.hold.id,
      correlationId: input.correlationId,
      reason: input.reason,
      before: asInputJson({
        status: input.hold.status,
        version: input.hold.version,
        originalCorrelationId: input.hold.correlationId,
      }),
      after: asInputJson({
        status: input.nextStatus,
        inventoryReservationId: input.hold.inventoryReservations[0]?.id,
        transitionCorrelationId: input.correlationId,
      }),
      occurredAt: input.occurredAt,
    },
  });
}

async function updatePair(
  tx: Prisma.TransactionClient,
  record: HoldRecord,
  input:
    | {
        readonly status: "CONFIRMED";
        readonly now: Date;
        readonly orderId: string;
        readonly transitionCorrelationId: string;
      }
    | {
        readonly status: "RELEASED" | "EXPIRED";
        readonly now: Date;
        readonly reason: CapacityHoldReleaseReason;
        readonly transitionCorrelationId?: string;
      },
) {
  const reservation = record.inventoryReservations[0];
  if (!reservation || record.inventoryReservations.length !== 1 || reservation.status !== "HELD") {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_HOLD_RESERVATION_PAIR");
  }

  if (input.status === "CONFIRMED") {
    await tx.walkingCapacityHold.update({
      where: { id: record.id },
      data: {
        status: "CONFIRMED",
        confirmedOrderId: input.orderId,
        confirmedAt: input.now,
        version: { increment: 1 },
      },
    });
    await tx.walkingInventoryReservation.update({
      where: { id: reservation.id },
      data: {
        status: "CONFIRMED",
        confirmedOrderId: input.orderId,
        confirmedAt: input.now,
        version: { increment: 1 },
      },
    });
    await createTransitionAudit(tx, {
      hold: record,
      correlationId: input.transitionCorrelationId,
      action: "walking_delivery.capacity_hold.confirmed.transition_context",
      reason: input.orderId,
      occurredAt: input.now,
      nextStatus: "CONFIRMED",
    });
    return;
  }

  await tx.walkingCapacityHold.update({
    where: { id: record.id },
    data: {
      status: input.status,
      releasedAt: input.now,
      releaseReason: input.reason,
      version: { increment: 1 },
    },
  });
  await tx.walkingInventoryReservation.update({
    where: { id: reservation.id },
    data: {
      status: input.status,
      releasedAt: input.now,
      releaseReason: input.reason,
      version: { increment: 1 },
    },
  });
  if (input.transitionCorrelationId) {
    await createTransitionAudit(tx, {
      hold: record,
      correlationId: input.transitionCorrelationId,
      action: `walking_delivery.capacity_hold.${input.status.toLowerCase()}.transition_context`,
      reason: input.reason,
      occurredAt: input.now,
      nextStatus: input.status,
    });
  }
}

async function lockHoldById(
  tx: Prisma.TransactionClient,
  holdId: string,
  clientId?: string,
) {
  return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT hold."id"
    FROM "WalkingCapacityHold" hold
    WHERE hold."id" = CAST(${holdId} AS UUID)
      ${clientId ? Prisma.sql`AND hold."clientId" = ${clientId}` : Prisma.empty}
    FOR UPDATE
  `);
}

export class PrismaCapacityHoldStore implements CapacityHoldPort {
  private readonly allocationStrategyId: string;
  private readonly allocationStrategyVersion: string;

  constructor(
    private readonly allocationStrategy: LocalDeliveryInventoryAllocationStrategy,
    private readonly db: PrismaClient = prisma,
  ) {
    if (
      !stableDecisionId.test(allocationStrategy.strategyId) ||
      !stableDecisionId.test(allocationStrategy.strategyVersion)
    ) {
      throw new Error("VERSIONED_INVENTORY_ALLOCATION_STRATEGY_REQUIRED");
    }
    this.allocationStrategyId = allocationStrategy.strategyId;
    this.allocationStrategyVersion = allocationStrategy.strategyVersion;
  }

  async findByIdempotency(input: { clientId: string; idempotencyKey: string; now: string }) {
    strictInstant(input.now, "NOW");
    return serializable(this.db, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT hold."id"
        FROM "WalkingCapacityHold" hold
        WHERE hold."clientId" = ${input.clientId}
          AND hold."idempotencyKey" = ${input.idempotencyKey}
        FOR UPDATE
      `);
      const holdId = locked[0]?.id;
      if (!holdId) return null;
      const decisionNow = await databaseClock(tx);
      let record = await loadHold(tx, holdId);
      if (!record) throw new Error("LOCAL_DELIVERY_HOLD_LOCK_LOST");
      if (record.status === "HELD" && record.expiresAt.getTime() <= decisionNow.getTime()) {
        await updatePair(tx, record, {
          status: "EXPIRED",
          now: decisionNow,
          reason: "QUOTE_EXPIRED",
        });
        await setDeferredConstraintsImmediate(tx);
        record = await loadHold(tx, holdId);
        if (!record) throw new Error("LOCAL_DELIVERY_HOLD_EXPIRY_LOST");
      }
      return { requestHash: record.requestHash, hold: mapHold(record) };
    });
  }

  async acquire(input: AcquireCapacityHoldInput): Promise<AcquireCapacityHoldOutcome> {
    if (!uuid.test(input.quoteId)) return { kind: "INVENTORY_UNAVAILABLE" };
    strictInstant(input.createdAt, "HOLD_CREATED_AT");
    strictInstant(input.expiresAt, "HOLD_EXPIRES_AT");
    if (
      !Number.isSafeInteger(input.capacitySeconds) ||
      input.capacitySeconds <= 0 ||
      input.inventoryLines.length === 0
    ) {
      return { kind: "INSUFFICIENT_CAPACITY" };
    }

    try {
      return await serializable(this.db, async (tx) => {
        // Lock protocol: quote -> any existing hold -> slot -> compatible balances.
        const quote = (await lockQuote(tx, input))[0];
        if (!quote) return { kind: "INVENTORY_UNAVAILABLE" } as const;
        if (
          quote.clientId !== input.clientId ||
          quote.externalSelectedLocationId !== input.locationId ||
          !quote.selectedOperationalLocationId ||
          !quote.slotPolicyId ||
          quote.bookable !== true ||
          quote.capacityRequiredSeconds !== input.capacitySeconds ||
          !quote.expiresAt ||
          !quote.holdTtlSeconds
        ) {
          return { kind: "INVENTORY_UNAVAILABLE" } as const;
        }

        const lockedHolds = await lockExistingHolds(tx, input);
        const lockedSlots = await lockSlotsForAcquire(
          tx,
          quote.slotPolicyId,
          input.slotId,
          lockedHolds
            .filter(({ status }) => status === "HELD")
            .map(({ capacitySlotId }) => capacitySlotId),
        );
        const decisionNow = await databaseClock(tx);
        if (quote.expiresAt.getTime() <= decisionNow.getTime()) {
          throw new LocalDeliveryApplicationError("QUOTE_EXPIRED");
        }
        const slot = lockedSlots.find(
          (candidate) =>
            candidate.slotPolicyId === quote.slotPolicyId && candidate.slotKey === input.slotId,
        );
        const idempotent = lockedHolds.find(
          (hold) =>
            hold.clientId === input.clientId && hold.idempotencyKey === input.idempotencyKey,
        );
        if (idempotent) {
          if (idempotent.requestHash !== input.requestHash) {
            return { kind: "IDEMPOTENCY_CONFLICT" } as const;
          }
          let record = await loadHold(tx, idempotent.id);
          if (!record) throw new Error("LOCAL_DELIVERY_HOLD_LOCK_LOST");
          if (record.status === "HELD" && record.expiresAt <= decisionNow) {
            await updatePair(tx, record, {
              status: "EXPIRED",
              now: decisionNow,
              reason: "QUOTE_EXPIRED",
              transitionCorrelationId: input.correlationId,
            });
            await setDeferredConstraintsImmediate(tx);
            record = await loadHold(tx, idempotent.id);
            if (!record) throw new Error("LOCAL_DELIVERY_HOLD_EXPIRY_LOST");
          }
          return { kind: "REPLAY", hold: mapHold(record) } as const;
        }
        const expiredHolds = lockedHolds.filter(
          (hold) =>
            hold.status === "HELD" &&
            hold.expiresAt.getTime() <= decisionNow.getTime(),
        );
        for (const expiredHold of expiredHolds) {
          const expiredRecord = await loadHold(tx, expiredHold.id);
          if (!expiredRecord || expiredRecord.status !== "HELD") {
            throw new Error("LOCAL_DELIVERY_HOLD_LOCK_LOST");
          }
          await updatePair(tx, expiredRecord, {
            status: "EXPIRED",
            now: decisionNow,
            reason: "QUOTE_EXPIRED",
            transitionCorrelationId: input.correlationId,
          });
        }
        if (lockedHolds.some(
          (hold) =>
            hold.status === "CONFIRMED" ||
            (hold.status === "HELD" && hold.expiresAt > decisionNow),
        )) {
          // A different key already owns this quote. This is a hold-state
          // conflict, not an idempotency-key conflict.
          return { kind: "INSUFFICIENT_CAPACITY" } as const;
        }

        const orderIdentity = await tx.localDeliveryLocationIdentity.findUnique({
          where: { externalLocationId: input.orderLocationExternalId },
          include: { operationalLocation: true },
        });
        const deliveryIdentity = await tx.localDeliveryLocationIdentity.findUnique({
          where: { externalLocationId: input.locationId },
          include: { operationalLocation: true },
        });
        if (
          !orderIdentity?.active ||
          !orderIdentity.operationalLocation.active ||
          !deliveryIdentity?.active ||
          !deliveryIdentity.operationalLocation.active ||
          deliveryIdentity.operationalLocationId !== quote.selectedOperationalLocationId ||
          !stableDecisionId.test(input.orderLocationDecisionCode) ||
          !stableDecisionId.test(input.orderLocationDecisionVersion)
        ) {
          return { kind: "ORDER_LOCATION_UNAVAILABLE" } as const;
        }

        if (
          !slot ||
          slot.status !== "OPEN" ||
          slot.operationalLocationId !== deliveryIdentity.operationalLocationId ||
          slot.startsAt.getTime() <= decisionNow.getTime() ||
          (quote.inventoryReadyAt && slot.startsAt < quote.inventoryReadyAt)
        ) {
          return { kind: "INSUFFICIENT_CAPACITY" } as const;
        }
        const reservedCapacity = await activeCapacity(tx, slot.id, decisionNow);
        if (reservedCapacity + BigInt(input.capacitySeconds) > BigInt(slot.capacitySeconds)) {
          return { kind: "INSUFFICIENT_CAPACITY" } as const;
        }

        const storedLines = await tx.walkingDeliveryQuoteInventoryLine.findMany({
          where: { quoteId: quote.id },
          orderBy: { lineNumber: "asc" },
          select: {
            lineNumber: true,
            variantId: true,
            productId: true,
            quantity: true,
            readinessStatus: true,
            inventoryOwnerLocationId: true,
            inventoryOwnerExternalLocationId: true,
            inventoryNodeId: true,
            inventoryNodeExternalId: true,
            containerId: true,
            storageLocationId: true,
            transferStatus: true,
            earliestReadyAt: true,
          },
        });
        if (!quoteLinesMatch(storedLines, input.inventoryLines)) {
          return { kind: "INVENTORY_UNAVAILABLE" } as const;
        }

        const balances = await lockCompatibleBalances(tx, input.inventoryLines);
        const candidates = balances.map((balance) => ({
          balanceId: balance.id,
          productId: balance.productId,
          inventoryLotId: balance.inventoryLotId,
          inventoryOwnerLocationId: balance.inventoryOwnerLocationId,
          inventoryNodeId: balance.inventoryNodeId,
          containerId: balance.containerId,
          storageLocationId: balance.storageLocationId,
          availableQuantity: new Prisma.Decimal(balance.available).toString(),
        }));
        const requestedAllocations = this.allocationStrategy.allocate({
          quoteId: input.quoteId,
          lines: input.inventoryLines.map((line) => ({ ...line })),
          candidates,
        });
        const allocations = validateAllocations(
          input.inventoryLines,
          balances,
          requestedAllocations,
        );
        if (!allocations) return { kind: "INVENTORY_UNAVAILABLE" } as const;

        // Allocation is pure/synchronous. Capture a fresh wall clock only after
        // every balance lock and the final capacity read, immediately before
        // persistence, then revalidate all time-sensitive decisions.
        const finalReservedCapacity = await activeCapacity(tx, slot.id, decisionNow);
        const finalNow = await databaseClock(tx);
        if (quote.expiresAt.getTime() <= finalNow.getTime()) {
          throw new LocalDeliveryApplicationError("QUOTE_EXPIRED");
        }
        if (
          slot.status !== "OPEN" ||
          slot.startsAt.getTime() <= finalNow.getTime() ||
          (quote.inventoryReadyAt && slot.startsAt < quote.inventoryReadyAt)
        ) {
          return { kind: "INSUFFICIENT_CAPACITY" } as const;
        }
        if (finalReservedCapacity + BigInt(input.capacitySeconds) > BigInt(slot.capacitySeconds)) {
          return { kind: "INSUFFICIENT_CAPACITY" } as const;
        }
        const createdAt = finalNow;
        const expiresAt = new Date(Math.min(
          quote.expiresAt.getTime(),
          finalNow.getTime() + quote.holdTtlSeconds * 1_000,
        ));

        const createdHold = await tx.walkingCapacityHold.create({
          data: {
            quoteId: input.quoteId,
            capacitySlotId: slot.id,
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            correlationId: input.correlationId,
            status: "HELD",
            reservedCapacitySeconds: input.capacitySeconds,
            expiresAt,
            createdAt,
          },
          select: { id: true },
        });
        const reservation = await tx.walkingInventoryReservation.create({
          data: {
            quoteId: input.quoteId,
            capacityHoldId: createdHold.id,
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            correlationId: input.correlationId,
            status: "HELD",
            orderLocationId: orderIdentity.operationalLocationId,
            deliveryLocationId: deliveryIdentity.operationalLocationId,
            orderLocationExternalId: orderIdentity.externalLocationId,
            deliveryLocationExternalId: deliveryIdentity.externalLocationId,
            orderLocationDecisionCode: input.orderLocationDecisionCode,
            orderLocationDecisionVersion: input.orderLocationDecisionVersion,
            inventoryAllocationStrategyId: this.allocationStrategyId,
            inventoryAllocationStrategyVersion: this.allocationStrategyVersion,
            expiresAt,
            createdAt,
          },
          select: { id: true },
        });
        await tx.walkingInventoryReservationLine.createMany({
          data: allocations.map(({ line, balance }) => ({
            reservationId: reservation.id,
            inventoryNodeBalanceId: balance.id,
            lineNumber: line.lineNumber,
            variantId: line.variantId,
            productId: balance.productId,
            inventoryLotId: balance.inventoryLotId,
            quantity: line.quantity,
            inventoryOwnerLocationId: balance.inventoryOwnerLocationId,
            inventoryNodeId: balance.inventoryNodeId,
            containerId: balance.containerId,
            storageLocationId: balance.storageLocationId,
            transferStatus: line.transferStatus,
            createdAt,
          })),
        });
        await setDeferredConstraintsImmediate(tx);
        const stored = await loadHold(tx, createdHold.id);
        if (!stored) throw new Error("LOCAL_DELIVERY_HOLD_COMMIT_LOST");
        return { kind: "ACQUIRED", hold: mapHold(stored) } as const;
      });
    } catch (error) {
      if (!isP2002(error)) throw error;
      const existing = await this.db.walkingCapacityHold.findUnique({
        where: {
          clientId_idempotencyKey: {
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: holdInclude,
      });
      if (!existing) throw error;
      return existing.requestHash === input.requestHash
        ? { kind: "REPLAY", hold: mapHold(existing) }
        : { kind: "IDEMPOTENCY_CONFLICT" };
    }
  }

  async confirm(input: {
    clientId: string;
    correlationId: string;
    holdId: string;
    orderId: string;
    now: string;
  }): Promise<TransitionCapacityHoldOutcome> {
    if (!uuid.test(input.holdId)) return { kind: "NOT_FOUND" };
    strictInstant(input.now, "NOW");
    return serializable(this.db, async (tx) => {
      if ((await lockHoldById(tx, input.holdId, input.clientId)).length === 0) {
        return { kind: "NOT_FOUND" } as const;
      }
      const decisionNow = await databaseClock(tx);
      let record = await loadHold(tx, input.holdId);
      if (!record) return { kind: "NOT_FOUND" } as const;
      if (record.status === "CONFIRMED") {
        return record.confirmedOrderId === input.orderId
          ? { kind: "UNCHANGED", hold: mapHold(record) } as const
          : { kind: "INVALID_STATE" } as const;
      }
      if (record.status !== "HELD") return { kind: "INVALID_STATE" } as const;
      if (record.expiresAt.getTime() <= decisionNow.getTime()) {
        await updatePair(tx, record, {
          status: "EXPIRED",
          now: decisionNow,
          reason: "QUOTE_EXPIRED",
          transitionCorrelationId: input.correlationId,
        });
        await setDeferredConstraintsImmediate(tx);
        return { kind: "INVALID_STATE" } as const;
      }
      await updatePair(tx, record, {
        status: "CONFIRMED",
        now: decisionNow,
        orderId: input.orderId,
        transitionCorrelationId: input.correlationId,
      });
      await setDeferredConstraintsImmediate(tx);
      record = await loadHold(tx, input.holdId);
      if (!record) throw new Error("LOCAL_DELIVERY_HOLD_TRANSITION_LOST");
      return { kind: "UPDATED", hold: mapHold(record) } as const;
    });
  }

  async release(input: {
    clientId: string;
    correlationId: string;
    holdId: string;
    reason: CapacityHoldReleaseReason;
    now: string;
  }): Promise<TransitionCapacityHoldOutcome> {
    if (!uuid.test(input.holdId)) return { kind: "NOT_FOUND" };
    strictInstant(input.now, "NOW");
    return serializable(this.db, async (tx) => {
      if ((await lockHoldById(tx, input.holdId, input.clientId)).length === 0) {
        return { kind: "NOT_FOUND" } as const;
      }
      const decisionNow = await databaseClock(tx);
      let record = await loadHold(tx, input.holdId);
      if (!record) return { kind: "NOT_FOUND" } as const;
      if (record.status === "RELEASED") {
        return record.releaseReason === input.reason
          ? { kind: "UNCHANGED", hold: mapHold(record) } as const
          : { kind: "INVALID_STATE" } as const;
      }
      if (record.status === "EXPIRED") {
        return { kind: "UNCHANGED", hold: mapHold(record) } as const;
      }
      if (record.status === "CONFIRMED") return { kind: "INVALID_STATE" } as const;
      const expired = record.expiresAt.getTime() <= decisionNow.getTime();
      await updatePair(tx, record, expired
        ? {
            status: "EXPIRED",
            now: decisionNow,
            reason: "QUOTE_EXPIRED",
            transitionCorrelationId: input.correlationId,
          }
        : {
            status: "RELEASED",
            now: decisionNow,
            reason: input.reason,
            transitionCorrelationId: input.correlationId,
          });
      await setDeferredConstraintsImmediate(tx);
      record = await loadHold(tx, input.holdId);
      if (!record) throw new Error("LOCAL_DELIVERY_HOLD_TRANSITION_LOST");
      return { kind: "UPDATED", hold: mapHold(record) } as const;
    });
  }

  async expireDue(input: ExpireDueCapacityHoldsInput) {
    strictInstant(input.now, "NOW");
    const batchSize = input.batchSize ?? defaultExpiryBatchSize;
    if (
      !stableDecisionId.test(input.correlationId) ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 500
    ) {
      throw new Error("INVALID_EXPIRY_BATCH");
    }
    return serializable(this.db, async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT hold."id"
        FROM "WalkingCapacityHold" hold
        WHERE hold."status" = 'HELD' AND hold."expiresAt" <= clock_timestamp()
        ORDER BY hold."capacitySlotId", hold."id", hold."expiresAt"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `);
      const decisionNow = await databaseClock(tx);
      let expiredCount = 0;
      for (const { id } of due) {
        const record = await loadHold(tx, id);
        if (!record || record.status !== "HELD" || record.expiresAt > decisionNow) continue;
        await updatePair(tx, record, {
          status: "EXPIRED",
          now: decisionNow,
          reason: "QUOTE_EXPIRED",
          transitionCorrelationId: input.correlationId,
        });
        expiredCount += 1;
      }
      if (expiredCount > 0) await setDeferredConstraintsImmediate(tx);
      return expiredCount;
    });
  }
}
