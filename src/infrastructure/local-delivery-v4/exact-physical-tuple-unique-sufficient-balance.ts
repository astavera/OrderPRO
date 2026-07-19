import "server-only";

import { Prisma } from "@prisma/client";
import type { LocalDeliveryInventoryLineEvidence } from "../../application/local-delivery-v4/contracts";
import type {
  LocalDeliveryInventoryAllocationStrategy,
  LocalDeliveryInventoryBalanceAllocation,
  LocalDeliveryInventoryBalanceCandidate,
} from "./prisma-capacity-hold-store";

export const EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_ID =
  "exact_physical_tuple_unique_sufficient_balance";
export const EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_VERSION = "v1";

type PhysicalTuple = Pick<
  LocalDeliveryInventoryLineEvidence,
  | "productId"
  | "inventoryOwnerLocationId"
  | "inventoryNodeId"
  | "containerId"
  | "storageLocationId"
>;

type LineGroup = {
  readonly tuple: PhysicalTuple;
  readonly lines: LocalDeliveryInventoryLineEvidence[];
  totalQuantity: Prisma.Decimal;
};

function physicalTupleKey(tuple: PhysicalTuple) {
  return JSON.stringify([
    tuple.productId,
    tuple.inventoryOwnerLocationId,
    tuple.inventoryNodeId,
    tuple.containerId,
    tuple.storageLocationId,
  ]);
}

function exactNonnegativeDecimal(value: string) {
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() && decimal.greaterThanOrEqualTo(0) ? decimal : null;
  } catch {
    return null;
  }
}

function validLine(line: LocalDeliveryInventoryLineEvidence) {
  return (
    Number.isSafeInteger(line.lineNumber) &&
    line.lineNumber > 0 &&
    Number.isSafeInteger(line.quantity) &&
    line.quantity > 0 &&
    line.productId.length > 0 &&
    line.inventoryOwnerLocationId.length > 0 &&
    line.inventoryNodeId.length > 0 &&
    (line.containerId !== null || line.storageLocationId !== null)
  );
}

function validCandidate(candidate: LocalDeliveryInventoryBalanceCandidate) {
  return (
    candidate.balanceId.length > 0 &&
    candidate.productId.length > 0 &&
    candidate.inventoryLotId.length > 0 &&
    candidate.inventoryOwnerLocationId.length > 0 &&
    candidate.inventoryNodeId.length > 0 &&
    (candidate.containerId !== null || candidate.storageLocationId !== null)
  );
}

function candidateMatchesGroup(
  candidate: LocalDeliveryInventoryBalanceCandidate,
  group: LineGroup,
) {
  return physicalTupleKey(candidate) === physicalTupleKey(group.tuple);
}

/**
 * A deliberately conservative first allocation policy. It makes no FIFO,
 * FEFO, lot-age, box-order or UUID-priority decision. A physical tuple is
 * allocated only when exactly one compatible balance can individually cover
 * its aggregate quoted quantity. Ambiguous or insufficient input returns an
 * empty allocation, which the Prisma adapter rejects before writing.
 */
export const exactPhysicalTupleUniqueSufficientBalanceStrategy = Object.freeze({
  strategyId: EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_ID,
  strategyVersion: EXACT_PHYSICAL_TUPLE_UNIQUE_SUFFICIENT_BALANCE_STRATEGY_VERSION,
  allocate(input): readonly LocalDeliveryInventoryBalanceAllocation[] {
    if (input.lines.length === 0 || input.candidates.length === 0) return [];

    const lineNumbers = new Set<number>();
    const groups = new Map<string, LineGroup>();
    for (const line of input.lines) {
      if (!validLine(line) || lineNumbers.has(line.lineNumber)) return [];
      lineNumbers.add(line.lineNumber);

      const key = physicalTupleKey(line);
      const group = groups.get(key);
      const quantity = new Prisma.Decimal(line.quantity.toString());
      if (group) {
        group.lines.push(line);
        group.totalQuantity = group.totalQuantity.plus(quantity);
      } else {
        groups.set(key, {
          tuple: {
            productId: line.productId,
            inventoryOwnerLocationId: line.inventoryOwnerLocationId,
            inventoryNodeId: line.inventoryNodeId,
            containerId: line.containerId,
            storageLocationId: line.storageLocationId,
          },
          lines: [line],
          totalQuantity: quantity,
        });
      }
    }

    const balanceIds = new Set<string>();
    const parsedCandidates: Array<{
      readonly candidate: LocalDeliveryInventoryBalanceCandidate;
      readonly availableQuantity: Prisma.Decimal;
    }> = [];
    for (const candidate of input.candidates) {
      const availableQuantity = exactNonnegativeDecimal(candidate.availableQuantity);
      if (
        !validCandidate(candidate) ||
        !availableQuantity ||
        balanceIds.has(candidate.balanceId)
      ) {
        return [];
      }
      balanceIds.add(candidate.balanceId);
      parsedCandidates.push({ candidate, availableQuantity });
    }

    const allocations: LocalDeliveryInventoryBalanceAllocation[] = [];
    for (const group of groups.values()) {
      const sufficient = parsedCandidates.filter(
        ({ candidate, availableQuantity }) =>
          candidateMatchesGroup(candidate, group) &&
          availableQuantity.greaterThanOrEqualTo(group.totalQuantity),
      );
      if (sufficient.length !== 1) return [];

      const balanceId = sufficient[0]!.candidate.balanceId;
      for (const line of group.lines) {
        allocations.push({ lineNumber: line.lineNumber, balanceId });
      }
    }

    return allocations.sort((left, right) => left.lineNumber - right.lineNumber);
  },
} satisfies LocalDeliveryInventoryAllocationStrategy);
