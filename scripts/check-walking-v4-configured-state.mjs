import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const [
    enabledV4Flags,
    v4Publications,
    v2Quotes,
    holds,
    reservations,
    fee,
    zone,
    tiers,
    zones,
    candidates,
    latestMigrations,
    evidenceColumns,
  ] = await Promise.all([
    prisma.featureFlag.count({
      where: { key: { startsWith: "local_delivery_v4." }, enabled: true },
    }),
    prisma.walkingPublication.count(),
    prisma.walkingDeliveryQuote.count({
      where: { schemaVersion: "orderpro.walking-delivery-quote.v2" },
    }),
    prisma.walkingCapacityHold.count(),
    prisma.walkingInventoryReservation.count(),
    prisma.feeCalculationPolicyVersion.findUnique({
      where: {
        externalVersionId: "walking-route-distance-v4-base-10-2026-07-16",
      },
      select: { status: true, environment: true },
    }),
    prisma.walkingZoneSetVersion.findUnique({
      where: { externalVersionId: "upper-east-side-walking-zones-v1" },
      select: { status: true, environment: true },
    }),
    prisma.feeCalculationTier.count({
      where: {
        feePolicyVersion: {
          externalVersionId: "walking-route-distance-v4-base-10-2026-07-16",
        },
      },
    }),
    prisma.walkingZoneVersion.count({
      where: {
        zoneSetVersion: { externalVersionId: "upper-east-side-walking-zones-v1" },
      },
    }),
    prisma.walkingZoneCandidate.count({
      where: {
        walkingZoneVersion: {
          zoneSetVersion: { externalVersionId: "upper-east-side-walking-zones-v1" },
        },
      },
    }),
    prisma.$queryRawUnsafe(
      `SELECT migration_name AS "migrationName"
       FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY finished_at DESC
       LIMIT 4`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT table_name AS "tableName", column_name AS "columnName"
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'WalkingDeliveryQuoteInventoryLine' AND column_name IN (
             'inventoryOwnerExternalLocationId', 'inventoryNodeExternalId'
           )) OR
           (table_name = 'WalkingInventoryReservation' AND column_name IN (
             'orderLocationDecisionCode', 'orderLocationDecisionVersion',
             'inventoryAllocationStrategyId', 'inventoryAllocationStrategyVersion'
           ))
         )
       ORDER BY table_name, column_name`,
    ),
  ]);

  const state = {
    enabledV4Flags,
    v4Publications,
    v2Quotes,
    holds,
    reservations,
    fee,
    zone,
    tiers,
    zones,
    candidates,
    latestMigrations,
    evidenceColumnCount: evidenceColumns.length,
  };

  console.log(JSON.stringify(state, null, 2));

  const applied = new Set(latestMigrations.map(({ migrationName }) => migrationName));
  const safe =
    enabledV4Flags === 0 &&
    v4Publications === 0 &&
    v2Quotes === 0 &&
    holds === 0 &&
    reservations === 0 &&
    fee?.status === "DRAFT" &&
    fee.environment === "STAGING" &&
    zone?.status === "DRAFT" &&
    zone.environment === "STAGING" &&
    tiers === 10 &&
    zones === 5 &&
    candidates === 6 &&
    evidenceColumns.length === 6 &&
    applied.has("20260717113000_walking_delivery_v4_physical_reservation_parity") &&
    applied.has("20260717120000_walking_delivery_v4_inventory_quote_evidence") &&
    applied.has("20260717123000_walking_delivery_v4_inventory_validation_restore") &&
    applied.has("20260717124500_walking_delivery_v4_concurrency_clock_hardening");

  if (!safe) {
    throw new Error("Configured database does not match the expected safe V4 draft state");
  }
  console.log("PASS configured database remains in the safe V4 DRAFT/STAGING state");
} finally {
  await prisma.$disconnect();
}
