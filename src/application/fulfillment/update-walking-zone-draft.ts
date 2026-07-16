import "server-only";

import { Prisma, type WalkingAssignmentStrategy, type WalkingWeekday } from "@prisma/client";
import { activeLocationIds } from "@/application/auth/principal-access";
import { requirePermission } from "@/application/auth/current-principal";
import { stableSha256Digest } from "@/domain/walking-delivery";
import { prisma } from "@/infrastructure/database/prisma";
import { validateWalkingZoneDraft } from "./walking-zone-draft-policy";

export type UpdateWalkingZoneDraftCommand = {
  commandId: string;
  versionId: string;
  expectedRevision: number;
  name: string;
  postalCodes: string[];
  priority: number | null;
  assignmentStrategy: WalkingAssignmentStrategy;
  candidateLocationIds: string[];
  geometry: unknown | null;
  activeDays: WalkingWeekday[];
  maxDistanceMiles: number | null;
  maxRouteMinutes: number | null;
  minimumOrderCents: number | null;
  correlationId: string;
};

export type UpdateWalkingZoneDraftResult = {
  versionId: string;
  revision: number;
  status: "DRAFT";
  replayed: boolean;
};

export type UpdateWalkingZoneDraftError =
  | "FEATURE_DISABLED"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_IMMUTABLE"
  | "VERSION_CONFLICT"
  | "LOCATION_FORBIDDEN"
  | "INVALID_CANDIDATE_LOCATION"
  | "INVALID_DRAFT"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMAND_IN_PROGRESS";

function fail(code: UpdateWalkingZoneDraftError): never {
  throw new Error(code);
}

function normalizeCommand(command: UpdateWalkingZoneDraftCommand) {
  return {
    versionId: command.versionId,
    expectedRevision: command.expectedRevision,
    name: command.name.trim(),
    postalCodes: [...new Set(command.postalCodes.map((code) => code.trim()))].sort(),
    priority: command.priority,
    assignmentStrategy: command.assignmentStrategy,
    candidateLocationIds: [...new Set(command.candidateLocationIds)].sort(),
    geometry: command.geometry,
    activeDays: [...new Set(command.activeDays)].sort(),
    maxDistanceMiles: command.maxDistanceMiles,
    maxRouteMinutes: command.maxRouteMinutes,
    minimumOrderCents: command.minimumOrderCents,
  };
}

export async function updateWalkingZoneDraft(
  command: UpdateWalkingZoneDraftCommand,
): Promise<UpdateWalkingZoneDraftResult> {
  const { account } = await requirePermission("fulfillment.manage");
  const normalized = normalizeCommand(command);
  if (validateWalkingZoneDraft(normalized).length > 0) fail("INVALID_DRAFT");
  const requestHash = stableSha256Digest({ actorId: account.id, ...normalized });
  const allowedLocationIds = new Set(activeLocationIds(account));

  return prisma.$transaction(async (transaction) => {
    const flag = await transaction.featureFlag.findUnique({ where: { key: "walking_delivery.admin" } });
    if (!flag?.enabled) fail("FEATURE_DISABLED");

    const existing = await transaction.idempotencyRecord.findUnique({
      where: { scope_key: { scope: "walking-zone.draft.update", key: command.commandId } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
      const response = existing.responseBody as Omit<UpdateWalkingZoneDraftResult, "replayed"> | null;
      if (response?.versionId && response.revision && response.status === "DRAFT") {
        return { ...response, replayed: true };
      }
      fail("COMMAND_IN_PROGRESS");
    }

    const draft = await transaction.walkingZoneVersion.findUnique({
      where: { id: normalized.versionId },
      include: { walkingZone: true, candidates: { select: { locationId: true } } },
    });
    if (!draft) fail("DRAFT_NOT_FOUND");
    if (draft.status === "PUBLISHED" || draft.status === "ARCHIVED") fail("DRAFT_IMMUTABLE");
    if (draft.revision !== normalized.expectedRevision) fail("VERSION_CONFLICT");

    const touchedLocationIds = new Set([
      ...draft.candidates.map(({ locationId }) => locationId),
      ...normalized.candidateLocationIds,
    ]);
    if ([...touchedLocationIds].some((locationId) => !allowedLocationIds.has(locationId))) {
      fail("LOCATION_FORBIDDEN");
    }

    const candidateLocations = await transaction.operationalLocation.findMany({
      where: {
        id: { in: normalized.candidateLocationIds },
        active: true,
        type: "STORE",
        publicId: { not: null },
      },
      select: { id: true, code: true, publicId: true },
    });
    if (candidateLocations.length !== normalized.candidateLocationIds.length) fail("INVALID_CANDIDATE_LOCATION");

    const [feePolicies, slotPolicies] = await Promise.all([
      transaction.feePolicy.findMany({
        where: { locationId: { in: normalized.candidateLocationIds }, serviceScope: "GENERAL_LOCAL_DELIVERY" },
        orderBy: [{ locationId: "asc" }, { versionNumber: "desc" }],
        select: { id: true, locationId: true },
      }),
      transaction.slotPolicy.findMany({
        where: { locationId: { in: normalized.candidateLocationIds }, fulfillmentMode: "WALKING_LOCAL_DELIVERY" },
        orderBy: [{ locationId: "asc" }, { versionNumber: "desc" }],
        select: { id: true, locationId: true },
      }),
    ]);
    const feeByLocation = new Map<string, string>();
    feePolicies.forEach((policy) => {
      if (!feeByLocation.has(policy.locationId)) feeByLocation.set(policy.locationId, policy.id);
    });
    const slotByLocation = new Map<string, string>();
    slotPolicies.forEach((policy) => {
      if (!slotByLocation.has(policy.locationId)) slotByLocation.set(policy.locationId, policy.id);
    });

    const idempotency = await transaction.idempotencyRecord.create({
      data: {
        scope: "walking-zone.draft.update",
        key: command.commandId,
        requestHash,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = {
      name: draft.walkingZone.name,
      revision: draft.revision,
      status: draft.status,
      postalCodes: draft.postalCodes,
      priority: draft.priority,
      assignmentStrategy: draft.assignmentStrategy,
      candidateLocationIds: draft.candidates.map(({ locationId }) => locationId).sort(),
    };

    const updated = await transaction.walkingZoneVersion.updateMany({
      where: { id: draft.id, revision: normalized.expectedRevision, status: { in: ["DRAFT", "VALIDATED"] } },
      data: {
        revision: { increment: 1 },
        status: "DRAFT",
        assignmentStrategy: normalized.assignmentStrategy,
        postalCodes: normalized.postalCodes,
        priority: normalized.priority,
        geometry: normalized.geometry === null ? Prisma.DbNull : normalized.geometry as Prisma.InputJsonValue,
        activeDays: normalized.activeDays,
        maxDistanceMiles: normalized.maxDistanceMiles,
        maxRouteMinutes: normalized.maxRouteMinutes,
        minimumOrderCents: normalized.minimumOrderCents,
        snapshot: Prisma.DbNull,
        digest: null,
        validatedAt: null,
      },
    });
    if (updated.count !== 1) fail("VERSION_CONFLICT");

    await transaction.walkingZone.update({ where: { id: draft.walkingZoneId }, data: { name: normalized.name } });
    await transaction.walkingZoneCandidate.deleteMany({ where: { walkingZoneVersionId: draft.id } });
    await transaction.walkingZoneCandidate.createMany({
      data: normalized.candidateLocationIds.map((locationId) => ({
        walkingZoneVersionId: draft.id,
        locationId,
        feePolicyId: feeByLocation.get(locationId) ?? null,
        slotPolicyId: slotByLocation.get(locationId) ?? null,
      })),
    });

    const response = { versionId: draft.id, revision: draft.revision + 1, status: "DRAFT" as const };
    const after = { ...normalized, geometry: normalized.geometry === null ? null : { supplied: true }, revision: response.revision };
    await transaction.auditEvent.create({
      data: {
        actorId: account.id,
        action: "WALKING_ZONE_DRAFT_UPDATED",
        entityType: "WalkingZoneVersion",
        entityId: draft.id,
        locationCode: null,
        correlationId: command.correlationId,
        before,
        after,
      },
    });
    await transaction.outboxMessage.create({
      data: {
        topic: "orderpro.walking_zone.draft.updated",
        aggregateType: "WalkingZoneVersion",
        aggregateId: draft.id,
        payload: { walkingZoneId: draft.walkingZoneId, versionId: draft.id, revision: response.revision },
      },
    });
    await transaction.idempotencyRecord.update({
      where: { id: idempotency.id },
      data: { responseStatus: 200, responseBody: response, completedAt: new Date() },
    });
    return { ...response, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
