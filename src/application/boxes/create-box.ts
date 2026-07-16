import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type RoleCode } from "@prisma/client";
import { hasPermission } from "@/application/auth/permissions";
import { generateBoxCode } from "@/domain/inventory/box-code";
import { prisma } from "@/infrastructure/database/prisma";

export type CreateBoxCommand = {
  commandId: string;
  actorId: string;
  roles: RoleCode[];
  allowedLocationIds: string[];
  ownerLocationId: string;
  currentLocationId: string;
  correlationId: string;
};

export type CreateBoxResult = { containerId: string; code: string; status: "OPEN"; replayed: boolean };

function requestHash(command: CreateBoxCommand) {
  return createHash("sha256").update(JSON.stringify({ actorId: command.actorId, ownerLocationId: command.ownerLocationId, currentLocationId: command.currentLocationId })).digest("hex");
}

export async function createBox(command: CreateBoxCommand): Promise<CreateBoxResult> {
  if (!hasPermission(command.roles, "boxes.mutate")) throw new Error("FORBIDDEN");
  if (!command.allowedLocationIds.includes(command.ownerLocationId) || !command.allowedLocationIds.includes(command.currentLocationId)) throw new Error("LOCATION_FORBIDDEN");
  const hash = requestHash(command);

  return prisma.$transaction(async (transaction) => {
    const flag = await transaction.featureFlag.findUnique({ where: { key: "warehouse.box_creation" } });
    if (!flag?.enabled) throw new Error("FEATURE_DISABLED");
    const existing = await transaction.idempotencyRecord.findUnique({ where: { scope_key: { scope: "boxes.create", key: command.commandId } } });
    if (existing) {
      if (existing.requestHash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      const response = existing.responseBody as { containerId?: string; code?: string; status?: "OPEN" } | null;
      if (response?.containerId && response.code && response.status) {
        return { containerId: response.containerId, code: response.code, status: response.status, replayed: true };
      }
      throw new Error("COMMAND_IN_PROGRESS");
    }

    const idempotency = await transaction.idempotencyRecord.create({ data: { scope: "boxes.create", key: command.commandId, requestHash: hash, expiresAt: new Date(Date.now() + 86_400_000) } });
    const container = await transaction.container.create({ data: { code: generateBoxCode(), type: "BOX", status: "OPEN", ownerLocationId: command.ownerLocationId, currentLocationId: command.currentLocationId, manifests: { create: { version: 1, status: "DRAFT" } } } });
    const response = { containerId: container.id, code: container.code, status: "OPEN" as const };
    await transaction.auditEvent.create({ data: { actorId: command.actorId, action: "BOX_CREATED", entityType: "Container", entityId: container.id, locationCode: null, correlationId: command.correlationId, after: { code: container.code, ownerLocationId: command.ownerLocationId, currentLocationId: command.currentLocationId, status: "OPEN" } } });
    await transaction.outboxMessage.create({ data: { topic: "inventory.container.created", aggregateType: "Container", aggregateId: container.id, payload: { containerId: container.id, code: container.code, ownerLocationId: command.ownerLocationId, currentLocationId: command.currentLocationId } } });
    await transaction.idempotencyRecord.update({ where: { id: idempotency.id }, data: { responseStatus: 201, responseBody: response, completedAt: new Date() } });
    return { ...response, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
