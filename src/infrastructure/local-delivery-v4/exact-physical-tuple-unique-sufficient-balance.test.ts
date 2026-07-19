import { describe, expect, it, vi } from "vitest";
import type { LocalDeliveryInventoryLineEvidence } from "../../application/local-delivery-v4/contracts";
import type { LocalDeliveryInventoryBalanceCandidate } from "./prisma-capacity-hold-store";

vi.mock("server-only", () => ({}));

import {
  EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_ID,
  EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_VERSION,
  exactPhysicalTupleUniqueSufficientBalanceStrategy,
} from "./exact-physical-tuple-unique-sufficient-balance";

const productId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const nodeId = "00000000-0000-4000-8000-000000000003";
const containerId = "00000000-0000-4000-8000-000000000004";
const storageLocationId = "00000000-0000-4000-8000-000000000005";

function line(
  overrides: Partial<LocalDeliveryInventoryLineEvidence> = {},
): LocalDeliveryInventoryLineEvidence {
  return {
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
    ...overrides,
  };
}

function candidate(
  balanceId: string,
  overrides: Partial<LocalDeliveryInventoryBalanceCandidate> = {},
): LocalDeliveryInventoryBalanceCandidate {
  return {
    balanceId,
    productId,
    inventoryLotId: `lot-${balanceId}`,
    inventoryOwnerLocationId: ownerId,
    inventoryNodeId: nodeId,
    containerId,
    storageLocationId: null,
    availableQuantity: "1",
    ...overrides,
  };
}

function allocate(
  lines: readonly LocalDeliveryInventoryLineEvidence[],
  candidates: readonly LocalDeliveryInventoryBalanceCandidate[],
) {
  return exactPhysicalTupleUniqueSufficientBalanceStrategy.allocate({
    quoteId: "quote-1",
    lines,
    candidates,
  });
}

describe("exactPhysicalTupleUniqueSufficientBalanceStrategy", () => {
  it("exposes an immutable, explicitly identified v1 strategy", () => {
    expect(exactPhysicalTupleUniqueSufficientBalanceStrategy).toMatchObject({
      strategyId: EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_ID,
      strategyVersion: EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_VERSION,
    });
    expect(exactPhysicalTupleUniqueSufficientBalanceStrategy.strategyId).toBe(
      "exact_physical_tuple_unique_sufficient_balance",
    );
    expect(exactPhysicalTupleUniqueSufficientBalanceStrategy.strategyVersion).toBe("v1");
    expect(Object.isFrozen(exactPhysicalTupleUniqueSufficientBalanceStrategy)).toBe(true);
  });

  it("selects the only compatible balance that individually covers the line", () => {
    expect(allocate([line()], [candidate("balance-1")])).toEqual([
      { lineNumber: 1, balanceId: "balance-1" },
    ]);
  });

  it("aggregates lines sharing the exact physical tuple and sorts the output", () => {
    const result = allocate(
      [line({ lineNumber: 2, quantity: 1 }), line({ lineNumber: 1, quantity: 2 })],
      [candidate("balance-1", { availableQuantity: "3" })],
    );

    expect(result).toEqual([
      { lineNumber: 1, balanceId: "balance-1" },
      { lineNumber: 2, balanceId: "balance-1" },
    ]);
  });

  it("allocates multiple independent physical tuples only when each is unambiguous", () => {
    const otherProductId = "00000000-0000-4000-8000-000000000006";
    const otherContainerId = "00000000-0000-4000-8000-000000000007";
    const result = allocate(
      [
        line(),
        line({
          lineNumber: 2,
          variantId: "variant-2",
          productId: otherProductId,
          containerId: otherContainerId,
        }),
      ],
      [
        candidate("balance-1"),
        candidate("balance-2", {
          productId: otherProductId,
          inventoryLotId: "lot-2",
          containerId: otherContainerId,
        }),
      ],
    );

    expect(result).toEqual([
      { lineNumber: 1, balanceId: "balance-1" },
      { lineNumber: 2, balanceId: "balance-2" },
    ]);
  });

  it("uses exact decimal comparison instead of IEEE-754 number rounding", () => {
    const result = allocate(
      [line({ quantity: 2 })],
      [
        candidate("just-under", {
          availableQuantity: "1.999999999999999999999999999999999999",
        }),
        candidate("just-over", {
          availableQuantity: "2.000000000000000000000000000000000001",
        }),
      ],
    );

    expect(result).toEqual([{ lineNumber: 1, balanceId: "just-over" }]);
  });

  it("fails closed instead of splitting a group across insufficient balances", () => {
    expect(allocate(
      [line({ quantity: 3 })],
      [
        candidate("balance-1", { availableQuantity: "2" }),
        candidate("balance-2", { availableQuantity: "1" }),
      ],
    )).toEqual([]);
  });

  it("fails closed when no compatible balance exists", () => {
    expect(allocate(
      [line()],
      [candidate("wrong-product", {
        productId: "00000000-0000-4000-8000-000000000099",
      })],
    )).toEqual([]);
  });

  it("fails closed when two compatible balances can each cover the group", () => {
    expect(allocate(
      [line()],
      [candidate("balance-1"), candidate("balance-2")],
    )).toEqual([]);
  });

  it("matches every field of the physical tuple exactly", () => {
    const result = allocate(
      [line()],
      [
        candidate("wrong-product", { productId: `${productId}-other` }),
        candidate("wrong-owner", { inventoryOwnerLocationId: `${ownerId}-other` }),
        candidate("wrong-node", { inventoryNodeId: `${nodeId}-other` }),
        candidate("wrong-container", { containerId: `${containerId}-other` }),
        candidate("wrong-storage", { storageLocationId }),
        candidate("exact"),
      ],
    );

    expect(result).toEqual([{ lineNumber: 1, balanceId: "exact" }]);
  });

  it("is independent of line and candidate input order", () => {
    const lines = [line({ lineNumber: 1 }), line({ lineNumber: 2 })];
    const candidates = [
      candidate("insufficient", { availableQuantity: "1" }),
      candidate("sufficient", { availableQuantity: "2" }),
    ];

    const forward = allocate(lines, candidates);
    const reversed = allocate([...lines].reverse(), [...candidates].reverse());

    expect(forward).toEqual([
      { lineNumber: 1, balanceId: "sufficient" },
      { lineNumber: 2, balanceId: "sufficient" },
    ]);
    expect(reversed).toEqual(forward);
  });

  it.each(["NaN", "Infinity", "-1", "not-a-decimal"])(
    "fails closed for malformed or negative availability %s",
    (availableQuantity) => {
      expect(allocate([line()], [candidate("balance-1", { availableQuantity })])).toEqual([]);
    },
  );

  it("fails closed for duplicate identities or invalid line quantities", () => {
    expect(allocate(
      [line()],
      [candidate("duplicate"), candidate("duplicate")],
    )).toEqual([]);
    expect(allocate(
      [line(), line({ lineNumber: 1 })],
      [candidate("balance-1", { availableQuantity: "2" })],
    )).toEqual([]);
    expect(allocate(
      [line({ quantity: 1.5 })],
      [candidate("balance-1", { availableQuantity: "2" })],
    )).toEqual([]);
  });

  it("is synchronous, pure, and does not mutate frozen inputs", () => {
    const lines = Object.freeze([Object.freeze(line())]);
    const candidates = Object.freeze([Object.freeze(candidate("balance-1"))]);
    const before = JSON.stringify({ lines, candidates });

    const result = exactPhysicalTupleUniqueSufficientBalanceStrategy.allocate({
      quoteId: "quote-1",
      lines,
      candidates,
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual([{ lineNumber: 1, balanceId: "balance-1" }]);
    expect(JSON.stringify({ lines, candidates })).toBe(before);
  });
});
