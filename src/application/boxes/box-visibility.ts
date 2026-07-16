import type { Prisma } from "@prisma/client";

export type BoxLocationScope = {
  ownerLocationId: string;
  currentLocationId: string;
};

export function hasBoxLocationAccess(allowedLocationIds: readonly string[], box: BoxLocationScope) {
  return allowedLocationIds.includes(box.ownerLocationId) || allowedLocationIds.includes(box.currentLocationId);
}

export function visibleBoxWhere(allowedLocationIds: readonly string[]): Prisma.ContainerWhereInput {
  return {
    type: "BOX",
    OR: [
      { ownerLocationId: { in: [...allowedLocationIds] } },
      { currentLocationId: { in: [...allowedLocationIds] } },
    ],
  };
}
