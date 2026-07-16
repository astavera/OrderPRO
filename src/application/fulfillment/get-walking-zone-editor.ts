import "server-only";

import { hasPermission } from "@/application/auth/permissions";
import { activeLocationIds } from "@/application/auth/principal-access";
import { requirePermission } from "@/application/auth/current-principal";
import { prisma } from "@/infrastructure/database/prisma";

export async function getWalkingZoneEditorData(zoneId: string) {
  const { account } = await requirePermission("fulfillment.view");
  const allowedLocationIds = activeLocationIds(account);
  const roles = account.roles.map(({ role }) => role);
  const [zone, stores] = await Promise.all([
    prisma.walkingZone.findFirst({
      where: {
        id: zoneId,
        versions: { some: { candidates: { some: { locationId: { in: allowedLocationIds } } } } },
      },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          include: {
            candidates: {
              orderBy: { location: { code: "asc" } },
              include: {
                location: { select: { id: true, code: true, publicId: true, name: true } },
                feePolicy: { select: { id: true, policyKey: true, versionNumber: true, status: true } },
                slotPolicy: { select: { id: true, policyKey: true, versionNumber: true, status: true } },
              },
            },
          },
        },
      },
    }),
    prisma.operationalLocation.findMany({
      where: { id: { in: allowedLocationIds }, active: true, type: "STORE", publicId: { not: null } },
      orderBy: { code: "asc" },
      select: { id: true, code: true, publicId: true, name: true, addressLine1: true, city: true, regionCode: true },
    }),
  ]);

  if (!zone) return null;
  const version = zone.versions[0] ?? null;
  if (!version) return null;

  return {
    canManage: hasPermission(roles, "fulfillment.manage"),
    adminEnabled: (await prisma.featureFlag.findUnique({ where: { key: "walking_delivery.admin" } }))?.enabled ?? false,
    zone: { id: zone.id, slug: zone.slug, name: zone.name, currentVersionNumber: zone.currentVersionNumber },
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      revision: version.revision,
      status: version.status,
      assignmentStrategy: version.assignmentStrategy,
      postalCodes: version.postalCodes,
      priority: version.priority,
      geometry: version.geometry,
      activeDays: version.activeDays,
      maxDistanceMiles: version.maxDistanceMiles?.toString() ?? null,
      maxRouteMinutes: version.maxRouteMinutes,
      minimumOrderCents: version.minimumOrderCents,
      candidates: version.candidates.map((candidate) => ({
        location: candidate.location,
        feePolicy: candidate.feePolicy,
        slotPolicy: candidate.slotPolicy,
      })),
    },
    stores,
  };
}
