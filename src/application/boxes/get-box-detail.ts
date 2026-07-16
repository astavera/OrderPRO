import "server-only";

import { isValidBoxCode, normalizeBoxCode } from "@/domain/inventory/box-code";
import { prisma } from "@/infrastructure/database/prisma";
import { visibleBoxWhere } from "./box-visibility";

export async function getBoxDetail(code: string, allowedLocationIds: readonly string[]) {
  const normalizedCode = normalizeBoxCode(code);
  if (!isValidBoxCode(normalizedCode) || allowedLocationIds.length === 0) return null;

  return prisma.container.findFirst({
    where: {
      AND: [visibleBoxWhere(allowedLocationIds), { code: normalizedCode }],
    },
    include: {
      ownerLocation: { select: { code: true, name: true, type: true } },
      currentLocation: { select: { code: true, name: true, type: true } },
      storageLocation: { select: { code: true, name: true } },
      manifests: {
        orderBy: { version: "desc" },
        take: 1,
        include: {
          lines: {
            orderBy: { createdAt: "asc" },
            include: {
              product: { select: { displayName: true } },
              inventoryLot: { select: { sourceReference: true, seasonCode: true } },
            },
          },
        },
      },
      contentProjection: {
        orderBy: { inventoryLotId: "asc" },
        include: {
          product: { select: { displayName: true } },
          inventoryLot: { select: { sourceReference: true, seasonCode: true } },
        },
      },
      sealEvents: { orderBy: { occurredAt: "desc" }, take: 20 },
      ledgerEntries: {
        orderBy: { sequence: "desc" },
        take: 50,
        include: { product: { select: { displayName: true } } },
      },
    },
  });
}
