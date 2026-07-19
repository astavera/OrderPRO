import { createHash } from "node:crypto";
import {
  LocalDeliveryApplicationError,
  type LocalDeliveryInventoryLineEvidence,
  type LocalDeliveryQuoteStorePort,
} from "./contracts";

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type CapacityHoldStatus = "HELD" | "CONFIRMED" | "RELEASED" | "EXPIRED";
export type CapacityHoldReleaseReason =
  | "QUOTE_EXPIRED"
  | "ORDER_CANCELLED"
  | "PAYMENT_FAILED"
  | "INVENTORY_UNAVAILABLE"
  | "CAPACITY_UNAVAILABLE"
  | "MANUAL";

export type LocalDeliveryOrderLocationDecision = {
  readonly orderLocationExternalId: string;
  readonly decisionCode: string;
  readonly decisionVersion: string;
};

export interface LocalDeliveryOrderLocationPort {
  resolve(input: {
    readonly clientId: string;
    readonly quoteId: string;
    readonly deliveryLocationId: string;
    readonly inventoryLines: readonly LocalDeliveryInventoryLineEvidence[];
    readonly calculatedAt: string;
    readonly correlationId: string;
  }): Promise<LocalDeliveryOrderLocationDecision | null>;
}

export type CapacityHold = {
  readonly capacityHoldId: string;
  readonly quoteId: string;
  readonly slotId: string;
  readonly locationId: string;
  readonly clientId: string;
  readonly correlationId: string;
  readonly inventoryReservationId: string;
  readonly capacitySeconds: number;
  readonly status: CapacityHoldStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly confirmedOrderId: string | null;
  readonly confirmedAt: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: CapacityHoldReleaseReason | null;
};

export type CapacityHoldResult = {
  readonly hold: CapacityHold;
  readonly replayed: boolean;
};

export type AcquireCapacityHoldInput = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
  readonly orderLocationExternalId: string;
  readonly orderLocationDecisionCode: string;
  readonly orderLocationDecisionVersion: string;
  readonly quoteId: string;
  readonly slotId: string;
  readonly locationId: string;
  readonly capacitySeconds: number;
  readonly inventoryLines: readonly LocalDeliveryInventoryLineEvidence[];
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type AcquireCapacityHoldOutcome =
  | { readonly kind: "ACQUIRED"; readonly hold: CapacityHold }
  | { readonly kind: "REPLAY"; readonly hold: CapacityHold }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "INSUFFICIENT_CAPACITY" }
  | { readonly kind: "INVENTORY_UNAVAILABLE" }
  | { readonly kind: "ORDER_LOCATION_UNAVAILABLE" };

export type TransitionCapacityHoldOutcome =
  | { readonly kind: "UPDATED" | "UNCHANGED"; readonly hold: CapacityHold }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "INVALID_STATE" };

export interface CapacityHoldPort {
  findByIdempotency(input: {
    clientId: string;
    idempotencyKey: string;
    now: string;
  }): Promise<{ readonly requestHash: string; readonly hold: CapacityHold } | null>;
  acquire(input: AcquireCapacityHoldInput): Promise<AcquireCapacityHoldOutcome>;
  confirm(input: {
    clientId: string;
    correlationId: string;
    holdId: string;
    orderId: string;
    now: string;
  }): Promise<TransitionCapacityHoldOutcome>;
  release(input: {
    clientId: string;
    correlationId: string;
    holdId: string;
    reason: CapacityHoldReleaseReason;
    now: string;
  }): Promise<TransitionCapacityHoldOutcome>;
}

export type CreateCapacityHoldCommand = {
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly quoteId: string;
  readonly slotId: string;
};

type CapacityHoldActorCommand = {
  readonly clientId: string;
  readonly correlationId: string;
  readonly holdId: string;
};

export type ConfirmCapacityHoldCommand = CapacityHoldActorCommand & {
  readonly action: "confirm";
  readonly orderId: string;
};

export type ReleaseCapacityHoldCommand = CapacityHoldActorCommand & {
  readonly action: "release";
  readonly reason: Extract<
    CapacityHoldReleaseReason,
    "ORDER_CANCELLED" | "PAYMENT_FAILED" | "MANUAL"
  >;
};

export type TransitionCapacityHoldCommand =
  | ConfirmCapacityHoldCommand
  | ReleaseCapacityHoldCommand;

export type CapacityHoldDependencies = {
  readonly quotes: LocalDeliveryQuoteStorePort;
  readonly holds: CapacityHoldPort;
  readonly orderLocations: LocalDeliveryOrderLocationPort;
  readonly now?: () => Date;
};

function holdRequestHash(command: CreateCapacityHoldCommand) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({
      clientId: command.clientId,
      quoteId: command.quoteId,
      slotId: command.slotId,
    }))
    .digest("hex")}`;
}

function validCreateCommand(command: CreateCapacityHoldCommand) {
  return (
    stableId.test(command.clientId) &&
    command.clientId.length <= 120 &&
    stableId.test(command.correlationId) &&
    command.correlationId.length <= 120 &&
    command.idempotencyKey.length >= 8 &&
    command.idempotencyKey.length <= 160 &&
    stableId.test(command.quoteId) &&
    command.quoteId.length <= 160 &&
    stableId.test(command.slotId) &&
    command.slotId.length <= 160
  );
}

function validTransitionCommand(command: TransitionCapacityHoldCommand) {
  return (
    stableId.test(command.clientId) &&
    command.clientId.length <= 120 &&
    stableId.test(command.correlationId) &&
    command.correlationId.length <= 120 &&
    stableId.test(command.holdId) &&
    command.holdId.length <= 160 &&
    (command.action === "confirm"
      ? stableId.test(command.orderId) && command.orderId.length <= 160
      : ["ORDER_CANCELLED", "PAYMENT_FAILED", "MANUAL"].includes(command.reason))
  );
}

export async function createCapacityHold(
  command: CreateCapacityHoldCommand,
  dependencies: CapacityHoldDependencies,
): Promise<CapacityHoldResult> {
  if (
    !validCreateCommand(command)
  ) {
    throw new LocalDeliveryApplicationError("INVALID_REQUEST");
  }

  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const requestHash = holdRequestHash(command);
  const existing = await dependencies.holds.findByIdempotency({
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
    now,
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new LocalDeliveryApplicationError("IDEMPOTENCY_CONFLICT");
    }
    return { hold: existing.hold, replayed: true };
  }

  const storedQuote = await dependencies.quotes.findById(command.quoteId);
  if (
    !storedQuote ||
    storedQuote.clientId !== command.clientId ||
    !storedQuote.quote.eligible ||
    !storedQuote.quote.bookable
  ) {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  if (
    storedQuote.persistencePlan.kind !== "OFFER" ||
    !Number.isInteger(storedQuote.persistencePlan.holdTtlSeconds) ||
    storedQuote.persistencePlan.holdTtlSeconds < 30 ||
    storedQuote.persistencePlan.holdTtlSeconds > 3_600 ||
    !Number.isSafeInteger(storedQuote.quote.requiredCapacitySeconds) ||
    storedQuote.quote.requiredCapacitySeconds <= 0 ||
    storedQuote.persistencePlan.inventoryLines.length === 0 ||
    storedQuote.persistencePlan.inventoryLines.some(
      (line) =>
        !stableId.test(line.variantId) ||
        line.variantId.length > 160 ||
        !Number.isInteger(line.quantity) ||
        line.quantity <= 0,
    )
  ) {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  if (Date.parse(storedQuote.quote.expiresAt) <= Date.parse(now)) {
    throw new LocalDeliveryApplicationError("QUOTE_EXPIRED");
  }
  const slot = storedQuote.quote.availableSlots.find(({ slotId }) => slotId === command.slotId);
  if (!slot || slot.locationId !== storedQuote.quote.selectedLocationId) {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }

  let orderLocation: LocalDeliveryOrderLocationDecision | null;
  try {
    orderLocation = await dependencies.orderLocations.resolve({
      clientId: command.clientId,
      quoteId: command.quoteId,
      deliveryLocationId: storedQuote.quote.selectedLocationId,
      inventoryLines: storedQuote.persistencePlan.inventoryLines,
      calculatedAt: now,
      correlationId: command.correlationId,
    });
  } catch {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  if (
    !orderLocation ||
    !stableId.test(orderLocation.orderLocationExternalId) ||
    orderLocation.orderLocationExternalId.length > 64 ||
    !stableId.test(orderLocation.decisionCode) ||
    orderLocation.decisionCode.length > 120 ||
    !stableId.test(orderLocation.decisionVersion) ||
    orderLocation.decisionVersion.length > 120
  ) {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }

  const expiresAt = new Date(
    Math.min(
      Date.parse(storedQuote.quote.expiresAt),
      Date.parse(now) + storedQuote.persistencePlan.holdTtlSeconds * 1_000,
    ),
  ).toISOString();
  const outcome = await dependencies.holds.acquire({
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
    requestHash,
    correlationId: command.correlationId,
    orderLocationExternalId: orderLocation.orderLocationExternalId,
    orderLocationDecisionCode: orderLocation.decisionCode,
    orderLocationDecisionVersion: orderLocation.decisionVersion,
    quoteId: command.quoteId,
    slotId: command.slotId,
    locationId: storedQuote.quote.selectedLocationId,
    capacitySeconds: storedQuote.quote.requiredCapacitySeconds,
    inventoryLines: storedQuote.persistencePlan.inventoryLines,
    createdAt: now,
    expiresAt,
  });
  if (outcome.kind === "IDEMPOTENCY_CONFLICT") {
    throw new LocalDeliveryApplicationError("IDEMPOTENCY_CONFLICT");
  }
  if (outcome.kind === "INSUFFICIENT_CAPACITY") {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  if (outcome.kind === "INVENTORY_UNAVAILABLE") {
    throw new LocalDeliveryApplicationError("INVENTORY_NOT_READY");
  }
  if (outcome.kind === "ORDER_LOCATION_UNAVAILABLE") {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  return { hold: outcome.hold, replayed: outcome.kind === "REPLAY" };
}

async function transitionCapacityHold(
  command: TransitionCapacityHoldCommand,
  dependencies: Pick<CapacityHoldDependencies, "holds" | "now">,
) {
  if (!validTransitionCommand(command)) {
    throw new LocalDeliveryApplicationError("INVALID_REQUEST");
  }
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const outcome = command.action === "confirm"
    ? await dependencies.holds.confirm({
        clientId: command.clientId,
        correlationId: command.correlationId,
        holdId: command.holdId,
        orderId: command.orderId,
        now,
      })
    : await dependencies.holds.release({
        clientId: command.clientId,
        correlationId: command.correlationId,
        holdId: command.holdId,
        reason: command.reason,
        now,
      });
  if (outcome.kind === "NOT_FOUND" || outcome.kind === "INVALID_STATE") {
    throw new LocalDeliveryApplicationError("CAPACITY_HOLD_FAILED");
  }
  return { hold: outcome.hold, changed: outcome.kind === "UPDATED" } as const;
}

export function confirmCapacityHold(
  command: ConfirmCapacityHoldCommand,
  dependencies: Pick<CapacityHoldDependencies, "holds" | "now">,
) {
  return transitionCapacityHold(command, dependencies);
}

export function releaseCapacityHold(
  command: ReleaseCapacityHoldCommand,
  dependencies: Pick<CapacityHoldDependencies, "holds" | "now">,
) {
  return transitionCapacityHold(command, dependencies);
}
