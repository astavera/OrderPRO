import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  LocalDeliveryAssignment,
  LocalDeliveryEnvironment,
  LocalDeliveryFee,
  LocalDeliveryLocation,
  LocalDeliveryPolicyPort,
  LocalDeliveryPolicySnapshot,
} from "../../application/local-delivery-v4/contracts";
import {
  LOCAL_WALKING_DELIVERY_V4_CURRENCY,
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
  LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
  LOCAL_WALKING_DELIVERY_V4_LOCATIONS,
  LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
  LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE,
  LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
  LOCAL_WALKING_DELIVERY_V4_STRATEGY,
  LOCAL_WALKING_DELIVERY_V4_TIERS,
  LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
  evaluateLocalWalkingDeliveryV4Tier,
  type LocalWalkingDeliveryV4LocationId,
  type LocalWalkingDeliveryV4PostalCode,
} from "../../domain/walking-delivery/local-walking-delivery-v4";
import { canonicalJson, stableSha256Digest } from "../../domain/walking-delivery/canonical-json";
import { prisma } from "../database/prisma";

const feePolicyInternalId = "00000000-0000-4000-8500-000000000001";
const feeVersionInternalId = "00000000-0000-4000-8510-000000000001";
const zoneSetInternalId = "00000000-0000-4000-8600-000000000001";
const feePolicyCode = "WALKING_ROUTE_DISTANCE_V4_BASE_10";
const feePublicationSchema = "orderpro.walking-route-distance-fee.v2";
const zoneSetSchema = "orderpro.walking-zone-set.v1";
const zonePublicationSchema = "orderpro.walking-zones.v1";
const feePolicyShellSchema = "orderpro.walking-fee-policy-shell.v1";
const slotPolicyShellSchema = "orderpro.walking-slot-policy-shell.v1";
const sha256 = /^sha256:[0-9a-f]{64}$/;
const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const feePublicationSelect = {
  id: true,
  feeCalculationPolicyId: true,
  feePolicyVersionId: true,
  publicationNumber: true,
  schemaVersion: true,
  status: true,
  snapshot: true,
  digest: true,
  effectiveFrom: true,
  effectiveTo: true,
  publishedById: true,
  publishedAt: true,
} satisfies Prisma.FeeCalculationPolicyPublicationSelect;

const feeVersionSelect = {
  id: true,
  feeCalculationPolicyId: true,
  versionKey: true,
  externalVersionId: true,
  versionNumber: true,
  revision: true,
  status: true,
  environment: true,
  strategy: true,
  currency: true,
  routingProfile: true,
  distanceBasis: true,
  quoteTtlSeconds: true,
  holdTtlSeconds: true,
  preparationBufferSeconds: true,
  handoffBufferSeconds: true,
  snapshot: true,
  digest: true,
  effectiveFrom: true,
  effectiveTo: true,
  validatedAt: true,
  publishedById: true,
  publishedAt: true,
  feeCalculationPolicy: {
    select: { id: true, code: true, externalPolicyId: true },
  },
  tiers: {
    orderBy: { sequence: "asc" as const },
    select: {
      id: true,
      feePolicyVersionId: true,
      tierKey: true,
      sequence: true,
      lowerExclusiveFeet: true,
      upperInclusiveFeet: true,
      feeCents: true,
      automatic: true,
      reasonCode: true,
    },
  },
  publications: {
    select: feePublicationSelect,
  },
} satisfies Prisma.FeeCalculationPolicyVersionSelect;

const walkingPublicationSelect = {
  id: true,
  versionNumber: true,
  schemaVersion: true,
  status: true,
  snapshot: true,
  digest: true,
  effectiveFrom: true,
  effectiveTo: true,
  zoneSetVersionId: true,
  publishedById: true,
  publishedAt: true,
} satisfies Prisma.WalkingPublicationSelect;

const zoneSetSelect = {
  id: true,
  externalVersionId: true,
  revision: true,
  status: true,
  environment: true,
  snapshot: true,
  digest: true,
  effectiveFrom: true,
  effectiveTo: true,
  validatedAt: true,
  publishedById: true,
  publishedAt: true,
  publications: { select: walkingPublicationSelect },
} satisfies Prisma.WalkingZoneSetVersionSelect;

const zoneVersionSelect = {
  id: true,
  walkingZoneId: true,
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
  publishedById: true,
  publishedAt: true,
  zoneSetVersionId: true,
  walkingZone: {
    select: {
      id: true,
      slug: true,
      currentVersionNumber: true,
      archivedAt: true,
    },
  },
  zoneSetVersion: { select: zoneSetSelect },
  candidates: {
    orderBy: { locationId: "asc" as const },
    select: {
      locationId: true,
      feePolicyId: true,
      slotPolicyId: true,
      location: {
        select: {
          id: true,
          code: true,
          publicId: true,
          name: true,
          type: true,
          active: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          regionCode: true,
          postalCode: true,
          countryCode: true,
          timeZone: true,
          latitude: true,
          longitude: true,
          localDeliveryIdentity: {
            select: {
              id: true,
              operationalLocationId: true,
              externalLocationId: true,
              displayName: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              regionCode: true,
              postalCode: true,
              countryCode: true,
              latitude: true,
              longitude: true,
              locationPriority: true,
              active: true,
            },
          },
        },
      },
      feePolicy: {
        select: {
          id: true,
          policyKey: true,
          versionNumber: true,
          locationId: true,
          serviceScope: true,
          status: true,
          currency: true,
          baseFeeCents: true,
          rateRules: true,
          exceptions: true,
          activeDays: true,
          effectiveFrom: true,
          effectiveTo: true,
          digest: true,
          calculationPolicyVersionId: true,
          publishedById: true,
          publishedAt: true,
          calculationPolicyVersion: { select: feeVersionSelect },
        },
      },
      slotPolicy: {
        select: {
          id: true,
          policyKey: true,
          versionNumber: true,
          locationId: true,
          fulfillmentMode: true,
          status: true,
          activeDays: true,
          leadTimeMinutes: true,
          cutoffMinuteOfDay: true,
          capacityPolicyRef: true,
          effectiveFrom: true,
          effectiveTo: true,
          digest: true,
          publishedById: true,
          publishedAt: true,
        },
      },
    },
  },
} satisfies Prisma.WalkingZoneVersionSelect;

type FeeVersionRecord = Prisma.FeeCalculationPolicyVersionGetPayload<{
  select: typeof feeVersionSelect;
}>;
type ZoneSetRecord = Prisma.WalkingZoneSetVersionGetPayload<{
  select: typeof zoneSetSelect;
}>;
type ZoneVersionRecord = Prisma.WalkingZoneVersionGetPayload<{
  select: typeof zoneVersionSelect;
}>;
type CandidateRecord = ZoneVersionRecord["candidates"][number];

type CanonicalLocationConfiguration = {
  readonly externalId: LocalWalkingDeliveryV4LocationId;
  readonly identityId: string;
  readonly operationalId: string;
  readonly code: string;
  readonly publicId: string;
  readonly priority: number;
  readonly feePolicyId: string;
  readonly feePolicyKey: string;
  readonly slotPolicyId: string;
  readonly slotPolicyKey: string;
};

const locationConfiguration: Readonly<
  Record<LocalWalkingDeliveryV4LocationId, CanonicalLocationConfiguration>
> = {
  third_avenue: {
    externalId: "third_avenue",
    identityId: "00000000-0000-4000-8610-000000000072",
    operationalId: "00000000-0000-4000-8000-000000000072",
    code: "ST72",
    publicId: "store-3rd-avenue",
    priority: 1,
    feePolicyId: "00000000-0000-4000-8100-000000000172",
    feePolicyKey: "walking-fee-third-avenue",
    slotPolicyId: "00000000-0000-4000-8200-000000000072",
    slotPolicyKey: "walking-slots-third-avenue",
  },
  east_86th_street: {
    externalId: "east_86th_street",
    identityId: "00000000-0000-4000-8610-000000000086",
    operationalId: "00000000-0000-4000-8000-000000000086",
    code: "ST86",
    publicId: "store-86th-street",
    priority: 2,
    feePolicyId: "00000000-0000-4000-8100-000000000186",
    feePolicyKey: "walking-fee-86th-street",
    slotPolicyId: "00000000-0000-4000-8200-000000000086",
    slotPolicyKey: "walking-slots-86th-street",
  },
};

type CanonicalZoneConfiguration = {
  readonly zoneId: string;
  readonly walkingZoneId: string;
  readonly slug: string;
  readonly rule: LocalDeliveryAssignment["rule"];
  readonly candidates: readonly LocalWalkingDeliveryV4LocationId[];
};

const zoneConfiguration: Readonly<
  Record<LocalWalkingDeliveryV4PostalCode, CanonicalZoneConfiguration>
> = {
  "10021": {
    zoneId: "20021000-0000-4000-8000-000000000101",
    walkingZoneId: "20021000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10021",
    rule: "FIXED_POSTAL_ZONE",
    candidates: ["third_avenue"],
  },
  "10065": {
    zoneId: "20065000-0000-4000-8000-000000000101",
    walkingZoneId: "20065000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10065",
    rule: "FIXED_POSTAL_ZONE",
    candidates: ["third_avenue"],
  },
  "10075": {
    zoneId: "20075000-0000-4000-8000-000000000101",
    walkingZoneId: "20075000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10075",
    rule: "NEAREST_WALKING_ROUTE",
    candidates: ["third_avenue", "east_86th_street"],
  },
  "10028": {
    zoneId: "20028000-0000-4000-8000-000000000101",
    walkingZoneId: "20028000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10028",
    rule: "FIXED_POSTAL_ZONE",
    candidates: ["east_86th_street"],
  },
  "10128": {
    zoneId: "20128000-0000-4000-8000-000000000101",
    walkingZoneId: "20128000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10128",
    rule: "FIXED_POSTAL_ZONE",
    candidates: ["east_86th_street"],
  },
};

const tierInternalIds = LOCAL_WALKING_DELIVERY_V4_TIERS.map(
  (_, index) => `00000000-0000-4000-8520-${String(index + 1).padStart(12, "0")}`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedInstant(value: string): Date | null {
  const match = rfc3339.exec(value);
  if (!match) return null;
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
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function effectiveAt(
  value: { readonly effectiveFrom: Date | null; readonly effectiveTo: Date | null },
  calculatedAt: Date,
) {
  return (
    value.effectiveFrom instanceof Date &&
    Number.isFinite(value.effectiveFrom.getTime()) &&
    value.effectiveFrom.getTime() <= calculatedAt.getTime() &&
    (value.effectiveTo === null ||
      (value.effectiveTo instanceof Date &&
        Number.isFinite(value.effectiveTo.getTime()) &&
        value.effectiveTo.getTime() > calculatedAt.getTime()))
  );
}

function decimalEquals(value: Prisma.Decimal | null, expected: number | null) {
  if (value === null || expected === null) return value === null && expected === null;
  return value.equals(expected);
}

function validDigestForSnapshot(snapshot: Prisma.JsonValue | null, digest: string | null) {
  if (!isRecord(snapshot) || !digest || !sha256.test(digest)) return false;
  try {
    return stableSha256Digest(snapshot) === digest;
  } catch {
    return false;
  }
}

function sameJson(left: unknown, right: unknown) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function canonicalFeeSnapshot(version: FeeVersionRecord) {
  return {
    schemaVersion: feePublicationSchema,
    policyId: LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
    internalPolicyId: feePolicyInternalId,
    versionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
    internalVersionId: feeVersionInternalId,
    versionNumber: 1,
    revision: 1,
    environment: "STAGING",
    strategy: LOCAL_WALKING_DELIVERY_V4_STRATEGY,
    distanceBasis: LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
    quoteTtlSeconds: version.quoteTtlSeconds,
    holdTtlSeconds: version.holdTtlSeconds,
    preparationBufferSeconds: version.preparationBufferSeconds,
    handoffBufferSeconds: version.handoffBufferSeconds,
    currency: LOCAL_WALKING_DELIVERY_V4_CURRENCY,
    routingProfile: LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
    tiers: LOCAL_WALKING_DELIVERY_V4_TIERS.map((tier, index) => ({
      id: tier.id,
      sequence: index + 1,
      lowerExclusiveFeet: tier.minimumExclusiveFeet,
      upperInclusiveFeet: tier.maximumInclusiveFeet,
      feeCents: tier.feeCents,
      automatic: true,
      reasonCode: "ELIGIBLE",
    })),
  };
}

function hasCanonicalTiers(version: FeeVersionRecord) {
  if (version.tiers.length !== LOCAL_WALKING_DELIVERY_V4_TIERS.length) return false;
  return version.tiers.every((tier, index) => {
    const expected = LOCAL_WALKING_DELIVERY_V4_TIERS[index];
    return (
      tier.id === tierInternalIds[index] &&
      tier.feePolicyVersionId === feeVersionInternalId &&
      tier.tierKey === expected.id &&
      tier.sequence === index + 1 &&
      decimalEquals(tier.lowerExclusiveFeet, expected.minimumExclusiveFeet) &&
      decimalEquals(tier.upperInclusiveFeet, expected.maximumInclusiveFeet) &&
      tier.feeCents === expected.feeCents &&
      tier.automatic === true &&
      tier.reasonCode === "ELIGIBLE"
    );
  });
}

function activeFeePublications(version: FeeVersionRecord, calculatedAt: Date) {
  return version.publications.filter(
    (publication) =>
      publication.status === "PUBLISHED" && effectiveAt(publication, calculatedAt),
  );
}

function isCanonicalFeeVersion(version: FeeVersionRecord, calculatedAt: Date) {
  if (
    version.id !== feeVersionInternalId ||
    version.feeCalculationPolicyId !== feePolicyInternalId ||
    version.versionKey !== LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID ||
    version.externalVersionId !== LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID ||
    version.versionNumber !== 1 ||
    version.revision !== 1 ||
    version.status !== "PUBLISHED" ||
    version.environment !== "STAGING" ||
    version.strategy !== LOCAL_WALKING_DELIVERY_V4_STRATEGY ||
    version.currency !== LOCAL_WALKING_DELIVERY_V4_CURRENCY ||
    version.routingProfile !== LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE ||
    version.distanceBasis !== LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS ||
    !Number.isInteger(version.quoteTtlSeconds) ||
    version.quoteTtlSeconds === null ||
    version.quoteTtlSeconds < 60 ||
    version.quoteTtlSeconds > 86_400 ||
    !Number.isInteger(version.holdTtlSeconds) ||
    version.holdTtlSeconds === null ||
    version.holdTtlSeconds < 30 ||
    version.holdTtlSeconds > 3_600 ||
    version.holdTtlSeconds > version.quoteTtlSeconds ||
    !Number.isInteger(version.preparationBufferSeconds) ||
    version.preparationBufferSeconds === null ||
    version.preparationBufferSeconds < 0 ||
    version.preparationBufferSeconds > 14_400 ||
    !Number.isInteger(version.handoffBufferSeconds) ||
    version.handoffBufferSeconds === null ||
    version.handoffBufferSeconds < 0 ||
    version.handoffBufferSeconds > 14_400 ||
    version.validatedAt === null ||
    version.publishedAt === null ||
    version.publishedById === null ||
    version.feeCalculationPolicy.id !== feePolicyInternalId ||
    version.feeCalculationPolicy.code !== feePolicyCode ||
    version.feeCalculationPolicy.externalPolicyId !== LOCAL_WALKING_DELIVERY_V4_POLICY_ID ||
    !effectiveAt(version, calculatedAt) ||
    !hasCanonicalTiers(version) ||
    !validDigestForSnapshot(version.snapshot, version.digest) ||
    version.snapshot === null ||
    !sameJson(version.snapshot, canonicalFeeSnapshot(version))
  ) {
    return false;
  }

  const publications = activeFeePublications(version, calculatedAt);
  if (publications.length !== 1) return false;
  const publication = publications[0];
  return (
    publication.feeCalculationPolicyId === feePolicyInternalId &&
    publication.feePolicyVersionId === feeVersionInternalId &&
    Number.isInteger(publication.publicationNumber) &&
    publication.publicationNumber > 0 &&
    publication.schemaVersion === feePublicationSchema &&
    publication.publishedById !== null &&
    publication.publishedAt instanceof Date &&
    publication.snapshot !== null &&
    sameJson(publication.snapshot, version.snapshot) &&
    publication.digest === version.digest &&
    validDigestForSnapshot(publication.snapshot, publication.digest)
  );
}

function snapshotLocationsAreCanonical(snapshot: Record<string, unknown>) {
  if (!Array.isArray(snapshot.locations) || snapshot.locations.length !== 2) return false;
  const byId = new Map(
    snapshot.locations
      .filter(isRecord)
      .map((location) => [location.id, location] as const),
  );
  if (byId.size !== 2) return false;

  return Object.values(locationConfiguration).every((expected) => {
    const actual = byId.get(expected.externalId);
    const domain = LOCAL_WALKING_DELIVERY_V4_LOCATIONS[expected.externalId];
    return (
      actual !== undefined &&
      actual.localDeliveryLocationIdentityId === expected.identityId &&
      actual.operationalLocationId === expected.operationalId &&
      actual.code === expected.code &&
      actual.publicId === expected.publicId &&
      actual.name === domain.name &&
      actual.addressLine1 === domain.address.split(",")[0] &&
      actual.addressLine2 === null &&
      actual.city === "New York" &&
      actual.regionCode === "NY" &&
      actual.postalCode === (expected.externalId === "third_avenue" ? "10021" : "10028") &&
      actual.countryCode === "US" &&
      actual.latitude === domain.latitude &&
      actual.longitude === domain.longitude &&
      actual.locationPriority === expected.priority
    );
  });
}

function snapshotZonesAreCanonical(snapshot: Record<string, unknown>) {
  if (!Array.isArray(snapshot.zones) || snapshot.zones.length !== 5) return false;
  const zones = snapshot.zones.filter(isRecord);
  if (zones.length !== 5) return false;
  const priorities = new Set<number>();

  for (const [postalCode, expected] of Object.entries(zoneConfiguration)) {
    const matches = zones.filter(
      (zone) =>
        Array.isArray(zone.postalCodes) &&
        zone.postalCodes.length === 1 &&
        zone.postalCodes[0] === postalCode,
    );
    if (matches.length !== 1) return false;
    const zone = matches[0];
    const expectedLocationIds = [...expected.candidates].sort();
    if (
      zone.id !== expected.slug ||
      zone.zoneVersionId !== expected.zoneId ||
      zone.serviceMode !== "WALKING" ||
      zone.assignmentStrategy !==
        (expected.rule === "FIXED_POSTAL_ZONE" ? "FIXED" : "NEAREST_WALKING_ROUTE") ||
      !Array.isArray(zone.locationIds) ||
      canonicalJson(zone.locationIds) !== canonicalJson(expectedLocationIds) ||
      !isRecord(zone.geometry) ||
      !Array.isArray(zone.activeDays) ||
      zone.activeDays.length === 0 ||
      !Number.isInteger(zone.priority) ||
      (zone.priority as number) <= 0 ||
      zone.maxDistanceMiles !== null ||
      zone.maxRouteMinutes !== null ||
      zone.minimumOrderCents !== null ||
      typeof zone.zoneDigest !== "string" ||
      !sha256.test(zone.zoneDigest) ||
      !isRecord(zone.feePolicyVersionIdByLocation) ||
      !isRecord(zone.feePolicyShellIdByLocation) ||
      !isRecord(zone.feePolicyShellDigestByLocation) ||
      !isRecord(zone.slotPolicyVersionIdByLocation) ||
      !isRecord(zone.slotPolicyDigestByLocation) ||
      Object.keys(zone.feePolicyVersionIdByLocation).length !== expected.candidates.length ||
      Object.keys(zone.feePolicyShellIdByLocation).length !== expected.candidates.length ||
      Object.keys(zone.feePolicyShellDigestByLocation).length !== expected.candidates.length ||
      Object.keys(zone.slotPolicyVersionIdByLocation).length !== expected.candidates.length ||
      Object.keys(zone.slotPolicyDigestByLocation).length !== expected.candidates.length
    ) {
      return false;
    }
    priorities.add(zone.priority as number);
    for (const locationId of expected.candidates) {
      const location = locationConfiguration[locationId];
      if (
        zone.feePolicyVersionIdByLocation[locationId] !==
          LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID ||
        zone.feePolicyShellIdByLocation[locationId] !== location.feePolicyId ||
        typeof zone.feePolicyShellDigestByLocation[locationId] !== "string" ||
        !sha256.test(zone.feePolicyShellDigestByLocation[locationId] as string) ||
        zone.slotPolicyVersionIdByLocation[locationId] !== location.slotPolicyId ||
        typeof zone.slotPolicyDigestByLocation[locationId] !== "string" ||
        !sha256.test(zone.slotPolicyDigestByLocation[locationId] as string)
      ) {
        return false;
      }
    }
  }

  return priorities.size === 5;
}

function canonicalZoneSetSnapshot(snapshot: Prisma.JsonValue | null) {
  return (
    isRecord(snapshot) &&
    snapshot.schemaVersion === zoneSetSchema &&
    snapshot.externalVersionId === LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID &&
    snapshot.revision === 1 &&
    snapshot.environment === "STAGING" &&
    snapshotLocationsAreCanonical(snapshot) &&
    snapshotZonesAreCanonical(snapshot)
  );
}

function publicationSnapshotFor(
  set: ZoneSetRecord,
  publication: ZoneSetRecord["publications"][number],
) {
  if (!isRecord(set.snapshot) || !Array.isArray(set.snapshot.zones)) return null;
  return {
    schemaVersion: zonePublicationSchema,
    publicationId: publication.id,
    versionNumber: publication.versionNumber,
    effectiveFrom: publication.effectiveFrom.toISOString(),
    effectiveTo: publication.effectiveTo?.toISOString() ?? null,
    digest: set.digest,
    zones: set.snapshot.zones.map((value) => {
      if (!isRecord(value)) return value;
      const published = { ...value };
      delete published.zoneDigest;
      delete published.feePolicyShellIdByLocation;
      delete published.feePolicyShellDigestByLocation;
      delete published.slotPolicyDigestByLocation;
      return published;
    }),
  };
}

function activeWalkingPublications(set: ZoneSetRecord, calculatedAt: Date) {
  return set.publications.filter(
    (publication) =>
      publication.status === "PUBLISHED" && effectiveAt(publication, calculatedAt),
  );
}

function isCanonicalZoneSet(set: ZoneSetRecord, calculatedAt: Date) {
  if (
    set.id !== zoneSetInternalId ||
    set.externalVersionId !== LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID ||
    set.revision !== 1 ||
    set.status !== "PUBLISHED" ||
    set.environment !== "STAGING" ||
    set.validatedAt === null ||
    set.publishedAt === null ||
    set.publishedById === null ||
    !effectiveAt(set, calculatedAt) ||
    !canonicalZoneSetSnapshot(set.snapshot) ||
    !validDigestForSnapshot(set.snapshot, set.digest)
  ) {
    return false;
  }

  const publications = activeWalkingPublications(set, calculatedAt);
  if (publications.length !== 1) return false;
  const publication = publications[0];
  const expectedSnapshot = publicationSnapshotFor(set, publication);
  return (
    publication.zoneSetVersionId === zoneSetInternalId &&
    Number.isInteger(publication.versionNumber) &&
    publication.versionNumber > 0 &&
    publication.schemaVersion === zonePublicationSchema &&
    publication.publishedById !== null &&
    publication.publishedAt instanceof Date &&
    publication.snapshot !== null &&
    expectedSnapshot !== null &&
    sameJson(publication.snapshot, expectedSnapshot) &&
    validDigestForSnapshot(publication.snapshot, publication.digest)
  );
}

function locationForCandidate(
  candidate: CandidateRecord,
  expected: CanonicalLocationConfiguration,
): LocalDeliveryLocation | null {
  const location = candidate.location;
  const identity = location.localDeliveryIdentity;
  const domain = LOCAL_WALKING_DELIVERY_V4_LOCATIONS[expected.externalId];
  if (
    candidate.locationId !== expected.operationalId ||
    location.id !== expected.operationalId ||
    location.code !== expected.code ||
    location.publicId !== expected.publicId ||
    location.name !== domain.name ||
    location.type !== "STORE" ||
    location.active !== true ||
    location.addressLine1 !== domain.address.split(",")[0] ||
    location.addressLine2 !== null ||
    location.city !== "New York" ||
    location.regionCode !== "NY" ||
    location.postalCode !== (expected.externalId === "third_avenue" ? "10021" : "10028") ||
    location.countryCode !== "US" ||
    location.timeZone !== "America/New_York" ||
    location.latitude === null ||
    !decimalEquals(location.latitude, Number(domain.latitude.toFixed(6))) ||
    location.longitude === null ||
    !decimalEquals(location.longitude, Number(domain.longitude.toFixed(6))) ||
    identity === null ||
    identity.id !== expected.identityId ||
    identity.operationalLocationId !== expected.operationalId ||
    identity.externalLocationId !== expected.externalId ||
    identity.displayName !== domain.name ||
    identity.addressLine1 !== domain.address.split(",")[0] ||
    identity.addressLine2 !== null ||
    identity.city !== "New York" ||
    identity.regionCode !== "NY" ||
    identity.postalCode !== (expected.externalId === "third_avenue" ? "10021" : "10028") ||
    identity.countryCode !== "US" ||
    !decimalEquals(identity.latitude, domain.latitude) ||
    !decimalEquals(identity.longitude, domain.longitude) ||
    identity.locationPriority !== expected.priority ||
    identity.active !== true
  ) {
    return null;
  }
  return {
    locationId: expected.externalId,
    name: domain.name,
    address: domain.address,
    coordinates: { latitude: domain.latitude, longitude: domain.longitude },
    priority: expected.priority,
  };
}

type FeePolicyShell = NonNullable<CandidateRecord["feePolicy"]>;
type SlotPolicyShell = NonNullable<CandidateRecord["slotPolicy"]>;

function feePolicyShellSnapshot(fee: FeePolicyShell) {
  return {
    schemaVersion: feePolicyShellSchema,
    id: fee.id,
    policyKey: fee.policyKey,
    versionNumber: fee.versionNumber,
    locationId: fee.locationId,
    serviceScope: fee.serviceScope,
    currency: fee.currency,
    baseFeeCents: fee.baseFeeCents,
    rateRules: fee.rateRules,
    exceptions: fee.exceptions,
    activeDays: [...fee.activeDays].sort(),
    effectiveFrom: fee.effectiveFrom?.toISOString() ?? null,
    effectiveTo: fee.effectiveTo?.toISOString() ?? null,
    calculationPolicyVersionId: fee.calculationPolicyVersionId,
  };
}

function slotPolicyShellSnapshot(slot: SlotPolicyShell) {
  return {
    schemaVersion: slotPolicyShellSchema,
    id: slot.id,
    policyKey: slot.policyKey,
    versionNumber: slot.versionNumber,
    locationId: slot.locationId,
    fulfillmentMode: slot.fulfillmentMode,
    activeDays: [...slot.activeDays].sort(),
    leadTimeMinutes: slot.leadTimeMinutes,
    cutoffMinuteOfDay: slot.cutoffMinuteOfDay,
    capacityPolicyRef: slot.capacityPolicyRef,
    effectiveFrom: slot.effectiveFrom?.toISOString() ?? null,
    effectiveTo: slot.effectiveTo?.toISOString() ?? null,
  };
}

function shellDigestMatches(
  shell: FeePolicyShell | SlotPolicyShell,
  expectedDigest: unknown,
) {
  if (
    shell.digest === null ||
    !sha256.test(shell.digest) ||
    expectedDigest !== shell.digest
  ) {
    return false;
  }
  try {
    const snapshot = "currency" in shell
      ? feePolicyShellSnapshot(shell)
      : slotPolicyShellSnapshot(shell);
    return stableSha256Digest(snapshot) === shell.digest;
  } catch {
    return false;
  }
}

function shellIsEffective(
  candidate: CandidateRecord,
  expected: CanonicalLocationConfiguration,
  zoneSnapshot: Record<string, unknown>,
  calculatedAt: Date,
) {
  const fee = candidate.feePolicy;
  const slot = candidate.slotPolicy;
  const feeVersionIds = zoneSnapshot.feePolicyVersionIdByLocation;
  const feeShellIds = zoneSnapshot.feePolicyShellIdByLocation;
  const feeShellDigests = zoneSnapshot.feePolicyShellDigestByLocation;
  const slotPolicyIds = zoneSnapshot.slotPolicyVersionIdByLocation;
  const slotPolicyDigests = zoneSnapshot.slotPolicyDigestByLocation;
  return (
    isRecord(feeVersionIds) &&
    isRecord(feeShellIds) &&
    isRecord(feeShellDigests) &&
    isRecord(slotPolicyIds) &&
    isRecord(slotPolicyDigests) &&
    feeVersionIds[expected.externalId] === LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID &&
    feeShellIds[expected.externalId] === expected.feePolicyId &&
    slotPolicyIds[expected.externalId] === expected.slotPolicyId &&
    candidate.feePolicyId === expected.feePolicyId &&
    fee !== null &&
    fee.id === expected.feePolicyId &&
    fee.policyKey === expected.feePolicyKey &&
    fee.versionNumber === 2 &&
    fee.locationId === expected.operationalId &&
    fee.serviceScope === "GENERAL_LOCAL_DELIVERY" &&
    fee.status === "PUBLISHED" &&
    fee.currency === "USD" &&
    fee.baseFeeCents === null &&
    fee.rateRules === null &&
    fee.exceptions === null &&
    fee.activeDays.length > 0 &&
    shellDigestMatches(fee, feeShellDigests[expected.externalId]) &&
    fee.calculationPolicyVersionId === feeVersionInternalId &&
    fee.publishedById !== null &&
    fee.publishedAt instanceof Date &&
    effectiveAt(fee, calculatedAt) &&
    fee.calculationPolicyVersion !== null &&
    isCanonicalFeeVersion(fee.calculationPolicyVersion, calculatedAt) &&
    candidate.slotPolicyId === expected.slotPolicyId &&
    slot !== null &&
    slot.id === expected.slotPolicyId &&
    slot.policyKey === expected.slotPolicyKey &&
    slot.versionNumber === 1 &&
    slot.locationId === expected.operationalId &&
    slot.fulfillmentMode === "WALKING_LOCAL_DELIVERY" &&
    slot.status === "PUBLISHED" &&
    slot.activeDays.length > 0 &&
    Number.isInteger(slot.leadTimeMinutes) &&
    slot.leadTimeMinutes !== null &&
    slot.leadTimeMinutes >= 0 &&
    Number.isInteger(slot.cutoffMinuteOfDay) &&
    slot.cutoffMinuteOfDay !== null &&
    slot.cutoffMinuteOfDay >= 0 &&
    slot.cutoffMinuteOfDay <= 1_439 &&
    typeof slot.capacityPolicyRef === "string" &&
    slot.capacityPolicyRef.trim().length > 0 &&
    shellDigestMatches(slot, slotPolicyDigests[expected.externalId]) &&
    slot.publishedById !== null &&
    slot.publishedAt instanceof Date &&
    effectiveAt(slot, calculatedAt)
  );
}

function matchingZoneSnapshot(
  set: ZoneSetRecord,
  postalCode: LocalWalkingDeliveryV4PostalCode,
) {
  if (!isRecord(set.snapshot) || !Array.isArray(set.snapshot.zones)) return null;
  const matches = set.snapshot.zones.filter(
    (value) =>
      isRecord(value) &&
      Array.isArray(value.postalCodes) &&
      value.postalCodes.length === 1 &&
      value.postalCodes[0] === postalCode,
  );
  return matches.length === 1 && isRecord(matches[0]) ? matches[0] : null;
}

function zoneRowMatchesSnapshot(
  zone: ZoneVersionRecord,
  snapshot: Record<string, unknown>,
) {
  return (
    snapshot.zoneVersionId === zone.id &&
    snapshot.id === zone.walkingZone.slug &&
    snapshot.priority === zone.priority &&
    snapshot.serviceMode === zone.serviceMode &&
    snapshot.assignmentStrategy === zone.assignmentStrategy &&
    sameJson(snapshot.postalCodes, zone.postalCodes) &&
    sameJson(snapshot.geometry, zone.geometry) &&
    sameJson(snapshot.activeDays, zone.activeDays) &&
    snapshot.maxDistanceMiles === null &&
    zone.maxDistanceMiles === null &&
    snapshot.maxRouteMinutes === zone.maxRouteMinutes &&
    snapshot.minimumOrderCents === zone.minimumOrderCents &&
    snapshot.zoneDigest === zone.digest
  );
}

function assignmentFromZone(
  zone: ZoneVersionRecord,
  postalCode: LocalWalkingDeliveryV4PostalCode,
  calculatedAt: Date,
): LocalDeliveryAssignment | null {
  const expected = zoneConfiguration[postalCode];
  if (
    zone.id !== expected.zoneId ||
    zone.walkingZoneId !== expected.walkingZoneId ||
    zone.versionNumber !== 1 ||
    zone.revision !== 1 ||
    zone.status !== "PUBLISHED" ||
    zone.serviceMode !== "WALKING" ||
    zone.assignmentStrategy !==
      (expected.rule === "FIXED_POSTAL_ZONE" ? "FIXED" : "NEAREST_WALKING_ROUTE") ||
    zone.postalCodes.length !== 1 ||
    zone.postalCodes[0] !== postalCode ||
    !Number.isInteger(zone.priority) ||
    zone.priority === null ||
    zone.priority <= 0 ||
    !isRecord(zone.geometry) ||
    zone.activeDays.length === 0 ||
    zone.maxDistanceMiles !== null ||
    zone.maxRouteMinutes !== null ||
    zone.minimumOrderCents !== null ||
    zone.digest === null ||
    !sha256.test(zone.digest) ||
    zone.validatedAt === null ||
    zone.publishedById === null ||
    zone.publishedAt === null ||
    !effectiveAt(zone, calculatedAt) ||
    zone.zoneSetVersionId !== zoneSetInternalId ||
    zone.walkingZone.id !== expected.walkingZoneId ||
    zone.walkingZone.slug !== expected.slug ||
    zone.walkingZone.currentVersionNumber !== 1 ||
    zone.walkingZone.archivedAt !== null ||
    zone.zoneSetVersion === null ||
    !isCanonicalZoneSet(zone.zoneSetVersion, calculatedAt) ||
    zone.candidates.length !== expected.candidates.length
  ) {
    return null;
  }

  const zoneSnapshot = matchingZoneSnapshot(zone.zoneSetVersion, postalCode);
  if (!zoneSnapshot || !zoneRowMatchesSnapshot(zone, zoneSnapshot)) return null;

  const candidatesByExternalId = new Map<LocalWalkingDeliveryV4LocationId, LocalDeliveryLocation>();
  for (const candidate of zone.candidates) {
    const identity = candidate.location.localDeliveryIdentity?.externalLocationId;
    if (identity !== "third_avenue" && identity !== "east_86th_street") return null;
    if (!expected.candidates.includes(identity) || candidatesByExternalId.has(identity)) return null;
    const configuration = locationConfiguration[identity];
    const location = locationForCandidate(candidate, configuration);
    if (!location || !shellIsEffective(candidate, configuration, zoneSnapshot, calculatedAt)) {
      return null;
    }
    candidatesByExternalId.set(identity, location);
  }

  const candidates = expected.candidates.map((id) => candidatesByExternalId.get(id));
  if (candidates.some((candidate) => candidate === undefined)) return null;
  if (expected.rule === "FIXED_POSTAL_ZONE") {
    return { rule: expected.rule, candidates: [candidates[0]!] };
  }
  return { rule: expected.rule, candidates: [candidates[0]!, candidates[1]!] };
}

/**
 * Server-only, read-only provider for the exact Local Walking Delivery V4
 * publication. It deliberately has no historical-policy fallback.
 */
export class PrismaLocalDeliveryPolicyProvider implements LocalDeliveryPolicyPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getPublishedPolicy(input: {
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
  }): Promise<LocalDeliveryPolicySnapshot | null> {
    const calculatedAt = parsedInstant(input.calculatedAt);
    if (input.environment !== "STAGING" || !calculatedAt) return null;
    try {
      const [versions, zoneSets] = await Promise.all([
        this.db.feeCalculationPolicyVersion.findMany({
          where: {
            id: feeVersionInternalId,
            externalVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
          },
          select: feeVersionSelect,
        }),
        this.db.walkingZoneSetVersion.findMany({
          where: {
            id: zoneSetInternalId,
            externalVersionId: LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
          },
          select: zoneSetSelect,
        }),
      ]);
      if (
        versions.length !== 1 ||
        zoneSets.length !== 1 ||
        !isCanonicalFeeVersion(versions[0], calculatedAt) ||
        !isCanonicalZoneSet(zoneSets[0], calculatedAt)
      ) {
        return null;
      }
      const version = versions[0];
      return {
        policyId: LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
        feePolicyVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
        zoneVersionId: LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID,
        environment: "STAGING",
        strategy: LOCAL_WALKING_DELIVERY_V4_STRATEGY,
        distanceBasis: LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
        distanceUnit: LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
        routingMode: LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE,
        currency: LOCAL_WALKING_DELIVERY_V4_CURRENCY,
        routingProfile: LOCAL_WALKING_DELIVERY_V4_ROUTING_PROFILE,
        quoteTtlSeconds: version.quoteTtlSeconds!,
        holdTtlSeconds: version.holdTtlSeconds!,
        preparationBufferSeconds: version.preparationBufferSeconds!,
        handoffBufferSeconds: version.handoffBufferSeconds!,
      };
    } catch {
      return null;
    }
  }

  async getAssignment(input: {
    postalCode: string;
    feePolicyVersionId: typeof LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID;
    zoneVersionId: typeof LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID;
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
  }): Promise<LocalDeliveryAssignment | null> {
    const calculatedAt = parsedInstant(input.calculatedAt);
    if (
      input.environment !== "STAGING" ||
      input.feePolicyVersionId !== LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID ||
      input.zoneVersionId !== LOCAL_WALKING_DELIVERY_V4_ZONE_VERSION_ID ||
      !calculatedAt ||
      !Object.hasOwn(zoneConfiguration, input.postalCode)
    ) {
      return null;
    }
    try {
      const zones = await this.db.walkingZoneVersion.findMany({
        where: {
          zoneSetVersionId: zoneSetInternalId,
          postalCodes: { has: input.postalCode },
        },
        select: zoneVersionSelect,
      });
      if (zones.length !== 1) return null;
      return assignmentFromZone(
        zones[0],
        input.postalCode as LocalWalkingDeliveryV4PostalCode,
        calculatedAt,
      );
    } catch {
      return null;
    }
  }

  async evaluateFee(input: {
    feePolicyVersionId: typeof LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID;
    environment: LocalDeliveryEnvironment;
    calculatedAt: string;
    walkingDistanceFeet: number;
  }): Promise<LocalDeliveryFee | null> {
    const calculatedAt = parsedInstant(input.calculatedAt);
    if (
      input.environment !== "STAGING" ||
      input.feePolicyVersionId !== LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID ||
      !calculatedAt
    ) {
      return null;
    }
    try {
      const versions = await this.db.feeCalculationPolicyVersion.findMany({
        where: {
          id: feeVersionInternalId,
          externalVersionId: LOCAL_WALKING_DELIVERY_V4_FEE_POLICY_VERSION_ID,
        },
        select: feeVersionSelect,
      });
      if (versions.length !== 1 || !isCanonicalFeeVersion(versions[0], calculatedAt)) {
        return null;
      }
      const result = evaluateLocalWalkingDeliveryV4Tier(input.walkingDistanceFeet);
      return result.valid
        ? { feeCents: result.feeCents, tierId: result.feeTierId }
        : null;
    } catch {
      return null;
    }
  }
}

export const prismaLocalDeliveryPolicyProvider = new PrismaLocalDeliveryPolicyProvider();
