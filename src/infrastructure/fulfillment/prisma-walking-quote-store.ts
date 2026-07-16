import "server-only";

import { Prisma } from "@prisma/client";
import {
  WalkingQuoteEvaluationError,
  type PersistWalkingQuoteInput,
  type WalkingQuoteResult,
  type WalkingQuoteSlot,
  type WalkingQuoteStore,
} from "@/application/fulfillment/evaluate-walking-delivery-quote";
import {
  WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
  WALKING_ROUTE_DISTANCE_TIERS,
  type WalkingPosition,
  type WalkingRouteDistanceTierCode,
} from "@/domain/walking-delivery";
import { prisma } from "@/infrastructure/database/prisma";

const quoteInclude = {
  tier: { select: { tierKey: true } },
} satisfies Prisma.WalkingDeliveryQuoteInclude;

type QuoteRecord = Prisma.WalkingDeliveryQuoteGetPayload<{ include: typeof quoteInclude }>;

const tierCodes = new Set<string>([
  ...WALKING_ROUTE_DISTANCE_TIERS.map(({ code }) => code),
  WALKING_ROUTE_DISTANCE_MANAGER_REVIEW_TIER_CODE,
]);

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function coordinatesFrom(value: Prisma.JsonValue | null): WalkingPosition {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return [value[0], value[1]];
  }
  throw new Error("INVALID_WALKING_QUOTE_COORDINATES");
}

function tierCodeFrom(record: QuoteRecord): WalkingRouteDistanceTierCode {
  const value = record.tier?.tierKey ?? null;
  if (value === null) throw new Error("INCOMPLETE_WALKING_QUOTE_TIER");
  if (!tierCodes.has(value)) throw new Error("INVALID_WALKING_QUOTE_TIER");
  return value as WalkingRouteDistanceTierCode;
}

function slotsFrom(value: Prisma.JsonValue | null): readonly WalkingQuoteSlot[] {
  if (value === null || Array.isArray(value) || typeof value !== "object") return [];
  const slots = (value as Prisma.JsonObject).slots;
  if (!Array.isArray(slots)) return [];

  return slots.map((slot) => {
    if (
      slot === null ||
      Array.isArray(slot) ||
      typeof slot !== "object" ||
      typeof slot.slotId !== "string" ||
      typeof slot.locationId !== "string" ||
      typeof slot.startsAt !== "string" ||
      typeof slot.endsAt !== "string" ||
      typeof slot.remainingCapacity !== "number" ||
      !Number.isInteger(slot.remainingCapacity) ||
      slot.remainingCapacity < 0
    ) {
      throw new Error("INVALID_WALKING_QUOTE_SLOT_SNAPSHOT");
    }
    return {
      slotId: slot.slotId,
      locationId: slot.locationId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      remainingCapacity: slot.remainingCapacity,
    };
  });
}

function resultFrom(record: QuoteRecord, replayed: boolean): WalkingQuoteResult {
  if (
    !record.normalizedAddress ||
    !record.postalCode ||
    !record.selectedLocationId ||
    !record.zoneVersionId ||
    !record.feePolicyVersionId ||
    !record.routingProvider ||
    record.distanceFeet === null ||
    record.durationSeconds === null ||
    !["ELIGIBLE", "NO_AVAILABLE_SLOTS", "MANAGER_REVIEW"].includes(record.reasonCode)
  ) {
    throw new Error("INCOMPLETE_WALKING_QUOTE_RECORD");
  }

  return {
    schemaVersion: "orderpro.walking-delivery-quote.v1",
    quoteId: record.id,
    replayed,
    eligible: record.reasonCode === "ELIGIBLE",
    normalizedAddress: record.normalizedAddress,
    customerCoordinates: coordinatesFrom(record.customerCoordinates),
    postalCode: record.postalCode,
    selectedLocationId: record.selectedLocationId,
    zoneVersionId: record.zoneVersionId,
    feePolicyVersionId: record.feePolicyVersionId,
    routingProvider: record.routingProvider,
    routingProfile: "walking",
    distanceFeet: record.distanceFeet?.toNumber() ?? null,
    durationSeconds: record.durationSeconds,
    feeCents: record.feeCents,
    tierId: tierCodeFrom(record),
    reasonCode: record.reasonCode as WalkingQuoteResult["reasonCode"],
    calculatedAt: record.calculatedAt.toISOString(),
    slots: slotsFrom(record.slotSnapshot),
    correlationId: record.correlationId,
  };
}

export const prismaWalkingQuoteStore: WalkingQuoteStore = {
  async findByIdempotency(input) {
    const record = await prisma.walkingDeliveryQuote.findUnique({
      where: {
        clientId_idempotencyKey: {
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: quoteInclude,
    });
    if (!record) return null;
    return { requestHash: record.requestHash, result: resultFrom(record, false) };
  },

  async save(input: PersistWalkingQuoteInput) {
    try {
      const record = await prisma.walkingDeliveryQuote.create({
        data: {
        schemaVersion: input.schemaVersion,
        clientId: input.clientId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        normalizedAddress: input.normalizedAddress,
        customerCoordinates: asInputJson(input.customerCoordinates),
        postalCode: input.postalCode,
        selectedLocationId: input.selectedLocationId,
        zoneVersionId: input.zoneVersionId,
        feePolicyVersionId: input.feePolicyVersionId,
        routingProvider: input.routingProvider,
        routingProfile: input.routingProfile,
        distanceFeet: input.distanceFeet,
        durationSeconds: input.durationSeconds,
        feeCents: input.feeCents,
        tierId: input.tierRecordId,
        reasonCode: input.reasonCode,
        calculatedAt: new Date(input.calculatedAt),
        feePolicySnapshot: asInputJson(input.feePolicySnapshot),
        tierSnapshot: input.tierSnapshot === null ? Prisma.DbNull : asInputJson(input.tierSnapshot),
        slotPolicyId: input.slotPolicyId,
        slotSnapshot: input.slotSnapshot === null ? Prisma.DbNull : asInputJson(input.slotSnapshot),
        walkingPublicationId: input.walkingPublicationId,
        correlationId: input.correlationId,
        },
        include: quoteInclude,
      });
      return resultFrom(record, false);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;

      const existing = await prisma.walkingDeliveryQuote.findUnique({
        where: {
          clientId_idempotencyKey: {
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: quoteInclude,
      });
      if (!existing || existing.requestHash !== input.requestHash) {
        throw new WalkingQuoteEvaluationError("IDEMPOTENCY_CONFLICT");
      }
      return resultFrom(existing, true);
    }
  },
};
