import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
  LocalDeliveryApplicationError,
  type LocalDeliveryInventoryLineEvidence,
  type LocalDeliveryNormalizedAddress,
  type LocalDeliveryOfferPersistencePlan,
  type LocalDeliveryQuotePersistencePlan,
  type LocalDeliveryQuoteResult,
  type LocalDeliveryQuoteSaveInput,
  type LocalDeliveryQuoteStorePort,
  type LocalDeliverySlot,
} from "../../application/local-delivery-v4/contracts";
import { prisma } from "../database/prisma";

const QUOTE_SCHEMA_VERSION = "orderpro.walking-delivery-quote.v2";
const retryableTransactionAttempts = 3;
const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const quoteInclude = {
  selectedLocalDeliveryLocation: {
    select: { displayName: true, externalLocationId: true },
  },
  feePolicyVersion: {
    select: {
      holdTtlSeconds: true,
      preparationBufferSeconds: true,
      handoffBufferSeconds: true,
    },
  },
  tier: { select: { tierKey: true } },
  candidateRoutes: { orderBy: { sequence: "asc" as const } },
  inventoryLines: {
    orderBy: { lineNumber: "asc" as const },
  },
} satisfies Prisma.WalkingDeliveryQuoteInclude;

type QuoteRecord = Prisma.WalkingDeliveryQuoteGetPayload<{
  include: typeof quoteInclude;
}>;
type OfferSaveInput = Extract<
  LocalDeliveryQuoteSaveInput,
  { readonly persistencePlan: LocalDeliveryOfferPersistencePlan }
>;

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instant(value: string, label: string) {
  const match = rfc3339.exec(value);
  if (!match) {
    throw new Error(`INVALID_${label}`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(`INVALID_${label}`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`INVALID_${label}`);
  }
  return date;
}

function isEffective(
  effectiveFrom: Date | null,
  effectiveTo: Date | null,
  calculatedAt: Date,
) {
  return Boolean(
    effectiveFrom &&
      effectiveFrom.getTime() <= calculatedAt.getTime() &&
      (!effectiveTo || effectiveTo.getTime() > calculatedAt.getTime()),
  );
}

function normalizedAddressFrom(value: Prisma.JsonValue | null): LocalDeliveryNormalizedAddress {
  if (!isRecord(value)) throw new Error("INCOMPLETE_LOCAL_DELIVERY_ADDRESS");
  const { line1, line2, city, state, postalCode, country, borough } = value;
  if (
    typeof line1 !== "string" ||
    (line2 !== null && typeof line2 !== "string") ||
    city !== "New York" ||
    state !== "NY" ||
    typeof postalCode !== "string" ||
    country !== "US" ||
    borough !== "Manhattan"
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_ADDRESS");
  }
  return { line1, line2, city, state, postalCode, country, borough };
}

function coordinatesFrom(value: Prisma.JsonValue | null) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    value[0] < -180 ||
    value[0] > 180 ||
    value[1] < -90 ||
    value[1] > 90
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_COORDINATES");
  }
  return { latitude: value[1], longitude: value[0] } as const;
}

function slotsFrom(value: Prisma.JsonValue | null): readonly LocalDeliverySlot[] {
  if (!isRecord(value) || !Array.isArray(value.slots)) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_SLOT_SNAPSHOT");
  }
  return value.slots.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.slotId !== "string" ||
      typeof candidate.locationId !== "string" ||
      typeof candidate.startsAt !== "string" ||
      typeof candidate.endsAt !== "string" ||
      typeof candidate.remainingCapacitySeconds !== "number" ||
      !Number.isInteger(candidate.remainingCapacitySeconds) ||
      candidate.remainingCapacitySeconds <= 0
    ) {
      throw new Error("INCOMPLETE_LOCAL_DELIVERY_SLOT_SNAPSHOT");
    }
    const startsAt = instant(candidate.startsAt, "SLOT_START");
    const endsAt = instant(candidate.endsAt, "SLOT_END");
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new Error("INCOMPLETE_LOCAL_DELIVERY_SLOT_SNAPSHOT");
    }
    return {
      slotId: candidate.slotId,
      locationId: candidate.locationId,
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
      remainingCapacitySeconds: candidate.remainingCapacitySeconds,
    };
  });
}

function inventoryEvidenceFrom(record: QuoteRecord): readonly LocalDeliveryInventoryLineEvidence[] {
  return record.inventoryLines.map((line, index) => {
    if (
      line.lineNumber !== index + 1 ||
      !line.variantId.trim() ||
      !line.productId ||
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      !line.inventoryOwnerLocationId ||
      !line.inventoryOwnerExternalLocationId ||
      line.inventoryOwnerExternalLocationId.length > 64 ||
      !line.inventoryNodeId ||
      !line.inventoryNodeExternalId ||
      line.inventoryNodeExternalId.length > 64 ||
      (!line.containerId && !line.storageLocationId) ||
      (line.readinessStatus !== "READY" && line.readinessStatus !== "TRANSFER_REQUIRED") ||
      ![
        "NOT_REQUIRED",
        "TRANSFER_REQUIRED",
        "REQUESTED",
        "IN_TRANSIT",
        "RECEIVED",
        "READY",
      ].includes(line.transferStatus)
    ) {
      throw new Error("INCOMPLETE_LOCAL_DELIVERY_INVENTORY_EVIDENCE");
    }
    return {
      lineNumber: line.lineNumber,
      variantId: line.variantId,
      productId: line.productId,
      quantity: line.quantity,
      readinessStatus: line.readinessStatus,
      inventoryOwnerLocationId: line.inventoryOwnerLocationId,
      inventoryOwnerExternalLocationId: line.inventoryOwnerExternalLocationId,
      inventoryNodeId: line.inventoryNodeId,
      inventoryNodeExternalId: line.inventoryNodeExternalId,
      containerId: line.containerId,
      storageLocationId: line.storageLocationId,
      transferStatus: line.transferStatus as LocalDeliveryInventoryLineEvidence["transferStatus"],
      earliestReadyAt: line.earliestReadyAt?.toISOString() ?? null,
    };
  });
}

function persistencePlanFrom(record: QuoteRecord): LocalDeliveryQuotePersistencePlan {
  if (record.reasonCode === "CONTACT_STORE") {
    return { kind: "CONTACT_STORE", calculatedAt: record.calculatedAt.toISOString() };
  }
  const version = record.feePolicyVersion;
  if (
    !version ||
    version.holdTtlSeconds === null ||
    version.preparationBufferSeconds === null ||
    version.handoffBufferSeconds === null
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_POLICY_SNAPSHOT");
  }
  return {
    kind: "OFFER",
    calculatedAt: record.calculatedAt.toISOString(),
    holdTtlSeconds: version.holdTtlSeconds,
    preparationBufferSeconds: version.preparationBufferSeconds,
    handoffBufferSeconds: version.handoffBufferSeconds,
    inventoryLines: inventoryEvidenceFrom(record),
  };
}

function quoteFrom(record: QuoteRecord, replayed: boolean): LocalDeliveryQuoteResult {
  const normalizedAddress = normalizedAddressFrom(record.normalizedAddressStructured);
  const coordinates = coordinatesFrom(record.customerCoordinates);
  if (!record.postalCode || !record.expiresAt) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_QUOTE");
  }
  if (record.reasonCode === "CONTACT_STORE") {
    return {
      quoteId: record.id,
      replayed,
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      normalizedAddress,
      coordinates,
      postalCode: record.postalCode,
      correlationId: record.correlationId,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  if (
    !["ELIGIBLE", "TRANSFER_REQUIRED", "NO_SLOTS_FOR_SELECTED_LOCATION"].includes(
      record.reasonCode,
    ) ||
    !record.selectedLocalDeliveryLocation ||
    !record.externalSelectedLocationId ||
    !record.assignmentRule ||
    !record.routingProvider ||
    record.routingProfile !== "walking" ||
    record.distanceFeet === null ||
    record.durationSeconds === null ||
    record.roundTripDistanceFeet === null ||
    record.estimatedRoundTripDurationSeconds === null ||
    record.capacityRequiredSeconds === null ||
    record.feeCents === null ||
    record.currency !== "USD" ||
    !record.tier ||
    record.externalZoneVersionId !== LOCAL_DELIVERY_ZONE_VERSION_ID ||
    record.externalFeePolicyVersionId !== LOCAL_DELIVERY_FEE_POLICY_VERSION_ID ||
    !record.routeCalculatedAt ||
    (record.inventoryReadinessStatus !== "READY" &&
      record.inventoryReadinessStatus !== "TRANSFER_REQUIRED")
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_QUOTE");
  }
  if (
    record.candidateRoutes.length === 0 ||
    record.candidateRoutes.some((route) =>
      route.routingProfile !== "walking" ||
      route.locationPriority === null ||
      route.locationPriority <= 0 ||
      !route.routingProvider.trim()) ||
    (record.reasonCode === "NO_SLOTS_FOR_SELECTED_LOCATION"
      ? record.bookable !== false
      : record.bookable !== true)
  ) {
    throw new Error("INCOMPLETE_LOCAL_DELIVERY_QUOTE");
  }

  const inventoryLines = inventoryEvidenceFrom(record);
  const availableSlots = slotsFrom(record.slotSnapshot);
  const common = {
    quoteId: record.id,
    replayed,
    eligible: true as const,
    normalizedAddress,
    coordinates,
    postalCode: record.postalCode,
    selectedLocationId: record.externalSelectedLocationId,
    selectedLocationName: record.selectedLocalDeliveryLocation.displayName,
    assignmentRule: record.assignmentRule,
    walkingDistanceFeet: record.distanceFeet.toNumber(),
    walkingDurationSeconds: record.durationSeconds,
    roundTripDistanceFeet: record.roundTripDistanceFeet.toNumber(),
    estimatedRoundTripDurationSeconds: record.estimatedRoundTripDurationSeconds,
    requiredCapacitySeconds: record.capacityRequiredSeconds,
    feeCents: record.feeCents,
    currency: "USD" as const,
    feeTierId: record.tier.tierKey,
    candidateRoutes: record.candidateRoutes.map((route) => ({
      locationId: route.externalLocationId,
      locationPriority: route.locationPriority ?? 0,
      walkingDistanceFeet: route.walkingDistanceFeet.toNumber(),
      walkingDurationSeconds: route.walkingDurationSeconds,
      routingProvider: route.routingProvider,
    })),
    availableSlots,
    inventoryStatus: record.inventoryReadinessStatus,
    transferEarliestReadyAt: record.inventoryReadyAt?.toISOString() ?? null,
    inventoryOwnerLocationIds: [
      ...new Set(inventoryLines.map(({ inventoryOwnerExternalLocationId }) =>
        inventoryOwnerExternalLocationId)),
    ],
    inventoryNodeIds: [
      ...new Set(inventoryLines.map(({ inventoryNodeExternalId }) => inventoryNodeExternalId)),
    ],
    zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
    feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
    routingProvider: record.routingProvider,
    routingProfile: "walking" as const,
    routeCalculatedAt: record.routeCalculatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    correlationId: record.correlationId,
  };

  if (record.reasonCode === "NO_SLOTS_FOR_SELECTED_LOCATION") {
    return { ...common, bookable: false, reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION" };
  }
  if (record.reasonCode === "TRANSFER_REQUIRED") {
    return { ...common, bookable: true, reasonCode: "TRANSFER_REQUIRED" };
  }
  return { ...common, bookable: true, reasonCode: "ELIGIBLE" };
}

function formattedAddress(address: LocalDeliveryNormalizedAddress) {
  return [
    address.line1,
    address.line2,
    address.city,
    `${address.state} ${address.postalCode}`,
  ].filter(Boolean).join(", ");
}

function policyUnavailable(): never {
  throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
}

function invalidSaveInput(): never {
  throw new LocalDeliveryApplicationError("INVALID_REQUEST");
}

function validateSaveInput(input: LocalDeliveryQuoteSaveInput) {
  if (
    input.cartLines.length === 0 ||
    input.cartLines.length > 100 ||
    input.cartLines.some(
      (line) =>
        !line.variantId.trim() ||
        !Number.isInteger(line.quantity) ||
        line.quantity <= 0,
    )
  ) {
    return invalidSaveInput();
  }

  const calculatedAt = instant(input.persistencePlan.calculatedAt, "CALCULATED_AT");
  const expiresAt = instant(input.quote.expiresAt, "QUOTE_EXPIRY");
  if (expiresAt.getTime() <= calculatedAt.getTime()) return invalidSaveInput();

  if (input.persistencePlan.kind === "CONTACT_STORE") {
    // CONTACT_STORE intentionally carries no inventory assessment. Its cart is
    // protected by requestHash/idempotency, but must never become reservable evidence.
    if (
      input.quote.eligible ||
      input.quote.bookable ||
      input.quote.reasonCode !== "CONTACT_STORE"
    ) {
      return invalidSaveInput();
    }
    return;
  }

  if (!input.quote.eligible) return invalidSaveInput();
  instant(input.quote.routeCalculatedAt, "ROUTE_CALCULATED_AT");
  if (input.quote.transferEarliestReadyAt) {
    instant(input.quote.transferEarliestReadyAt, "INVENTORY_READY_AT");
  }
  for (const slot of input.quote.availableSlots) {
    const startsAt = instant(slot.startsAt, "SLOT_START");
    const endsAt = instant(slot.endsAt, "SLOT_END");
    if (endsAt.getTime() <= startsAt.getTime()) return invalidSaveInput();
  }

  const inventoryLines = input.persistencePlan.inventoryLines;
  if (inventoryLines.length !== input.cartLines.length) return invalidSaveInput();
  const seenLineNumbers = new Set<number>();
  for (const line of inventoryLines) {
    if (
      !Number.isInteger(line.lineNumber) ||
      line.lineNumber < 1 ||
      line.lineNumber > input.cartLines.length ||
      seenLineNumbers.has(line.lineNumber)
    ) {
      return invalidSaveInput();
    }
    const cartLine = input.cartLines[line.lineNumber - 1];
    if (
      !cartLine ||
      line.variantId !== cartLine.variantId ||
      line.quantity !== cartLine.quantity
    ) {
      return invalidSaveInput();
    }
    if (line.earliestReadyAt) {
      instant(line.earliestReadyAt, "INVENTORY_LINE_READY_AT");
    }
    seenLineNumbers.add(line.lineNumber);
  }
}

function groupedInventoryLines(lines: LocalDeliveryOfferPersistencePlan["inventoryLines"]) {
  const groups = new Map<string, {
    readonly productId: string;
    readonly inventoryOwnerLocationId: string;
    readonly inventoryNodeId: string;
    readonly containerId: string | null;
    readonly storageLocationId: string | null;
    quantity: number;
  }>();
  for (const line of lines) {
    const key = JSON.stringify([
      line.productId,
      line.inventoryOwnerLocationId,
      line.inventoryNodeId,
      line.containerId,
      line.storageLocationId,
    ]);
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      groups.set(key, {
        productId: line.productId,
        inventoryOwnerLocationId: line.inventoryOwnerLocationId,
        inventoryNodeId: line.inventoryNodeId,
        containerId: line.containerId,
        storageLocationId: line.storageLocationId,
        quantity: line.quantity,
      });
    }
  }
  return [...groups.values()];
}

function isOfferSaveInput(input: LocalDeliveryQuoteSaveInput): input is OfferSaveInput {
  return input.persistencePlan.kind === "OFFER" && input.quote.eligible;
}

async function resolveOfferContext(
  tx: Prisma.TransactionClient,
  input: OfferSaveInput,
) {
  const calculatedAt = instant(input.persistencePlan.calculatedAt, "CALCULATED_AT");
  const quote = input.quote;
  const selectedIdentity = await tx.localDeliveryLocationIdentity.findUnique({
    where: { externalLocationId: quote.selectedLocationId },
    include: { operationalLocation: true },
  });
  if (!selectedIdentity?.active || !selectedIdentity.operationalLocation.active) {
    return policyUnavailable();
  }

  const zoneSet = await tx.walkingZoneSetVersion.findUnique({
    where: { externalVersionId: quote.zoneVersionId },
  });
  if (
    !zoneSet ||
    zoneSet.status !== "PUBLISHED" ||
    zoneSet.environment !== "STAGING" ||
    !isEffective(zoneSet.effectiveFrom, zoneSet.effectiveTo, calculatedAt)
  ) {
    return policyUnavailable();
  }

  const zoneVersions = await tx.walkingZoneVersion.findMany({
    where: {
      zoneSetVersionId: zoneSet.id,
      status: "PUBLISHED",
      postalCodes: { has: quote.postalCode },
      candidates: { some: { locationId: selectedIdentity.operationalLocationId } },
    },
    include: {
      candidates: {
        include: { feePolicy: true, slotPolicy: true },
      },
    },
  });
  const effectiveZones = zoneVersions.filter((version) =>
    isEffective(version.effectiveFrom, version.effectiveTo, calculatedAt));
  if (effectiveZones.length !== 1 || !effectiveZones[0]?.geometry) {
    return policyUnavailable();
  }
  const zoneVersion = effectiveZones[0];

  const routeIdentities = await Promise.all(
    quote.candidateRoutes.map((route) => tx.localDeliveryLocationIdentity.findUnique({
      where: { externalLocationId: route.locationId },
      include: { operationalLocation: true },
    })),
  );
  if (
    routeIdentities.some((identity) => !identity?.active || !identity.operationalLocation.active) ||
    new Set(routeIdentities.map((identity) => identity!.operationalLocationId)).size !==
      routeIdentities.length ||
    zoneVersion.candidates.length !== routeIdentities.length ||
    routeIdentities.some((identity) =>
      !zoneVersion.candidates.some(({ locationId }) => locationId === identity!.operationalLocationId))
  ) {
    return policyUnavailable();
  }

  const feeVersion = await tx.feeCalculationPolicyVersion.findUnique({
    where: { externalVersionId: quote.feePolicyVersionId },
  });
  if (
    !feeVersion ||
    feeVersion.status !== "PUBLISHED" ||
    feeVersion.environment !== "STAGING" ||
    !isEffective(feeVersion.effectiveFrom, feeVersion.effectiveTo, calculatedAt) ||
    feeVersion.holdTtlSeconds !== input.persistencePlan.holdTtlSeconds ||
    feeVersion.preparationBufferSeconds !== input.persistencePlan.preparationBufferSeconds ||
    feeVersion.handoffBufferSeconds !== input.persistencePlan.handoffBufferSeconds
  ) {
    return policyUnavailable();
  }

  const feePublication = await tx.feeCalculationPolicyPublication.findFirst({
    where: {
      feePolicyVersionId: feeVersion.id,
      status: "PUBLISHED",
      effectiveFrom: { lte: calculatedAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: calculatedAt } }],
    },
    orderBy: { publicationNumber: "desc" },
  });
  const walkingPublication = await tx.walkingPublication.findFirst({
    where: {
      zoneSetVersionId: zoneSet.id,
      status: "PUBLISHED",
      effectiveFrom: { lte: calculatedAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: calculatedAt } }],
    },
    orderBy: { versionNumber: "desc" },
  });
  if (!feePublication || !walkingPublication) return policyUnavailable();

  const tier = await tx.feeCalculationTier.findFirst({
    where: { feePolicyVersionId: feeVersion.id, tierKey: quote.feeTierId },
  });
  const selectedCandidate = zoneVersion.candidates.find(
    ({ locationId }) => locationId === selectedIdentity.operationalLocationId,
  );
  if (
    !tier ||
    !selectedCandidate?.feePolicy ||
    !selectedCandidate.slotPolicy ||
    selectedCandidate.feePolicy.status !== "PUBLISHED" ||
    selectedCandidate.feePolicy.calculationPolicyVersionId !== feeVersion.id ||
    !isEffective(
      selectedCandidate.feePolicy.effectiveFrom,
      selectedCandidate.feePolicy.effectiveTo,
      calculatedAt,
    ) ||
    selectedCandidate.slotPolicy.status !== "PUBLISHED" ||
    !isEffective(
      selectedCandidate.slotPolicy.effectiveFrom,
      selectedCandidate.slotPolicy.effectiveTo,
      calculatedAt,
    )
  ) {
    return policyUnavailable();
  }

  const certifiedBalances = await Promise.all(
    groupedInventoryLines(input.persistencePlan.inventoryLines).map((group) =>
      tx.inventoryNodeBalance.findFirst({
        where: {
          productId: group.productId,
          inventoryOwnerLocationId: group.inventoryOwnerLocationId,
          inventoryNodeId: group.inventoryNodeId,
          containerId: group.containerId,
          storageLocationId: group.storageLocationId,
          available: { gte: group.quantity },
          product: { active: true },
        },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
    ),
  );
  // Quote-time certification remains deliberately conservative: without split
  // reservation lines, one certified balance must cover the full physical tuple.
  // The hold still chooses the actual lot/balance later, under row locks.
  if (certifiedBalances.some((balance) => balance === null)) {
    throw new LocalDeliveryApplicationError("INVENTORY_NOT_READY");
  }

  return {
    calculatedAt,
    selectedIdentity,
    zoneSet,
    zoneVersion,
    routeIdentities: routeIdentities.map((identity) => identity!),
    feeVersion,
    tier,
    slotPolicy: selectedCandidate.slotPolicy,
    walkingPublication,
  };
}

async function setDeferredConstraintsImmediate(tx: Prisma.TransactionClient) {
  await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`);
}

async function assertNotExpired(
  tx: Prisma.TransactionClient,
  expiresAt: Date,
) {
  const rows = await tx.$queryRaw<Array<{ transactionNow: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS "transactionNow"`,
  );
  const transactionNow = rows[0]?.transactionNow;
  if (!(transactionNow instanceof Date) || !Number.isFinite(transactionNow.getTime())) {
    throw new Error("INVALID_DATABASE_TRANSACTION_TIME");
  }
  if (expiresAt.getTime() <= transactionNow.getTime()) {
    throw new LocalDeliveryApplicationError("QUOTE_EXPIRED");
  }
}

async function serializable<T>(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= retryableTransactionAttempts; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt === retryableTransactionAttempts
      ) {
        throw error;
      }
    }
  }
  throw new Error("UNREACHABLE_SERIALIZABLE_RETRY");
}

export class PrismaLocalDeliveryQuoteStore implements LocalDeliveryQuoteStorePort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findByIdempotency(input: { clientId: string; idempotencyKey: string }) {
    const record = await this.db.walkingDeliveryQuote.findUnique({
      where: {
        clientId_idempotencyKey: {
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: quoteInclude,
    });
    return record
      ? { requestHash: record.requestHash, quote: quoteFrom(record, false) }
      : null;
  }

  async save(input: LocalDeliveryQuoteSaveInput): Promise<LocalDeliveryQuoteResult> {
    validateSaveInput(input);
    try {
      return await serializable(this.db, async (tx) => {
        const expiresAt = instant(input.quote.expiresAt, "QUOTE_EXPIRY");
        await assertNotExpired(tx, expiresAt);
        let quoteId: string;
        if (!isOfferSaveInput(input)) {
          const calculatedAt = instant(input.persistencePlan.calculatedAt, "CALCULATED_AT");
          const record = await tx.walkingDeliveryQuote.create({
            data: {
              schemaVersion: QUOTE_SCHEMA_VERSION,
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              normalizedAddress: formattedAddress(input.quote.normalizedAddress),
              normalizedAddressStructured: asInputJson(input.quote.normalizedAddress),
              customerCoordinates: asInputJson([
                input.quote.coordinates.longitude,
                input.quote.coordinates.latitude,
              ]),
              postalCode: input.quote.postalCode,
              bookable: false,
              reasonCode: "CONTACT_STORE",
              calculatedAt,
              expiresAt,
              inventoryReadinessStatus: "NOT_EVALUATED",
              correlationId: input.quote.correlationId,
            },
            select: { id: true },
          });
          quoteId = record.id;
        } else {
          const context = await resolveOfferContext(tx, input);
          const quote = input.quote;
          const routeCalculatedAt = instant(quote.routeCalculatedAt, "ROUTE_CALCULATED_AT");
          const record = await tx.walkingDeliveryQuote.create({
            data: {
              schemaVersion: QUOTE_SCHEMA_VERSION,
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              normalizedAddress: formattedAddress(quote.normalizedAddress),
              normalizedAddressStructured: asInputJson(quote.normalizedAddress),
              customerCoordinates: asInputJson([
                quote.coordinates.longitude,
                quote.coordinates.latitude,
              ]),
              postalCode: quote.postalCode,
              selectedLocationId: quote.selectedLocationId,
              externalSelectedLocationId: quote.selectedLocationId,
              selectedOperationalLocationId: context.selectedIdentity.operationalLocationId,
              selectedLocalDeliveryLocationId: context.selectedIdentity.id,
              zoneVersionId: context.zoneVersion.id,
              zoneSetVersionId: context.zoneSet.id,
              externalZoneVersionId: quote.zoneVersionId,
              feePolicyVersionId: context.feeVersion.id,
              externalFeePolicyVersionId: quote.feePolicyVersionId,
              assignmentRule: quote.assignmentRule,
              routingProvider: quote.routingProvider,
              routingProfile: "walking",
              distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
              distanceFeet: quote.walkingDistanceFeet,
              durationSeconds: quote.walkingDurationSeconds,
              roundTripDistanceFeet: quote.roundTripDistanceFeet,
              estimatedRoundTripDurationSeconds: quote.estimatedRoundTripDurationSeconds,
              preparationBufferSeconds: input.persistencePlan.preparationBufferSeconds,
              handoffBufferSeconds: input.persistencePlan.handoffBufferSeconds,
              capacityRequiredSeconds: quote.requiredCapacitySeconds,
              feeCents: quote.feeCents,
              currency: "USD",
              bookable: quote.bookable,
              tierId: context.tier.id,
              reasonCode: quote.reasonCode,
              calculatedAt: context.calculatedAt,
              routeCalculatedAt,
              expiresAt,
              inventoryReadinessStatus: quote.inventoryStatus,
              inventoryReadyAt: quote.transferEarliestReadyAt
                ? instant(quote.transferEarliestReadyAt, "INVENTORY_READY_AT")
                : null,
              slotPolicyId: context.slotPolicy.id,
              slotSnapshot: asInputJson(quote.availableSlots),
              walkingPublicationId: context.walkingPublication.id,
              correlationId: quote.correlationId,
            },
            select: { id: true },
          });
          quoteId = record.id;

          await tx.walkingDeliveryQuoteCandidateRoute.createMany({
            data: quote.candidateRoutes.map((route, index) => {
              const identity = context.routeIdentities[index]!;
              return {
                quoteId,
                localDeliveryLocationId: identity.id,
                operationalLocationId: identity.operationalLocationId,
                externalLocationId: identity.externalLocationId,
                sequence: index + 1,
                locationPriority: route.locationPriority,
                walkingDistanceFeet: route.walkingDistanceFeet,
                walkingDurationSeconds: route.walkingDurationSeconds,
                routingProvider: route.routingProvider,
                routingProfile: "walking",
                routeCalculatedAt,
                selected: route.locationId === quote.selectedLocationId,
              };
            }),
          });
          await tx.walkingDeliveryQuoteInventoryLine.createMany({
            data: input.persistencePlan.inventoryLines.map((line) => ({
              quoteId,
              lineNumber: line.lineNumber,
              variantId: line.variantId,
              productId: line.productId,
              quantity: line.quantity,
              readinessStatus: line.readinessStatus,
              inventoryOwnerLocationId: line.inventoryOwnerLocationId,
              inventoryOwnerExternalLocationId:
                line.inventoryOwnerExternalLocationId,
              inventoryNodeId: line.inventoryNodeId,
              inventoryNodeExternalId: line.inventoryNodeExternalId,
              containerId: line.containerId,
              storageLocationId: line.storageLocationId,
              transferStatus: line.transferStatus,
              earliestReadyAt: line.earliestReadyAt
                ? instant(line.earliestReadyAt, "INVENTORY_LINE_READY_AT")
                : null,
            })),
          });
        }

        await setDeferredConstraintsImmediate(tx);
        const stored = await tx.walkingDeliveryQuote.findUnique({
          where: { id: quoteId },
          include: quoteInclude,
        });
        if (!stored) throw new Error("LOCAL_DELIVERY_QUOTE_COMMIT_LOST");
        return quoteFrom(stored, false);
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const existing = await this.db.walkingDeliveryQuote.findUnique({
        where: {
          clientId_idempotencyKey: {
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: quoteInclude,
      });
      if (!existing) throw error;
      if (existing.requestHash !== input.requestHash) {
        throw new LocalDeliveryApplicationError("IDEMPOTENCY_CONFLICT");
      }
      return quoteFrom(existing, true);
    }
  }

  async findById(quoteId: string) {
    const record = await this.db.walkingDeliveryQuote.findUnique({
      where: { id: quoteId },
      include: quoteInclude,
    });
    if (!record) return null;
    const persistencePlan = persistencePlanFrom(record);
    return {
      clientId: record.clientId,
      cartLines: persistencePlan.kind === "OFFER"
        ? persistencePlan.inventoryLines.map(({ variantId, quantity }) => ({ variantId, quantity }))
        : [],
      quote: quoteFrom(record, false),
      persistencePlan,
    };
  }
}

export const prismaLocalDeliveryQuoteStore = new PrismaLocalDeliveryQuoteStore();
