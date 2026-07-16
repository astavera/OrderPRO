import "server-only";

import { Prisma } from "@prisma/client";
import type {
  WalkingQuoteConfiguration,
  WalkingQuoteConfigurationReader,
  WalkingQuotePolicyTier,
} from "@/application/fulfillment/evaluate-walking-delivery-quote";
import {
  WALKING_ROUTE_DISTANCE_POLICY_KEY,
  WALKING_ROUTE_DISTANCE_POLICY_VERSION,
  validateWalkingGeometry,
  type WalkingGeometry,
  type WalkingPosition,
  type WalkingRouteDistanceTierCode,
  type WalkingZoneConfiguration,
} from "@/domain/walking-delivery";
import { prisma } from "@/infrastructure/database/prisma";

const zoneInclude = {
  candidates: {
    orderBy: { location: { publicId: "asc" } },
    include: {
      location: {
        select: {
          publicId: true,
          active: true,
          type: true,
          latitude: true,
          longitude: true,
          timeZone: true,
        },
      },
      feePolicy: {
        select: {
          id: true,
          calculationPolicyVersionId: true,
        },
      },
      slotPolicy: {
        select: {
          id: true,
          status: true,
          activeDays: true,
          leadTimeMinutes: true,
          cutoffMinuteOfDay: true,
          capacityPolicyRef: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      },
    },
  },
} satisfies Prisma.WalkingZoneVersionInclude;

function policyTier(tier: {
  id: string;
  tierKey: string;
  lowerExclusiveFeet: Prisma.Decimal | null;
  upperInclusiveFeet: Prisma.Decimal | null;
  feeCents: number | null;
  automatic: boolean;
  reasonCode: string;
}): WalkingQuotePolicyTier {
  return {
    id: tier.id,
    tierCode: tier.tierKey as WalkingRouteDistanceTierCode,
    minimumExclusiveFeet: tier.lowerExclusiveFeet?.toNumber() ?? null,
    maximumInclusiveFeet: tier.upperInclusiveFeet?.toNumber() ?? null,
    feeCents: tier.feeCents,
    automaticQuote: tier.automatic,
    reasonCode: tier.reasonCode as "ELIGIBLE" | "MANAGER_REVIEW",
  };
}

function zoneVersionIdsFromPublication(value: Prisma.JsonValue) {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const zones = (value as Prisma.JsonObject).zones;
  if (!Array.isArray(zones)) return null;
  const result = new Set<string>();
  for (const zone of zones) {
    if (
      zone === null ||
      Array.isArray(zone) ||
      typeof zone !== "object" ||
      typeof zone.zoneVersionId !== "string"
    ) {
      return null;
    }
    result.add(zone.zoneVersionId);
  }
  return result;
}

export const prismaWalkingQuoteConfigurationReader: WalkingQuoteConfigurationReader = {
  async getPublishedConfiguration(input) {
    const serviceAt = new Date(input.serviceAt);
    const calculatedAt = new Date(input.calculatedAt);
    if (!Number.isFinite(serviceAt.getTime()) || !Number.isFinite(calculatedAt.getTime())) return null;
    const earliestRelevantAt = serviceAt < calculatedAt ? serviceAt : calculatedAt;
    const latestRelevantAt = serviceAt > calculatedAt ? serviceAt : calculatedAt;

    const [feeVersion, zoneVersions, walkingPublication] = await Promise.all([
      prisma.feeCalculationPolicyVersion.findFirst({
        where: {
          feeCalculationPolicy: { code: WALKING_ROUTE_DISTANCE_POLICY_KEY },
          versionKey: WALKING_ROUTE_DISTANCE_POLICY_VERSION,
          status: "PUBLISHED",
          environment: input.environment,
          effectiveFrom: { lte: calculatedAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: calculatedAt } }],
        },
        include: {
          tiers: { orderBy: { sequence: "asc" } },
        },
      }),
      prisma.walkingZoneVersion.findMany({
        where: {
          status: "PUBLISHED",
          postalCodes: { has: input.postalCode },
          effectiveFrom: { lte: earliestRelevantAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: latestRelevantAt } }],
        },
        orderBy: [{ priority: "desc" }, { id: "asc" }],
        include: zoneInclude,
      }),
      prisma.walkingPublication.findFirst({
        where: {
          status: "PUBLISHED",
          effectiveFrom: { lte: calculatedAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: calculatedAt } }],
        },
        orderBy: { versionNumber: "desc" },
        select: { id: true, snapshot: true },
      }),
    ]);

    if (!feeVersion || zoneVersions.length === 0 || !walkingPublication) return null;
    const publishedZoneVersionIds = zoneVersionIdsFromPublication(walkingPublication.snapshot);
    if (
      !publishedZoneVersionIds ||
      zoneVersions.some((version) => !publishedZoneVersionIds.has(version.id))
    ) {
      return null;
    }

    const locations = new Map<string, WalkingPosition>();
    const zones: WalkingZoneConfiguration[] = [];
    for (const version of zoneVersions) {
      if (
        !version.geometry ||
        !validateWalkingGeometry(version.geometry).valid ||
        version.maxDistanceMiles !== null ||
        version.maxRouteMinutes !== null
      ) {
        return null;
      }
      const locationIds: string[] = [];
      const feePolicyByLocation: Record<string, string> = {};
      const slotPolicyByLocation: Record<string, string> = {};

      for (const candidate of version.candidates) {
        const location = candidate.location;
        if (
          !location.publicId ||
          !location.active ||
          location.type !== "STORE" ||
          location.longitude === null ||
          location.latitude === null ||
          !location.timeZone?.trim() ||
          !candidate.feePolicy ||
          candidate.feePolicy.calculationPolicyVersionId !== feeVersion.id ||
          !candidate.slotPolicy ||
          candidate.slotPolicy.status !== "PUBLISHED" ||
          candidate.slotPolicy.activeDays.length === 0 ||
          candidate.slotPolicy.leadTimeMinutes === null ||
          candidate.slotPolicy.cutoffMinuteOfDay === null ||
          !candidate.slotPolicy.capacityPolicyRef?.trim() ||
          candidate.slotPolicy.effectiveFrom === null ||
          candidate.slotPolicy.effectiveFrom > earliestRelevantAt ||
          (candidate.slotPolicy.effectiveTo !== null && candidate.slotPolicy.effectiveTo <= latestRelevantAt)
        ) {
          return null;
        }

        const point = [location.longitude.toNumber(), location.latitude.toNumber()] as const;
        locationIds.push(location.publicId);
        locations.set(location.publicId, point);
        feePolicyByLocation[location.publicId] = candidate.feePolicy.id;
        slotPolicyByLocation[location.publicId] = candidate.slotPolicy.id;
      }

      zones.push({
        id: version.walkingZoneId,
        versionId: version.id,
        postalCodes: version.postalCodes,
        priority: version.priority ?? 0,
        serviceMode: "WALKING",
        assignmentStrategy: version.assignmentStrategy,
        locationIds,
        geometry: version.geometry as unknown as WalkingGeometry,
        activeDays: version.activeDays,
        maxDistanceMiles: null,
        maxRouteMinutes: null,
        minimumOrderCents: version.minimumOrderCents,
        feePolicyByLocation,
        slotPolicyByLocation,
        status: "PUBLISHED",
        effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
        effectiveTo: version.effectiveTo?.toISOString() ?? null,
      });
    }

    return {
      zones,
      locations: [...locations].map(([locationId, point]) => ({ locationId, point })),
      feePolicyVersion: {
        id: feeVersion.id,
        policyId: WALKING_ROUTE_DISTANCE_POLICY_KEY,
        versionKey: WALKING_ROUTE_DISTANCE_POLICY_VERSION,
        status: "PUBLISHED",
        environment: feeVersion.environment,
        strategy: feeVersion.strategy,
        tiers: feeVersion.tiers.map(policyTier),
      },
      walkingPublicationId: walkingPublication.id,
    } satisfies WalkingQuoteConfiguration;
  },
};
