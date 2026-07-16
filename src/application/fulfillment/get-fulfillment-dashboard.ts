import "server-only";

import { requirePermission } from "@/application/auth/current-principal";
import { prisma } from "@/infrastructure/database/prisma";
import {
  getStoreOnlinePolicyBlockers,
  getWalkingZoneRecordBlockers,
  getWalkingZoneVersionBlockers,
  type FulfillmentDashboardBlocker,
} from "./fulfillment-dashboard-blockers";

export interface FulfillmentDashboardFlagDto {
  readonly key: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly updatedAt: string;
}

export interface FulfillmentDashboardLocationDto {
  readonly id: string;
  readonly code: string;
  readonly publicId: string | null;
  readonly name: string;
  readonly type: string;
  readonly active: boolean;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly timeZone: string | null;
}

export interface FulfillmentDashboardFeePolicyDto {
  readonly id: string;
  readonly policyKey: string;
  readonly versionNumber: number;
  readonly locationId: string;
  readonly name: string;
  readonly serviceScope: string;
  readonly status: string;
  readonly currency: string;
  readonly baseFeeCents: number | null;
  readonly activeDays: readonly string[];
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly digest: string | null;
}

export interface FulfillmentDashboardSlotPolicyDto {
  readonly id: string;
  readonly policyKey: string;
  readonly versionNumber: number;
  readonly locationId: string;
  readonly name: string;
  readonly fulfillmentMode: string;
  readonly status: string;
  readonly activeDays: readonly string[];
  readonly leadTimeMinutes: number | null;
  readonly cutoffMinuteOfDay: number | null;
  readonly capacityPolicyRef: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly digest: string | null;
}

export interface FulfillmentDashboardWalkingCandidateDto {
  readonly location: FulfillmentDashboardLocationDto;
  readonly feePolicy: FulfillmentDashboardFeePolicyDto | null;
  readonly slotPolicy: FulfillmentDashboardSlotPolicyDto | null;
}

export interface FulfillmentDashboardWalkingVersionDto {
  readonly id: string;
  readonly versionNumber: number;
  readonly revision: number;
  readonly status: string;
  readonly serviceMode: string;
  readonly assignmentStrategy: string;
  readonly postalCodes: readonly string[];
  readonly priority: number | null;
  readonly hasGeometry: boolean;
  readonly geometryType: string | null;
  readonly activeDays: readonly string[];
  readonly maxDistanceMiles: string | null;
  readonly maxRouteMinutes: number | null;
  readonly minimumOrderCents: number | null;
  readonly digest: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly validatedAt: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly candidates: readonly FulfillmentDashboardWalkingCandidateDto[];
  readonly blockers: readonly FulfillmentDashboardBlocker[];
}

export interface FulfillmentDashboardWalkingZoneDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly currentVersionNumber: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentVersion: FulfillmentDashboardWalkingVersionDto | null;
  readonly latestVersion: FulfillmentDashboardWalkingVersionDto | null;
  readonly blockers: readonly FulfillmentDashboardBlocker[];
}

export interface FulfillmentDashboardStoreOnlinePolicyDto {
  readonly id: string;
  readonly policyKey: string;
  readonly versionNumber: number;
  readonly isLatestVersion: boolean;
  readonly status: string;
  readonly fulfillmentMode: string;
  readonly onlineSalesEnabled: boolean;
  readonly availableOnlyAfterStoreActivation: boolean;
  readonly addedBusinessDays: number;
  readonly timeZone: string;
  readonly pickupWeekdays: readonly string[];
  readonly retrievalCutoffMinuteOfDay: number | null;
  readonly businessCalendarRef: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly digest: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceLocation: FulfillmentDashboardLocationDto;
  readonly consolidationLocation: FulfillmentDashboardLocationDto;
  readonly blockers: readonly FulfillmentDashboardBlocker[];
}

export interface FulfillmentDashboardDto {
  readonly generatedAt: string;
  readonly flags: readonly FulfillmentDashboardFlagDto[];
  readonly storeOnlinePolicies: readonly FulfillmentDashboardStoreOnlinePolicyDto[];
  readonly walkingZones: readonly FulfillmentDashboardWalkingZoneDto[];
}

interface LocationRow {
  id: string;
  code: string;
  publicId: string | null;
  name: string;
  type: string;
  active: boolean;
  addressLine1: string | null;
  city: string | null;
  regionCode: string | null;
  postalCode: string | null;
  timeZone: string | null;
}

interface FeePolicyRow {
  id: string;
  policyKey: string;
  versionNumber: number;
  locationId: string;
  name: string;
  serviceScope: string;
  status: string;
  currency: string;
  baseFeeCents: number | null;
  activeDays: readonly string[];
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  digest: string | null;
}

interface SlotPolicyRow {
  id: string;
  policyKey: string;
  versionNumber: number;
  locationId: string;
  name: string;
  fulfillmentMode: string;
  status: string;
  activeDays: readonly string[];
  leadTimeMinutes: number | null;
  cutoffMinuteOfDay: number | null;
  capacityPolicyRef: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  digest: string | null;
}

interface WalkingCandidateRow {
  location: LocationRow;
  feePolicy: FeePolicyRow | null;
  slotPolicy: SlotPolicyRow | null;
}

interface WalkingVersionRow {
  id: string;
  versionNumber: number;
  revision: number;
  status: string;
  serviceMode: string;
  assignmentStrategy: string;
  postalCodes: readonly string[];
  priority: number | null;
  geometry: unknown | null;
  activeDays: readonly string[];
  maxDistanceMiles: { toString(): string } | null;
  maxRouteMinutes: number | null;
  minimumOrderCents: number | null;
  digest: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  validatedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  candidates: readonly WalkingCandidateRow[];
}

interface StoreOnlinePolicyRow {
  id: string;
  policyKey: string;
  versionNumber: number;
  status: string;
  fulfillmentMode: string;
  onlineSalesEnabled: boolean;
  availableOnlyAfterStoreActivation: boolean;
  addedBusinessDays: number;
  timeZone: string;
  pickupWeekdays: readonly string[];
  retrievalCutoffMinuteOfDay: number | null;
  businessCalendarRef: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  digest: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sourceLocation: LocationRow;
  consolidationLocation: LocationRow;
}

const locationSelect = {
  id: true,
  code: true,
  publicId: true,
  name: true,
  type: true,
  active: true,
  addressLine1: true,
  city: true,
  regionCode: true,
  postalCode: true,
  timeZone: true,
} as const;

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function geometryType(value: unknown | null) {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  return typeof value.type === "string" ? value.type : null;
}

function toLocationDto(location: LocationRow): FulfillmentDashboardLocationDto {
  return { ...location };
}

function toFeePolicyDto(policy: FeePolicyRow): FulfillmentDashboardFeePolicyDto {
  return {
    ...policy,
    activeDays: [...policy.activeDays],
    effectiveFrom: iso(policy.effectiveFrom),
    effectiveTo: iso(policy.effectiveTo),
  };
}

function toSlotPolicyDto(policy: SlotPolicyRow): FulfillmentDashboardSlotPolicyDto {
  return {
    ...policy,
    activeDays: [...policy.activeDays],
    effectiveFrom: iso(policy.effectiveFrom),
    effectiveTo: iso(policy.effectiveTo),
  };
}

function toWalkingVersionDto(version: WalkingVersionRow): FulfillmentDashboardWalkingVersionDto {
  const candidates = version.candidates.map((candidate) => ({
    location: toLocationDto(candidate.location),
    feePolicy: candidate.feePolicy ? toFeePolicyDto(candidate.feePolicy) : null,
    slotPolicy: candidate.slotPolicy ? toSlotPolicyDto(candidate.slotPolicy) : null,
  }));
  const blockers = getWalkingZoneVersionBlockers({
    id: version.id,
    postalCodes: version.postalCodes,
    geometry: version.geometry,
    priority: version.priority,
    activeDays: version.activeDays,
    assignmentStrategy: version.assignmentStrategy,
    candidates,
  });

  return {
    id: version.id,
    versionNumber: version.versionNumber,
    revision: version.revision,
    status: version.status,
    serviceMode: version.serviceMode,
    assignmentStrategy: version.assignmentStrategy,
    postalCodes: [...version.postalCodes],
    priority: version.priority,
    hasGeometry: version.geometry != null,
    geometryType: geometryType(version.geometry),
    activeDays: [...version.activeDays],
    maxDistanceMiles: version.maxDistanceMiles?.toString() ?? null,
    maxRouteMinutes: version.maxRouteMinutes,
    minimumOrderCents: version.minimumOrderCents,
    digest: version.digest,
    effectiveFrom: iso(version.effectiveFrom),
    effectiveTo: iso(version.effectiveTo),
    validatedAt: iso(version.validatedAt),
    publishedAt: iso(version.publishedAt),
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    candidates,
    blockers,
  };
}

function toStoreOnlinePolicyDto(
  policy: StoreOnlinePolicyRow,
  latestVersionByPolicyKey: ReadonlyMap<string, number>,
): FulfillmentDashboardStoreOnlinePolicyDto {
  const sourceLocation = toLocationDto(policy.sourceLocation);
  const consolidationLocation = toLocationDto(policy.consolidationLocation);
  const blockers = getStoreOnlinePolicyBlockers({
    id: policy.id,
    status: policy.status,
    fulfillmentMode: policy.fulfillmentMode,
    onlineSalesEnabled: policy.onlineSalesEnabled,
    availableOnlyAfterStoreActivation: policy.availableOnlyAfterStoreActivation,
    addedBusinessDays: policy.addedBusinessDays,
    timeZone: policy.timeZone,
    pickupWeekdays: policy.pickupWeekdays,
    retrievalCutoffMinuteOfDay: policy.retrievalCutoffMinuteOfDay,
    businessCalendarRef: policy.businessCalendarRef,
    sourceLocation,
    consolidationLocation,
  });

  return {
    id: policy.id,
    policyKey: policy.policyKey,
    versionNumber: policy.versionNumber,
    isLatestVersion: latestVersionByPolicyKey.get(policy.policyKey) === policy.versionNumber,
    status: policy.status,
    fulfillmentMode: policy.fulfillmentMode,
    onlineSalesEnabled: policy.onlineSalesEnabled,
    availableOnlyAfterStoreActivation: policy.availableOnlyAfterStoreActivation,
    addedBusinessDays: policy.addedBusinessDays,
    timeZone: policy.timeZone,
    pickupWeekdays: [...policy.pickupWeekdays],
    retrievalCutoffMinuteOfDay: policy.retrievalCutoffMinuteOfDay,
    businessCalendarRef: policy.businessCalendarRef,
    effectiveFrom: iso(policy.effectiveFrom),
    effectiveTo: iso(policy.effectiveTo),
    digest: policy.digest,
    publishedAt: iso(policy.publishedAt),
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    sourceLocation,
    consolidationLocation,
    blockers,
  };
}

export async function getFulfillmentDashboard(): Promise<FulfillmentDashboardDto> {
  await requirePermission("fulfillment.view");

  const [flags, storeOnlinePolicies, walkingZones] = await Promise.all([
    prisma.featureFlag.findMany({ orderBy: { key: "asc" } }),
    prisma.storeOnlineFulfillmentPolicy.findMany({
      orderBy: [{ policyKey: "asc" }, { versionNumber: "desc" }],
      include: {
        sourceLocation: { select: locationSelect },
        consolidationLocation: { select: locationSelect },
      },
    }),
    prisma.walkingZone.findMany({
      orderBy: { slug: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        currentVersionNumber: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          select: {
            id: true,
            versionNumber: true,
            revision: true,
            status: true,
            serviceMode: true,
            assignmentStrategy: true,
            postalCodes: true,
            priority: true,
            geometry: true,
            activeDays: true,
            maxDistanceMiles: true,
            maxRouteMinutes: true,
            minimumOrderCents: true,
            digest: true,
            effectiveFrom: true,
            effectiveTo: true,
            validatedAt: true,
            publishedAt: true,
            createdAt: true,
            updatedAt: true,
            candidates: {
              orderBy: { locationId: "asc" },
              select: {
                location: { select: locationSelect },
                feePolicy: {
                  select: {
                    id: true,
                    policyKey: true,
                    versionNumber: true,
                    locationId: true,
                    name: true,
                    serviceScope: true,
                    status: true,
                    currency: true,
                    baseFeeCents: true,
                    activeDays: true,
                    effectiveFrom: true,
                    effectiveTo: true,
                    digest: true,
                  },
                },
                slotPolicy: {
                  select: {
                    id: true,
                    policyKey: true,
                    versionNumber: true,
                    locationId: true,
                    name: true,
                    fulfillmentMode: true,
                    status: true,
                    activeDays: true,
                    leadTimeMinutes: true,
                    cutoffMinuteOfDay: true,
                    capacityPolicyRef: true,
                    effectiveFrom: true,
                    effectiveTo: true,
                    digest: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const latestVersionByPolicyKey = new Map<string, number>();
  storeOnlinePolicies.forEach((policy) => {
    const current = latestVersionByPolicyKey.get(policy.policyKey) ?? 0;
    latestVersionByPolicyKey.set(policy.policyKey, Math.max(current, policy.versionNumber));
  });

  return {
    generatedAt: new Date().toISOString(),
    flags: flags.map((flag) => ({
      key: flag.key,
      enabled: flag.enabled,
      description: flag.description,
      updatedAt: flag.updatedAt.toISOString(),
    })),
    storeOnlinePolicies: storeOnlinePolicies.map((policy) =>
      toStoreOnlinePolicyDto(policy, latestVersionByPolicyKey),
    ),
    walkingZones: walkingZones.map((zone) => {
      const latestVersionRow = zone.versions[0] ?? null;
      const currentVersionRow =
        zone.versions.find((version) => version.versionNumber === zone.currentVersionNumber) ?? null;
      const latestVersion = latestVersionRow ? toWalkingVersionDto(latestVersionRow) : null;
      const currentVersion =
        currentVersionRow?.id === latestVersionRow?.id
          ? latestVersion
          : currentVersionRow
            ? toWalkingVersionDto(currentVersionRow)
            : null;
      const blockers = [
        ...getWalkingZoneRecordBlockers({
          id: zone.id,
          currentVersionNumber: zone.currentVersionNumber,
          currentVersionId: currentVersion?.id ?? null,
          latestVersionId: latestVersion?.id ?? null,
        }),
        ...(latestVersion?.blockers ?? []),
      ];

      return {
        id: zone.id,
        slug: zone.slug,
        name: zone.name,
        currentVersionNumber: zone.currentVersionNumber,
        archivedAt: iso(zone.archivedAt),
        createdAt: zone.createdAt.toISOString(),
        updatedAt: zone.updatedAt.toISOString(),
        currentVersion,
        latestVersion,
        blockers,
      };
    }),
  };
}
