import "server-only";
import type { RoleCode } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/application/auth/current-principal";
import { roleCodes } from "@/application/auth/permissions";
import { prisma } from "@/infrastructure/database/prisma";
import { getApplicationUrl } from "@/infrastructure/config/application-url";
import { createSupabaseAdminClient, isSupabaseAdminConfigured } from "@/infrastructure/supabase/admin";
import {
  uniqueValues,
  validateAdministrativeSafety,
  validateRoleLocationCompatibility,
  validateUserAccessDraft,
  type UserAccessPolicyFailure,
} from "./user-management-policy";

export type UserManagementErrorCode =
  | UserAccessPolicyFailure
  | "ADMIN_AUTH_NOT_CONFIGURED"
  | "APPLICATION_URL_NOT_CONFIGURED"
  | "AUTH_INVITE_FAILED"
  | "INVALID_LOCATION"
  | "USER_ALREADY_MANAGED"
  | "USER_NOT_FOUND"
  | "VERSION_CONFLICT";

export type InviteManagedUserInput = {
  displayName: string;
  email: string;
  roles: RoleCode[];
  locationIds: string[];
  correlationId: string;
};

export type UpdateManagedUserInput = {
  userId: string;
  expectedVersion: number;
  displayName: string;
  active: boolean;
  roles: RoleCode[];
  locationIds: string[];
  reason: string;
  correlationId: string;
};

const userInclude = {
  roles: { orderBy: { role: "asc" as const } },
  locations: { include: { location: true }, orderBy: { location: { code: "asc" as const } } },
};

function fail(code: UserManagementErrorCode): never {
  throw new Error(code);
}

function normalizeAccess(roles: RoleCode[], locationIds: string[]) {
  return { roles: uniqueValues(roles), locationIds: uniqueValues(locationIds) };
}

async function loadActiveLocations(locationIds: string[]) {
  const locations = await prisma.operationalLocation.findMany({
    where: { id: { in: locationIds }, active: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true },
  });
  if (locations.length !== locationIds.length) fail("INVALID_LOCATION");
  return locations;
}

async function findAuthUserByEmail(email: string) {
  const admin = createSupabaseAdminClient();
  if (!admin) fail("ADMIN_AUTH_NOT_CONFIGURED");
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
  if (error) fail("AUTH_INVITE_FAILED");
  return data.users.find((user) => user.email?.toLowerCase() === email) ?? null;
}

async function ensureInvitedAuthUser(input: InviteManagedUserInput) {
  const admin = createSupabaseAdminClient();
  if (!admin) fail("ADMIN_AUTH_NOT_CONFIGURED");
  const applicationUrl = getApplicationUrl();
  if (!applicationUrl) fail("APPLICATION_URL_NOT_CONFIGURED");

  const invitation = await admin.auth.admin.inviteUserByEmail(input.email, {
    data: { display_name: input.displayName },
    redirectTo: `${applicationUrl}/accept-invite`,
  });
  if (invitation.data.user) return { user: invitation.data.user, created: true, admin };

  const existing = await findAuthUserByEmail(input.email);
  if (!existing) fail("AUTH_INVITE_FAILED");
  return { user: existing, created: false, admin };
}

function userSnapshot(user: {
  displayName: string;
  active: boolean;
  version: number;
  roles: readonly { role: RoleCode }[];
  locations: readonly { location: { code: string } }[];
}) {
  return {
    displayName: user.displayName,
    active: user.active,
    version: user.version,
    roles: user.roles.map(({ role }) => role).sort(),
    locations: user.locations.map(({ location }) => location.code).sort(),
  };
}

export async function getUserManagementPageData() {
  const { account: actor } = await requirePermission("admin.manage");
  const [users, locations] = await Promise.all([
    prisma.user.findMany({ orderBy: [{ active: "desc" }, { displayName: "asc" }], include: userInclude }),
    prisma.operationalLocation.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true },
    }),
  ]);

  return {
    actorId: actor.id,
    invitationsConfigured: isSupabaseAdminConfigured() && getApplicationUrl() !== null,
    locations,
    roles: [...roleCodes],
    users: users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      active: user.active,
      version: user.version,
      roles: user.roles.map(({ role }) => role),
      locations: user.locations.map(({ location }) => location.code),
      updatedAt: user.updatedAt.toISOString(),
    })),
  };
}

export async function getManagedUserEditData(userId: string) {
  const { account: actor } = await requirePermission("admin.manage");
  const [user, locations] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, include: userInclude }),
    prisma.operationalLocation.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true },
    }),
  ]);
  if (!user) return null;

  return {
    actorId: actor.id,
    actorRoles: actor.roles.map(({ role }) => role),
    roles: [...roleCodes],
    locations,
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      active: user.active,
      version: user.version,
      roles: user.roles.map(({ role }) => role),
      locationIds: user.locations.map(({ locationId }) => locationId),
    },
  };
}

export async function getUserAdministrationAudit() {
  await requirePermission("admin.manage");
  const events = await prisma.auditEvent.findMany({
    where: { action: { startsWith: "USER_" } },
    orderBy: { occurredAt: "desc" },
    take: 100,
    include: { actor: { select: { displayName: true, email: true } } },
  });

  return events.map((event) => ({
    id: event.id,
    action: event.action,
    entityId: event.entityId,
    actor: event.actor?.displayName ?? "System",
    actorEmail: event.actor?.email ?? null,
    reason: event.reason,
    occurredAt: event.occurredAt.toISOString(),
  }));
}

export async function inviteManagedUser(rawInput: InviteManagedUserInput) {
  const { account: actor } = await requirePermission("admin.manage");
  const email = rawInput.email.trim().toLowerCase();
  const displayName = rawInput.displayName.trim();
  const access = normalizeAccess(rawInput.roles, rawInput.locationIds);
  const draftFailure = validateUserAccessDraft({ active: true, ...access });
  if (draftFailure) fail(draftFailure);

  const locations = await loadActiveLocations(access.locationIds);
  const compatibilityFailure = validateRoleLocationCompatibility(access.roles, locations);
  if (compatibilityFailure) fail(compatibilityFailure);

  const otherActiveOwnerCount = await prisma.user.count({
    where: { active: true, roles: { some: { role: "OWNER" } }, locations: { some: { location: { active: true } } } },
  });
  const safetyFailure = validateAdministrativeSafety({
    actorUserId: actor.id,
    actorRoles: actor.roles.map(({ role }) => role),
    targetUserId: "new-user",
    targetCurrentlyOwner: false,
    nextAccess: { active: true, ...access },
    otherActiveOwnerCount,
  });
  if (safetyFailure) fail(safetyFailure);

  const existingManagedUser = await prisma.user.findFirst({
    where: { OR: [{ email: { equals: email, mode: "insensitive" } }] },
    select: { id: true },
  });
  if (existingManagedUser) fail("USER_ALREADY_MANAGED");

  const invitation = await ensureInvitedAuthUser({ ...rawInput, email, displayName, ...access });
  const existingSubject = await prisma.user.findUnique({ where: { subject: invitation.user.id }, select: { id: true } });
  if (existingSubject) {
    if (invitation.created) await invitation.admin.auth.admin.deleteUser(invitation.user.id).catch(() => undefined);
    fail("USER_ALREADY_MANAGED");
  }

  try {
    const user = await prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          subject: invitation.user.id,
          email,
          displayName,
          active: true,
          roles: { create: access.roles.map((role) => ({ role })) },
          locations: { create: access.locationIds.map((locationId) => ({ locationId })) },
        },
      });
      const after = {
        displayName,
        active: true,
        version: created.version,
        roles: [...access.roles].sort(),
        locations: locations.map(({ code }) => code),
      };
      await transaction.auditEvent.create({
        data: {
          actorId: actor.id,
          action: invitation.created ? "USER_INVITED" : "USER_PROVISIONED",
          entityType: "User",
          entityId: created.id,
          locationCode: null,
          correlationId: rawInput.correlationId,
          reason: invitation.created ? "Administrator invitation" : "Existing Supabase identity provisioned",
          after,
        },
      });
      await transaction.outboxMessage.create({
        data: {
          topic: "identity.user.provisioned",
          aggregateType: "User",
          aggregateId: created.id,
          payload: { userId: created.id, subject: created.subject, roles: after.roles, locations: after.locations },
        },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { userId: user.id, invitationSent: invitation.created };
  } catch (error) {
    if (invitation.created) {
      await invitation.admin.auth.admin.deleteUser(invitation.user.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function updateManagedUser(rawInput: UpdateManagedUserInput) {
  const { account: actor } = await requirePermission("admin.manage");
  const access = normalizeAccess(rawInput.roles, rawInput.locationIds);
  const draftFailure = validateUserAccessDraft({ active: rawInput.active, ...access });
  if (draftFailure) fail(draftFailure);

  const locations = await loadActiveLocations(access.locationIds);
  const compatibilityFailure = validateRoleLocationCompatibility(access.roles, locations);
  if (compatibilityFailure) fail(compatibilityFailure);

  try {
    return await prisma.$transaction(async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: rawInput.userId }, include: userInclude });
      if (!target) fail("USER_NOT_FOUND");
      const otherActiveOwnerCount = await transaction.user.count({
        where: {
          id: { not: target.id },
          active: true,
          roles: { some: { role: "OWNER" } },
          locations: { some: { location: { active: true } } },
        },
      });
      const safetyFailure = validateAdministrativeSafety({
        actorUserId: actor.id,
        actorRoles: actor.roles.map(({ role }) => role),
        targetUserId: target.id,
        targetCurrentlyOwner: target.active && target.roles.some(({ role }) => role === "OWNER"),
        nextAccess: { active: rawInput.active, ...access },
        otherActiveOwnerCount,
      });
      if (safetyFailure) fail(safetyFailure);

      const before = userSnapshot(target);
      const after = {
        displayName: rawInput.displayName.trim(),
        active: rawInput.active,
        version: rawInput.expectedVersion + 1,
        roles: [...access.roles].sort(),
        locations: locations.map(({ code }) => code),
      };
      const updated = await transaction.user.updateMany({
        where: { id: target.id, version: rawInput.expectedVersion },
        data: { displayName: after.displayName, active: after.active, version: { increment: 1 } },
      });
      if (updated.count !== 1) fail("VERSION_CONFLICT");

      await transaction.userRole.deleteMany({ where: { userId: target.id } });
      await transaction.userRole.createMany({ data: access.roles.map((role) => ({ userId: target.id, role })) });
      await transaction.userLocationGrant.deleteMany({ where: { userId: target.id } });
      await transaction.userLocationGrant.createMany({
        data: access.locationIds.map((locationId) => ({ userId: target.id, locationId })),
      });
      await transaction.auditEvent.create({
        data: {
          actorId: actor.id,
          action: target.active === after.active ? "USER_ACCESS_UPDATED" : after.active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
          entityType: "User",
          entityId: target.id,
          locationCode: null,
          correlationId: rawInput.correlationId,
          reason: rawInput.reason.trim(),
          before,
          after,
        },
      });
      await transaction.outboxMessage.create({
        data: {
          topic: "identity.user.access-updated",
          aggregateType: "User",
          aggregateId: target.id,
          payload: { userId: target.id, active: after.active, version: after.version, roles: after.roles, locations: after.locations },
        },
      });
      return { userId: target.id, version: after.version };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") fail("VERSION_CONFLICT");
    throw error;
  }
}
