import "server-only";

import { hasPermission } from "@/application/auth/permissions";
import { activeLocationIds } from "@/application/auth/principal-access";
import { requirePermission } from "@/application/auth/current-principal";
import {
  WALKING_ROUTE_DISTANCE_POLICY_KEY,
  WALKING_ROUTE_DISTANCE_POLICY_VERSION,
} from "@/domain/walking-delivery";
import { prisma } from "@/infrastructure/database/prisma";
import {
  validateWalkingFeePolicyVersion,
  WALKING_FEE_POLICY_LOCATION_IDS,
  WALKING_FEE_POLICY_PUBLISH_CONFIRMATION,
  type WalkingFeePolicyVersionRecord,
} from "./walking-fee-policy-publication-policy";

function numberOrNull(value: { toString(): string } | null) {
  return value === null ? null : Number(value.toString());
}

export async function getWalkingFeePolicyAdministration() {
  const { account } = await requirePermission("fulfillment.view");
  const roles = account.roles.map(({ role }) => role);
  const allowedLocationIds = new Set(activeLocationIds(account));

  const policy = await prisma.feeCalculationPolicy.findUnique({
    where: { code: WALKING_ROUTE_DISTANCE_POLICY_KEY },
    include: {
      versions: {
        where: { versionKey: WALKING_ROUTE_DISTANCE_POLICY_VERSION },
        take: 1,
        include: {
          tiers: { orderBy: { sequence: "asc" } },
          locationFeePolicies: {
            orderBy: { policyKey: "asc" },
            include: {
              location: {
                select: {
                  id: true,
                  code: true,
                  publicId: true,
                  name: true,
                  active: true,
                  type: true,
                },
              },
            },
          },
          publications: {
            orderBy: { publicationNumber: "desc" },
            include: {
              publishedBy: { select: { displayName: true, email: true } },
            },
          },
        },
      },
    },
  });
  const version = policy?.versions[0];
  if (!policy || !version) return null;

  const flags = await prisma.featureFlag.findMany({
    where: {
      key: {
        in: [
          "walking_fee_policy.admin",
          "walking_fee_policy.staging_publish",
          "walking_fee_policy.publish",
          "walking_delivery.quote_writes",
          "walking_quote.api",
          "walking_quote.external_delivery",
        ],
      },
    },
    orderBy: { key: "asc" },
  });
  const flagByKey = new Map(flags.map((flag) => [flag.key, flag.enabled]));

  const record: WalkingFeePolicyVersionRecord = {
    policyId: policy.id,
    policyCode: policy.code,
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
  const validation = validateWalkingFeePolicyVersion(record);

  const expectedPublicIds = new Set<string>(WALKING_FEE_POLICY_LOCATION_IDS);
  const linkedPublicIds = new Set(
    version.locationFeePolicies.map(({ location }) => location.publicId).filter((value): value is string => Boolean(value)),
  );
  const locationPolicyValid =
    version.locationFeePolicies.length === WALKING_FEE_POLICY_LOCATION_IDS.length &&
    linkedPublicIds.size === expectedPublicIds.size &&
    [...expectedPublicIds].every((publicId) => linkedPublicIds.has(publicId)) &&
    version.locationFeePolicies.every(
      (feePolicy) =>
        feePolicy.serviceScope === "GENERAL_LOCAL_DELIVERY" &&
        feePolicy.baseFeeCents === null &&
        feePolicy.rateRules === null &&
        feePolicy.exceptions === null &&
        feePolicy.location.active &&
        feePolicy.location.type === "STORE",
    );
  const hasAllLocationAccess = version.locationFeePolicies.every(({ locationId }) =>
    allowedLocationIds.has(locationId),
  );
  const publicationFlagKey =
    version.environment === "STAGING"
      ? "walking_fee_policy.staging_publish"
      : "walking_fee_policy.publish";
  const hasPublishPermission = hasPermission(roles, "fulfillment.publish");
  const blockers = [
    ...validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    ...(!locationPolicyValid
      ? ["Both active store policies must reference this version without base fees, avenue surcharges or historical matrices."]
      : []),
    ...(!hasAllLocationAccess ? ["Your account needs active grants for every affected store."] : []),
    ...(!flagByKey.get("walking_fee_policy.admin") ? ["Walking fee-policy administration is disabled."] : []),
    ...(!flagByKey.get(publicationFlagKey) ? [`Publication gate ${publicationFlagKey} is disabled.`] : []),
    ...(!hasPublishPermission ? ["Only an Owner with fulfillment.publish may approve publication."] : []),
  ];
  const canPublish =
    hasPublishPermission &&
    (version.status === "DRAFT" || version.status === "VALIDATED") &&
    blockers.length === 0;

  return {
    canPublish,
    publishConfirmation: WALKING_FEE_POLICY_PUBLISH_CONFIRMATION,
    blockers,
    policy: {
      id: policy.id,
      code: policy.code,
      name: policy.name,
    },
    version: {
      id: version.id,
      versionKey: version.versionKey,
      versionNumber: version.versionNumber,
      revision: version.revision,
      status: version.status,
      environment: version.environment,
      strategy: version.strategy,
      currency: version.currency,
      routingProfile: version.routingProfile,
      digest: version.digest,
      effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
      effectiveTo: version.effectiveTo?.toISOString() ?? null,
      validatedAt: version.validatedAt?.toISOString() ?? null,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      tiers: record.tiers,
      locations: version.locationFeePolicies.map((feePolicy) => ({
        feePolicyId: feePolicy.id,
        policyKey: feePolicy.policyKey,
        policyVersionNumber: feePolicy.versionNumber,
        status: feePolicy.status,
        serviceScope: feePolicy.serviceScope,
        hasBaseFee: feePolicy.baseFeeCents !== null,
        hasHistoricalRules: feePolicy.rateRules !== null || feePolicy.exceptions !== null,
        location: feePolicy.location,
        granted: allowedLocationIds.has(feePolicy.locationId),
      })),
      publications: version.publications.map((publication) => ({
        id: publication.id,
        publicationNumber: publication.publicationNumber,
        schemaVersion: publication.schemaVersion,
        status: publication.status,
        digest: publication.digest,
        effectiveFrom: publication.effectiveFrom.toISOString(),
        effectiveTo: publication.effectiveTo?.toISOString() ?? null,
        publishedAt: publication.publishedAt.toISOString(),
        publishedBy: publication.publishedBy
          ? {
              displayName: publication.publishedBy.displayName,
              email: publication.publishedBy.email,
            }
          : null,
      })),
    },
    flags: flags.map((flag) => ({
      key: flag.key,
      enabled: flag.enabled,
      description: flag.description,
    })),
  };
}
