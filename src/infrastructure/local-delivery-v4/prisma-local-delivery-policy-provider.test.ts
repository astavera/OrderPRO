import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
} from "../../application/local-delivery-v4/contracts";
import {
  LOCAL_WALKING_DELIVERY_V4_TIERS,
} from "../../domain/walking-delivery/local-walking-delivery-v4";
import { stableSha256Digest } from "../../domain/walking-delivery/canonical-json";

vi.mock("server-only", () => ({}));

import { PrismaLocalDeliveryPolicyProvider } from "./prisma-local-delivery-policy-provider";

const calculatedAt = "2026-07-20T16:00:00.000Z";
const effectiveFrom = new Date("2026-07-01T00:00:00.000Z");
const effectiveTo = new Date("2026-08-01T00:00:00.000Z");
const publishedAt = new Date("2026-06-30T12:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const feePolicyInternalId = "00000000-0000-4000-8500-000000000001";
const feeVersionInternalId = "00000000-0000-4000-8510-000000000001";
const zoneSetInternalId = "00000000-0000-4000-8600-000000000001";
const feePublicationId = "30000000-0000-4000-8000-000000000001";
const walkingPublicationId = "40000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

const locations = {
  third_avenue: {
    identityId: "00000000-0000-4000-8610-000000000072",
    operationalId: "00000000-0000-4000-8000-000000000072",
    code: "ST72",
    publicId: "store-3rd-avenue",
    name: "3rd Avenue Store",
    line1: "1243 3rd Ave",
    postalCode: "10021",
    latitude: 40.769473514641,
    longitude: -73.960715741688,
    priority: 1,
    feePolicyId: "00000000-0000-4000-8100-000000000172",
    feePolicyKey: "walking-fee-third-avenue",
    slotPolicyId: "00000000-0000-4000-8200-000000000072",
    slotPolicyKey: "walking-slots-third-avenue",
  },
  east_86th_street: {
    identityId: "00000000-0000-4000-8610-000000000086",
    operationalId: "00000000-0000-4000-8000-000000000086",
    code: "ST86",
    publicId: "store-86th-street",
    name: "86th Street Store",
    line1: "112 E 86th St",
    postalCode: "10028",
    latitude: 40.779922307507,
    longitude: -73.956748615355,
    priority: 2,
    feePolicyId: "00000000-0000-4000-8100-000000000186",
    feePolicyKey: "walking-fee-86th-street",
    slotPolicyId: "00000000-0000-4000-8200-000000000086",
    slotPolicyKey: "walking-slots-86th-street",
  },
} as const;

function feePolicyShellDigest(locationId: keyof typeof locations) {
  const location = locations[locationId];
  return stableSha256Digest({
    schemaVersion: "orderpro.walking-fee-policy-shell.v1",
    id: location.feePolicyId,
    policyKey: location.feePolicyKey,
    versionNumber: 2,
    locationId: location.operationalId,
    serviceScope: "GENERAL_LOCAL_DELIVERY",
    currency: "USD",
    baseFeeCents: null,
    rateRules: null,
    exceptions: null,
    activeDays: ["MONDAY"],
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveTo: effectiveTo.toISOString(),
    calculationPolicyVersionId: feeVersionInternalId,
  });
}

function slotPolicyShellDigest(locationId: keyof typeof locations) {
  const location = locations[locationId];
  return stableSha256Digest({
    schemaVersion: "orderpro.walking-slot-policy-shell.v1",
    id: location.slotPolicyId,
    policyKey: location.slotPolicyKey,
    versionNumber: 1,
    locationId: location.operationalId,
    fulfillmentMode: "WALKING_LOCAL_DELIVERY",
    activeDays: ["MONDAY"],
    leadTimeMinutes: 30,
    cutoffMinuteOfDay: 1_020,
    capacityPolicyRef: "walking-capacity-v1",
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveTo: effectiveTo.toISOString(),
  });
}

const zones = {
  "10021": {
    id: "20021000-0000-4000-8000-000000000101",
    walkingZoneId: "20021000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10021",
    assignmentStrategy: "FIXED",
    candidateIds: ["third_avenue"],
  },
  "10065": {
    id: "20065000-0000-4000-8000-000000000101",
    walkingZoneId: "20065000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10065",
    assignmentStrategy: "FIXED",
    candidateIds: ["third_avenue"],
  },
  "10075": {
    id: "20075000-0000-4000-8000-000000000101",
    walkingZoneId: "20075000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10075",
    assignmentStrategy: "NEAREST_WALKING_ROUTE",
    candidateIds: ["third_avenue", "east_86th_street"],
  },
  "10028": {
    id: "20028000-0000-4000-8000-000000000101",
    walkingZoneId: "20028000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10028",
    assignmentStrategy: "FIXED",
    candidateIds: ["east_86th_street"],
  },
  "10128": {
    id: "20128000-0000-4000-8000-000000000101",
    walkingZoneId: "20128000-0000-4000-8000-000000000001",
    slug: "local-v4-walking-10128",
    assignmentStrategy: "FIXED",
    candidateIds: ["east_86th_street"],
  },
} as const;

function feeVersion() {
  const tiers = LOCAL_WALKING_DELIVERY_V4_TIERS.map((tier, index) => ({
    id: `00000000-0000-4000-8520-${String(index + 1).padStart(12, "0")}`,
    feePolicyVersionId: feeVersionInternalId,
    tierKey: tier.id,
    sequence: index + 1,
    lowerExclusiveFeet:
      tier.minimumExclusiveFeet === null ? null : new Prisma.Decimal(tier.minimumExclusiveFeet),
    upperInclusiveFeet:
      tier.maximumInclusiveFeet === null ? null : new Prisma.Decimal(tier.maximumInclusiveFeet),
    feeCents: tier.feeCents,
    automatic: true,
    reasonCode: "ELIGIBLE",
  }));
  const snapshot = {
    schemaVersion: "orderpro.walking-route-distance-fee.v2",
    policyId: "walking-route-distance-v4-base-10",
    internalPolicyId: feePolicyInternalId,
    versionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
    internalVersionId: feeVersionInternalId,
    versionNumber: 1,
    revision: 1,
    environment: "STAGING",
    strategy: "WALKING_ROUTE_DISTANCE",
    distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
    quoteTtlSeconds: 900,
    holdTtlSeconds: 300,
    preparationBufferSeconds: 180,
    handoffBufferSeconds: 120,
    currency: "USD",
    routingProfile: "walking",
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
  const snapshotDigest = stableSha256Digest(snapshot);
  return {
    id: feeVersionInternalId,
    feeCalculationPolicyId: feePolicyInternalId,
    versionKey: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
    externalVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
    versionNumber: 1,
    revision: 1,
    status: "PUBLISHED",
    environment: "STAGING",
    strategy: "WALKING_ROUTE_DISTANCE",
    currency: "USD",
    routingProfile: "walking",
    distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
    quoteTtlSeconds: 900,
    holdTtlSeconds: 300,
    preparationBufferSeconds: 180,
    handoffBufferSeconds: 120,
    snapshot,
    digest: snapshotDigest,
    effectiveFrom,
    effectiveTo,
    validatedAt: publishedAt,
    publishedById: ownerId,
    publishedAt,
    feeCalculationPolicy: {
      id: feePolicyInternalId,
      code: "WALKING_ROUTE_DISTANCE_V4_BASE_10",
      externalPolicyId: "walking-route-distance-v4-base-10",
    },
    tiers,
    publications: [{
      id: feePublicationId,
      feeCalculationPolicyId: feePolicyInternalId,
      feePolicyVersionId: feeVersionInternalId,
      publicationNumber: 1,
      schemaVersion: "orderpro.walking-route-distance-fee.v2",
      status: "PUBLISHED",
      snapshot,
      digest: snapshotDigest,
      effectiveFrom,
      effectiveTo,
      publishedById: ownerId,
      publishedAt,
    }],
  };
}

function zoneSet() {
  const snapshotLocations = Object.entries(locations).map(([id, location]) => ({
    id,
    localDeliveryLocationIdentityId: location.identityId,
    operationalLocationId: location.operationalId,
    code: location.code,
    publicId: location.publicId,
    name: location.name,
    addressLine1: location.line1,
    addressLine2: null,
    city: "New York",
    regionCode: "NY",
    postalCode: location.postalCode,
    countryCode: "US",
    latitude: location.latitude,
    longitude: location.longitude,
    locationPriority: location.priority,
  }));
  const snapshotZones = Object.entries(zones).map(([postalCode, zone], index) => {
    const feePolicyVersionIdByLocation: Record<string, string> = {};
    const feePolicyShellIdByLocation: Record<string, string> = {};
    const feePolicyShellDigestByLocation: Record<string, string> = {};
    const slotPolicyVersionIdByLocation: Record<string, string> = {};
    const slotPolicyDigestByLocation: Record<string, string> = {};
    for (const locationId of zone.candidateIds) {
      const location = locations[locationId];
      feePolicyVersionIdByLocation[locationId] = LOCAL_DELIVERY_FEE_POLICY_VERSION_ID;
      feePolicyShellIdByLocation[locationId] = location.feePolicyId;
      feePolicyShellDigestByLocation[locationId] = feePolicyShellDigest(locationId);
      slotPolicyVersionIdByLocation[locationId] = location.slotPolicyId;
      slotPolicyDigestByLocation[locationId] = slotPolicyShellDigest(locationId);
    }
    return {
      id: zone.slug,
      zoneVersionId: zone.id,
      name: `Walking ${postalCode}`,
      postalCodes: [postalCode],
      priority: index + 1,
      serviceMode: "WALKING",
      assignmentStrategy: zone.assignmentStrategy,
      locationIds: [...zone.candidateIds].sort(),
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] },
      activeDays: ["MONDAY"],
      maxDistanceMiles: null,
      maxRouteMinutes: null,
      minimumOrderCents: null,
      zoneDigest: digest,
      feePolicyVersionIdByLocation,
      feePolicyShellIdByLocation,
      feePolicyShellDigestByLocation,
      slotPolicyVersionIdByLocation,
      slotPolicyDigestByLocation,
    };
  });
  const snapshot = {
    schemaVersion: "orderpro.walking-zone-set.v1",
    externalVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
    revision: 1,
    environment: "STAGING",
    locations: snapshotLocations,
    zones: snapshotZones,
  };
  const setDigest = stableSha256Digest(snapshot);
  const publicationSnapshot = {
    schemaVersion: "orderpro.walking-zones.v1",
    publicationId: walkingPublicationId,
    versionNumber: 1,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveTo: effectiveTo.toISOString(),
    digest: setDigest,
    zones: snapshotZones.map((zone) => {
      const published: Record<string, unknown> = { ...zone };
      delete published.zoneDigest;
      delete published.feePolicyShellIdByLocation;
      delete published.feePolicyShellDigestByLocation;
      delete published.slotPolicyDigestByLocation;
      return published;
    }),
  };
  return {
    id: zoneSetInternalId,
    externalVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
    revision: 1,
    status: "PUBLISHED",
    environment: "STAGING",
    snapshot,
    digest: setDigest,
    effectiveFrom,
    effectiveTo,
    validatedAt: publishedAt,
    publishedById: ownerId,
    publishedAt,
    publications: [{
      id: walkingPublicationId,
      versionNumber: 1,
      schemaVersion: "orderpro.walking-zones.v1",
      status: "PUBLISHED",
      snapshot: publicationSnapshot,
      digest: stableSha256Digest(publicationSnapshot),
      effectiveFrom,
      effectiveTo,
      zoneSetVersionId: zoneSetInternalId,
      publishedById: ownerId,
      publishedAt,
    }],
  };
}

function candidate(locationId: keyof typeof locations) {
  const location = locations[locationId];
  return {
    locationId: location.operationalId,
    feePolicyId: location.feePolicyId,
    slotPolicyId: location.slotPolicyId,
    location: {
      id: location.operationalId,
      code: location.code,
      publicId: location.publicId,
      name: location.name,
      type: "STORE",
      active: true,
      addressLine1: location.line1,
      addressLine2: null,
      city: "New York",
      regionCode: "NY",
      postalCode: location.postalCode,
      countryCode: "US",
      timeZone: "America/New_York",
      latitude: new Prisma.Decimal(location.latitude.toFixed(6)),
      longitude: new Prisma.Decimal(location.longitude.toFixed(6)),
      localDeliveryIdentity: {
        id: location.identityId,
        operationalLocationId: location.operationalId,
        externalLocationId: locationId,
        displayName: location.name,
        addressLine1: location.line1,
        addressLine2: null,
        city: "New York",
        regionCode: "NY",
        postalCode: location.postalCode,
        countryCode: "US",
        latitude: new Prisma.Decimal(location.latitude),
        longitude: new Prisma.Decimal(location.longitude),
        locationPriority: location.priority,
        active: true,
      },
    },
    feePolicy: {
      id: location.feePolicyId,
      policyKey: location.feePolicyKey,
      versionNumber: 2,
      locationId: location.operationalId,
      serviceScope: "GENERAL_LOCAL_DELIVERY",
      status: "PUBLISHED",
      currency: "USD",
      baseFeeCents: null,
      rateRules: null,
      exceptions: null,
      activeDays: ["MONDAY"],
      effectiveFrom,
      effectiveTo,
      digest: feePolicyShellDigest(locationId),
      calculationPolicyVersionId: feeVersionInternalId,
      publishedById: ownerId,
      publishedAt,
      calculationPolicyVersion: feeVersion(),
    },
    slotPolicy: {
      id: location.slotPolicyId,
      policyKey: location.slotPolicyKey,
      versionNumber: 1,
      locationId: location.operationalId,
      fulfillmentMode: "WALKING_LOCAL_DELIVERY",
      status: "PUBLISHED",
      activeDays: ["MONDAY"],
      leadTimeMinutes: 30,
      cutoffMinuteOfDay: 1_020,
      capacityPolicyRef: "walking-capacity-v1",
      effectiveFrom,
      effectiveTo,
      digest: slotPolicyShellDigest(locationId),
      publishedById: ownerId,
      publishedAt,
    },
  };
}

function zoneVersion(postalCode: keyof typeof zones = "10075") {
  const zone = zones[postalCode];
  return {
    id: zone.id,
    walkingZoneId: zone.walkingZoneId,
    versionNumber: 1,
    revision: 1,
    status: "PUBLISHED",
    serviceMode: "WALKING",
    assignmentStrategy: zone.assignmentStrategy,
    postalCodes: [postalCode],
    priority: Object.keys(zones).indexOf(postalCode) + 1,
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] },
    activeDays: ["MONDAY"],
    maxDistanceMiles: null,
    maxRouteMinutes: null,
    minimumOrderCents: null,
    digest,
    effectiveFrom,
    effectiveTo,
    validatedAt: publishedAt,
    publishedById: ownerId,
    publishedAt,
    zoneSetVersionId: zoneSetInternalId,
    walkingZone: {
      id: zone.walkingZoneId,
      slug: zone.slug,
      currentVersionNumber: 1,
      archivedAt: null,
    },
    zoneSetVersion: zoneSet(),
    candidates: zone.candidateIds.map(candidate),
  };
}

function mockDb(input: {
  feeVersions?: unknown[];
  zoneSets?: unknown[];
  zoneVersions?: unknown[];
  rejects?: boolean;
} = {}) {
  const failure = new Error("database unavailable");
  const feeFindMany = vi.fn(async () => {
    if (input.rejects) throw failure;
    return input.feeVersions ?? [feeVersion()];
  });
  const setFindMany = vi.fn(async () => {
    if (input.rejects) throw failure;
    return input.zoneSets ?? [zoneSet()];
  });
  const zoneFindMany = vi.fn(async () => {
    if (input.rejects) throw failure;
    return input.zoneVersions ?? [zoneVersion()];
  });
  return {
    client: {
      feeCalculationPolicyVersion: { findMany: feeFindMany },
      walkingZoneSetVersion: { findMany: setFindMany },
      walkingZoneVersion: { findMany: zoneFindMany },
    } as unknown as PrismaClient,
    feeFindMany,
    setFindMany,
    zoneFindMany,
  };
}

const policyInput = { environment: "STAGING" as const, calculatedAt };
const assignmentInput = {
  postalCode: "10075",
  feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
  environment: "STAGING" as const,
  calculatedAt,
};

describe("PrismaLocalDeliveryPolicyProvider", () => {
  it("returns the exact published/effective V4 policy and queries only its internal identities", async () => {
    const db = mockDb();
    const result = await new PrismaLocalDeliveryPolicyProvider(db.client).getPublishedPolicy(
      policyInput,
    );

    expect(result).toEqual({
      policyId: "walking-route-distance-v4-base-10",
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
      environment: "STAGING",
      strategy: "WALKING_ROUTE_DISTANCE",
      distanceBasis: "ONE_WAY_FROM_SELECTED_STORE",
      distanceUnit: "FEET",
      routingMode: "WALKING",
      currency: "USD",
      routingProfile: "walking",
      quoteTtlSeconds: 900,
      holdTtlSeconds: 300,
      preparationBufferSeconds: 180,
      handoffBufferSeconds: 120,
    });
    expect(db.feeFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: feeVersionInternalId,
        externalVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      },
    }));
    expect(db.setFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: zoneSetInternalId,
        externalVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
      },
    }));
  });

  it.each([
    ["missing fee version", { feeVersions: [] }],
    ["ambiguous fee version", { feeVersions: [feeVersion(), feeVersion()] }],
    ["missing zone set", { zoneSets: [] }],
    ["ambiguous zone set", { zoneSets: [zoneSet(), zoneSet()] }],
  ])("fails closed for %s", async (_label, seeds) => {
    const db = mockDb(seeds);
    await expect(
      new PrismaLocalDeliveryPolicyProvider(db.client).getPublishedPolicy(policyInput),
    ).resolves.toBeNull();
  });

  it("rejects unpublished, expired, ambiguously published and relationally drifted fee state", async () => {
    const unpublished = { ...feeVersion(), status: "VALIDATED" };
    const expired = { ...feeVersion(), effectiveTo: new Date("2026-07-10T00:00:00.000Z") };
    const ambiguous = feeVersion();
    ambiguous.publications = [...ambiguous.publications, { ...ambiguous.publications[0], id: `${feePublicationId}-2` }];
    const tierDrift = feeVersion();
    tierDrift.tiers[1] = { ...tierDrift.tiers[1], feeCents: 999 as never };
    const snapshotDrift = feeVersion();
    snapshotDrift.snapshot = { ...snapshotDrift.snapshot, currency: "CAD" };

    for (const version of [unpublished, expired, ambiguous, tierDrift, snapshotDrift]) {
      const db = mockDb({ feeVersions: [version] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getPublishedPolicy(policyInput),
      ).resolves.toBeNull();
    }
  });

  it("rejects unpublished, expired, ambiguously published and snapshot-drifted zone state", async () => {
    const unpublished = { ...zoneSet(), status: "VALIDATED" };
    const expired = { ...zoneSet(), effectiveTo: new Date("2026-07-10T00:00:00.000Z") };
    const ambiguous = zoneSet();
    ambiguous.publications = [...ambiguous.publications, { ...ambiguous.publications[0], id: `${walkingPublicationId}-2` }];
    const drifted = zoneSet();
    drifted.snapshot = { ...drifted.snapshot, environment: "PRODUCTION" };

    for (const set of [unpublished, expired, ambiguous, drifted]) {
      const db = mockDb({ zoneSets: [set] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getPublishedPolicy(policyInput),
      ).resolves.toBeNull();
    }
  });

  it("rejects production or malformed instants without touching Prisma", async () => {
    const db = mockDb();
    const provider = new PrismaLocalDeliveryPolicyProvider(db.client);
    await expect(provider.getPublishedPolicy({
      environment: "PRODUCTION",
      calculatedAt,
    })).resolves.toBeNull();
    await expect(provider.getPublishedPolicy({
      environment: "STAGING",
      calculatedAt: "2026-07-20",
    })).resolves.toBeNull();
    await expect(provider.getPublishedPolicy({
      environment: "STAGING",
      calculatedAt: "2026-02-31T12:00:00.000Z",
    })).resolves.toBeNull();
    expect(db.feeFindMany).not.toHaveBeenCalled();
    expect(db.setFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ["10021", "FIXED_POSTAL_ZONE", ["third_avenue"]],
    ["10065", "FIXED_POSTAL_ZONE", ["third_avenue"]],
    ["10075", "NEAREST_WALKING_ROUTE", ["third_avenue", "east_86th_street"]],
    ["10028", "FIXED_POSTAL_ZONE", ["east_86th_street"]],
    ["10128", "FIXED_POSTAL_ZONE", ["east_86th_street"]],
  ])("returns the canonical assignment for %s", async (postalCode, rule, locationIds) => {
    const db = mockDb({ zoneVersions: [zoneVersion(postalCode as keyof typeof zones)] });
    const result = await new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment({
      ...assignmentInput,
      postalCode,
    });
    expect(result?.rule).toBe(rule);
    expect(result?.candidates.map(({ locationId }) => locationId)).toEqual(locationIds);
    expect(result?.candidates.map(({ priority }) => priority)).toEqual(
      locationIds.map((id) => locations[id as keyof typeof locations].priority),
    );
    expect(db.zoneFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        zoneSetVersionId: zoneSetInternalId,
        postalCodes: { has: postalCode },
      },
    }));
  });

  it("requires exactly one canonical zone and never falls back to another ZIP topology", async () => {
    for (const zoneVersions of [[], [zoneVersion(), zoneVersion()], [zoneVersion("10021")]]) {
      const db = mockDb({ zoneVersions });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment(assignmentInput),
      ).resolves.toBeNull();
    }
  });

  it("rejects candidate identity, coordinates, priority, fee shell, slot shell and delegated publication drift", async () => {
    const identity = zoneVersion();
    identity.candidates[0].location.localDeliveryIdentity.externalLocationId = "wrong_store" as never;
    const coordinates = zoneVersion();
    coordinates.candidates[0].location.latitude = null as never;
    const priority = zoneVersion();
    priority.candidates[0].location.localDeliveryIdentity.locationPriority = 2;
    const feeShell = zoneVersion();
    feeShell.candidates[0].feePolicy.policyKey = "walking-fee-historical" as never;
    const slotShell = zoneVersion();
    slotShell.candidates[0].slotPolicy.status = "VALIDATED";
    const delegatedPublication = zoneVersion();
    delegatedPublication.candidates[0].feePolicy.calculationPolicyVersion.publications = [];

    for (const version of [
      identity,
      coordinates,
      priority,
      feeShell,
      slotShell,
      delegatedPublication,
    ]) {
      const db = mockDb({ zoneVersions: [version] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment(assignmentInput),
      ).resolves.toBeNull();
    }
  });

  it("binds live zone geometry, days, priority and digest to the published zone-set snapshot", async () => {
    const geometry = zoneVersion();
    geometry.geometry = { type: "Polygon", coordinates: [[[9, 9], [8, 9], [9, 9]]] };
    const days = zoneVersion();
    days.activeDays = ["TUESDAY"];
    const priority = zoneVersion();
    priority.priority = 99;
    const rowDigest = zoneVersion();
    rowDigest.digest = `sha256:${"b".repeat(64)}`;

    for (const version of [geometry, days, priority, rowDigest]) {
      const db = mockDb({ zoneVersions: [version] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment(assignmentInput),
      ).resolves.toBeNull();
    }
  });

  it("binds live fee and slot shell digests to the published topology snapshot", async () => {
    const feeDigest = zoneVersion();
    feeDigest.candidates[0].feePolicy.digest = `sha256:${"b".repeat(64)}`;
    const slotDigest = zoneVersion();
    slotDigest.candidates[0].slotPolicy.digest = `sha256:${"b".repeat(64)}`;

    for (const version of [feeDigest, slotDigest]) {
      const db = mockDb({ zoneVersions: [version] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment(assignmentInput),
      ).resolves.toBeNull();
    }
  });

  it("recomputes shell digests and rejects live scheduling drift with the old digest intact", async () => {
    const feeDays = zoneVersion();
    feeDays.candidates[0].feePolicy.activeDays = ["TUESDAY"];
    const slotDays = zoneVersion();
    slotDays.candidates[0].slotPolicy.activeDays = ["TUESDAY"];
    const leadTime = zoneVersion();
    leadTime.candidates[0].slotPolicy.leadTimeMinutes = 45;
    const cutoff = zoneVersion();
    cutoff.candidates[0].slotPolicy.cutoffMinuteOfDay = 900;
    const capacityPolicy = zoneVersion();
    capacityPolicy.candidates[0].slotPolicy.capacityPolicyRef = "walking-capacity-v2";

    for (const version of [feeDays, slotDays, leadTime, cutoff, capacityPolicy]) {
      const db = mockDb({ zoneVersions: [version] });
      await expect(
        new PrismaLocalDeliveryPolicyProvider(db.client).getAssignment(assignmentInput),
      ).resolves.toBeNull();
    }
  });

  it("rejects unsupported ZIPs, wrong version/environment and malformed assignment instants before querying", async () => {
    const db = mockDb();
    const provider = new PrismaLocalDeliveryPolicyProvider(db.client);
    const invalid = [
      { ...assignmentInput, postalCode: "10022" },
      { ...assignmentInput, environment: "PRODUCTION" as const },
      { ...assignmentInput, feePolicyVersionId: "historical" as never },
      { ...assignmentInput, zoneVersionId: "historical" as never },
      { ...assignmentInput, calculatedAt: "not-an-instant" },
    ];
    for (const input of invalid) {
      await expect(provider.getAssignment(input)).resolves.toBeNull();
    }
    expect(db.zoneFindMany).not.toHaveBeenCalled();
  });

  it.each([
    [0, "free-local", 0],
    [1_200, "free-local", 0],
    [1_200.01, "base-delivery", 1_000],
    [2_200, "base-delivery", 1_000],
    [2_200.01, "extended-12", 1_200],
    [2_700, "extended-12", 1_200],
    [2_700.01, "extended-14", 1_400],
    [2_950, "extended-14", 1_400],
    [2_950.01, "extended-15", 1_500],
    [3_250, "extended-15", 1_500],
    [3_250.01, "extended-17", 1_700],
    [3_500, "extended-17", 1_700],
    [3_500.01, "extended-19", 1_900],
    [3_750, "extended-19", 1_900],
    [3_750.01, "extended-21", 2_100],
    [4_000, "extended-21", 2_100],
    [4_000.01, "extended-23", 2_300],
    [4_250, "extended-23", 2_300],
    [4_250.01, "whole-zone-25", 2_500],
    [10_000, "whole-zone-25", 2_500],
  ])("uses the canonical ten-tier evaluation at %s ft", async (walkingDistanceFeet, tierId, feeCents) => {
    const db = mockDb();
    await expect(new PrismaLocalDeliveryPolicyProvider(db.client).evaluateFee({
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      environment: "STAGING",
      calculatedAt,
      walkingDistanceFeet,
    })).resolves.toEqual({ tierId, feeCents });
  });

  it("never evaluates from a historical or drifted matrix and rejects invalid distances", async () => {
    const historical = feeVersion();
    historical.feeCalculationPolicy.code = "WALKING_ROUTE_DISTANCE_STANDARD";
    const drifted = feeVersion();
    drifted.tiers[1] = { ...drifted.tiers[1], upperInclusiveFeet: new Prisma.Decimal(2_300) };
    for (const version of [historical, drifted]) {
      const db = mockDb({ feeVersions: [version] });
      await expect(new PrismaLocalDeliveryPolicyProvider(db.client).evaluateFee({
        feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
        environment: "STAGING",
        calculatedAt,
        walkingDistanceFeet: 1_500,
      })).resolves.toBeNull();
    }

    const db = mockDb();
    const provider = new PrismaLocalDeliveryPolicyProvider(db.client);
    for (const walkingDistanceFeet of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(provider.evaluateFee({
        feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
        environment: "STAGING",
        calculatedAt,
        walkingDistanceFeet,
      })).resolves.toBeNull();
    }
  });

  it("fails closed on Prisma errors for every operation", async () => {
    const db = mockDb({ rejects: true });
    const provider = new PrismaLocalDeliveryPolicyProvider(db.client);
    await expect(provider.getPublishedPolicy(policyInput)).resolves.toBeNull();
    await expect(provider.getAssignment(assignmentInput)).resolves.toBeNull();
    await expect(provider.evaluateFee({
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      environment: "STAGING",
      calculatedAt,
      walkingDistanceFeet: 1_500,
    })).resolves.toBeNull();
  });
});
