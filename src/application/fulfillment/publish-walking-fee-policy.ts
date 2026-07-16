import "server-only";

import { Prisma } from "@prisma/client";
import { activeLocationIds } from "@/application/auth/principal-access";
import { requirePermission } from "@/application/auth/current-principal";
import { stableSha256Digest } from "@/domain/walking-delivery";
import { prisma } from "@/infrastructure/database/prisma";
import {
  buildWalkingFeePolicySnapshot,
  validateWalkingFeePolicyVersion,
  WALKING_FEE_POLICY_LOCATION_IDS,
  WALKING_FEE_POLICY_PUBLISH_CONFIRMATION,
  WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION,
  type WalkingFeePolicyVersionRecord,
} from "./walking-fee-policy-publication-policy";

const IDEMPOTENCY_SCOPE = "walking-fee-policy.publish";

export type PublishWalkingFeePolicyCommand = {
  commandId: string;
  versionId: string;
  expectedRevision: number;
  reason: string;
  confirmation: string;
  correlationId: string;
};

export type PublishWalkingFeePolicyResult = {
  publicationId: string;
  publicationNumber: number;
  versionId: string;
  revision: number;
  status: "PUBLISHED";
  environment: "STAGING";
  digest: string;
  effectiveFrom: string;
  replayed: boolean;
};

export type PublishWalkingFeePolicyError =
  | "INVALID_APPROVAL"
  | "FEATURE_DISABLED"
  | "POLICY_VERSION_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "VERSION_IMMUTABLE"
  | "ALREADY_PUBLISHED"
  | "LOCATION_FORBIDDEN"
  | "INVALID_LOCATION_POLICY"
  | "INVALID_POLICY_DEFINITION"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMAND_IN_PROGRESS";

function fail(code: PublishWalkingFeePolicyError): never {
  throw new Error(code);
}

function numberOrNull(value: { toString(): string } | null) {
  return value === null ? null : Number(value.toString());
}

export async function publishWalkingFeePolicy(
  command: PublishWalkingFeePolicyCommand,
): Promise<PublishWalkingFeePolicyResult> {
  const { account } = await requirePermission("fulfillment.publish");
  const reason = command.reason.trim();
  if (
    reason.length < 10 ||
    reason.length > 500 ||
    command.confirmation !== WALKING_FEE_POLICY_PUBLISH_CONFIRMATION
  ) {
    fail("INVALID_APPROVAL");
  }

  const requestHash = stableSha256Digest({
    actorId: account.id,
    versionId: command.versionId,
    expectedRevision: command.expectedRevision,
    reason,
    confirmation: command.confirmation,
  });
  const allowedLocationIds = new Set(activeLocationIds(account));

  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.idempotencyRecord.findUnique({
      where: { scope_key: { scope: IDEMPOTENCY_SCOPE, key: command.commandId } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
      const response = existing.responseBody as Omit<PublishWalkingFeePolicyResult, "replayed"> | null;
      if (
        response?.publicationId &&
        response.publicationNumber > 0 &&
        response.versionId === command.versionId &&
        response.status === "PUBLISHED"
      ) {
        return { ...response, replayed: true };
      }
      fail("COMMAND_IN_PROGRESS");
    }

    const version = await transaction.feeCalculationPolicyVersion.findUnique({
      where: { id: command.versionId },
      include: {
        feeCalculationPolicy: { select: { id: true, code: true } },
        tiers: { orderBy: { sequence: "asc" } },
        locationFeePolicies: {
          orderBy: { policyKey: "asc" },
          include: {
            location: {
              select: { id: true, code: true, publicId: true, active: true, type: true },
            },
          },
        },
        publications: { select: { id: true }, take: 1 },
      },
    });
    if (!version) fail("POLICY_VERSION_NOT_FOUND");
    if (version.status === "PUBLISHED") fail("ALREADY_PUBLISHED");
    if (version.status === "ARCHIVED") fail("VERSION_IMMUTABLE");
    if (version.status === "DRAFT_INCOMPLETE") fail("INVALID_POLICY_DEFINITION");
    if (version.revision !== command.expectedRevision) fail("VERSION_CONFLICT");
    if (version.publications.length > 0) fail("VERSION_IMMUTABLE");

    const [adminFlag, publishFlag] = await Promise.all([
      transaction.featureFlag.findUnique({ where: { key: "walking_fee_policy.admin" } }),
      transaction.featureFlag.findUnique({
        where: {
          key:
            version.environment === "STAGING"
              ? "walking_fee_policy.staging_publish"
              : "walking_fee_policy.publish",
        },
      }),
    ]);
    if (!adminFlag?.enabled || !publishFlag?.enabled) fail("FEATURE_DISABLED");

    const expectedPublicIds = new Set<string>(WALKING_FEE_POLICY_LOCATION_IDS);
    const linkedPublicIds = new Set(
      version.locationFeePolicies.map(({ location }) => location.publicId).filter((value): value is string => Boolean(value)),
    );
    const invalidLocationPolicy =
      version.locationFeePolicies.length !== WALKING_FEE_POLICY_LOCATION_IDS.length ||
      linkedPublicIds.size !== expectedPublicIds.size ||
      [...expectedPublicIds].some((publicId) => !linkedPublicIds.has(publicId)) ||
      version.locationFeePolicies.some(
        (policy) =>
          policy.serviceScope !== "GENERAL_LOCAL_DELIVERY" ||
          policy.baseFeeCents !== null ||
          policy.rateRules !== null ||
          policy.exceptions !== null ||
          !policy.location.active ||
          policy.location.type !== "STORE",
      );
    if (invalidLocationPolicy) fail("INVALID_LOCATION_POLICY");

    if (version.locationFeePolicies.some(({ locationId }) => !allowedLocationIds.has(locationId))) {
      fail("LOCATION_FORBIDDEN");
    }

    const policyRecord: WalkingFeePolicyVersionRecord = {
      policyId: version.feeCalculationPolicy.id,
      policyCode: version.feeCalculationPolicy.code,
      versionId: version.id,
      versionKey: version.versionKey,
      versionNumber: version.versionNumber,
      revision: version.revision,
      environment: version.environment,
      strategy: version.strategy,
      currency: version.currency,
      routingProfile: version.routingProfile,
      tiers: version.tiers.map((tier) => ({
        id: tier.id,
        tierKey: tier.tierKey,
        sequence: tier.sequence,
        lowerExclusiveFeet: numberOrNull(tier.lowerExclusiveFeet),
        upperInclusiveFeet: numberOrNull(tier.upperInclusiveFeet),
        feeCents: tier.feeCents,
        automatic: tier.automatic,
        reasonCode: tier.reasonCode,
      })),
    };
    if (!validateWalkingFeePolicyVersion(policyRecord).valid) fail("INVALID_POLICY_DEFINITION");

    const snapshot = buildWalkingFeePolicySnapshot(policyRecord);
    const digest = stableSha256Digest(snapshot);
    const now = new Date();
    const idempotency = await transaction.idempotencyRecord.create({
      data: {
        scope: IDEMPOTENCY_SCOPE,
        key: command.commandId,
        requestHash,
        expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      },
    });

    const updated = await transaction.feeCalculationPolicyVersion.updateMany({
      where: {
        id: version.id,
        revision: command.expectedRevision,
        status: { in: ["DRAFT", "VALIDATED"] },
      },
      data: {
        status: "PUBLISHED",
        snapshot: snapshot as Prisma.InputJsonValue,
        digest,
        effectiveFrom: now,
        effectiveTo: null,
        validatedAt: now,
        publishedById: account.id,
        publishedAt: now,
      },
    });
    if (updated.count !== 1) fail("VERSION_CONFLICT");

    const latestPublication = await transaction.feeCalculationPolicyPublication.aggregate({
      where: { feeCalculationPolicyId: version.feeCalculationPolicyId },
      _max: { publicationNumber: true },
    });
    const publicationNumber = (latestPublication._max.publicationNumber ?? 0) + 1;
    const publication = await transaction.feeCalculationPolicyPublication.create({
      data: {
        feeCalculationPolicyId: version.feeCalculationPolicyId,
        feePolicyVersionId: version.id,
        publicationNumber,
        schemaVersion: WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION,
        status: "PUBLISHED",
        snapshot: snapshot as Prisma.InputJsonValue,
        digest,
        effectiveFrom: now,
        effectiveTo: null,
        publishedById: account.id,
        publishedAt: now,
      },
      select: { id: true },
    });

    await transaction.auditEvent.create({
      data: {
        actorId: account.id,
        action: "WALKING_FEE_POLICY_PUBLICATION_APPROVED",
        entityType: "FeeCalculationPolicyVersion",
        entityId: version.id,
        correlationId: command.correlationId,
        reason,
        before: {
          status: version.status,
          revision: version.revision,
          digest: version.digest,
        },
        after: {
          status: "PUBLISHED",
          revision: version.revision,
          environment: version.environment,
          digest,
          publicationId: publication.id,
          publicationNumber,
          effectiveFrom: now.toISOString(),
        },
      },
    });
    await transaction.outboxMessage.create({
      data: {
        topic: "orderpro.walking_fee_policy.published",
        aggregateType: "FeeCalculationPolicyPublication",
        aggregateId: publication.id,
        payload: {
          schemaVersion: WALKING_FEE_POLICY_SNAPSHOT_SCHEMA_VERSION,
          publicationId: publication.id,
          publicationNumber,
          policyId: version.feeCalculationPolicyId,
          policyCode: version.feeCalculationPolicy.code,
          feePolicyVersionId: version.id,
          versionKey: version.versionKey,
          environment: version.environment,
          digest,
          effectiveFrom: now.toISOString(),
          correlationId: command.correlationId,
        },
      },
    });

    const response = {
      publicationId: publication.id,
      publicationNumber,
      versionId: version.id,
      revision: version.revision,
      status: "PUBLISHED" as const,
      environment: "STAGING" as const,
      digest,
      effectiveFrom: now.toISOString(),
    };
    await transaction.idempotencyRecord.update({
      where: { id: idempotency.id },
      data: { responseStatus: 201, responseBody: response, completedAt: now },
    });
    return { ...response, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
