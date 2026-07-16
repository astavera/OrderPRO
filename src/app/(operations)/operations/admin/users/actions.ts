"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { roleCodes } from "@/application/auth/permissions";
import {
  inviteManagedUser,
  updateManagedUser,
  type UserManagementErrorCode,
} from "@/application/admin/user-management";

export type UserManagementState = { success?: string; error?: string; code?: UserManagementErrorCode | "INVALID_INPUT" };

const accessSchema = z.object({
  roles: z.array(z.enum(roleCodes)).min(1),
  locationIds: z.array(z.string().uuid()).min(1),
});

const inviteSchema = accessSchema.extend({
  displayName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
});

const updateSchema = accessSchema.extend({
  userId: z.string().uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  displayName: z.string().trim().min(2).max(100),
  active: z.enum(["true", "false"]).transform((value) => value === "true"),
  reason: z.string().trim().min(3).max(500),
});

const messages: Record<UserManagementErrorCode, string> = {
  ADMIN_AUTH_NOT_CONFIGURED: "User invitations require the server-only Supabase secret key.",
  APPLICATION_URL_NOT_CONFIGURED: "The OrderPRO application URL is not configured.",
  AUTH_INVITE_FAILED: "Supabase could not create or locate that identity. Try again.",
  INVALID_LOCATION: "One or more selected locations are unavailable.",
  USER_ALREADY_MANAGED: "That user already has an OrderPRO account.",
  USER_NOT_FOUND: "The selected user no longer exists.",
  VERSION_CONFLICT: "This user changed in another session. Reload before saving again.",
  ROLE_REQUIRED: "Select at least one role.",
  LOCATION_REQUIRED: "Select at least one active location.",
  SELF_LOCKOUT: "You cannot remove your own administrative access.",
  LAST_OWNER_REQUIRED: "At least one active Owner must remain.",
  OWNER_MANAGEMENT_FORBIDDEN: "Only an Owner can grant or modify Owner access.",
  ROLE_LOCATION_MISMATCH: "The selected store or warehouse role is incompatible with one of the locations.",
};

function actionFailure(error: unknown): UserManagementState {
  const code = error instanceof Error ? error.message as UserManagementErrorCode : undefined;
  if (code && code in messages) return { code, error: messages[code] };
  return { error: "The user access change could not be completed. Try again." };
}

export async function inviteUserAction(_state: UserManagementState, formData: FormData): Promise<UserManagementState> {
  const input = inviteSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    roles: formData.getAll("roles"),
    locationIds: formData.getAll("locationIds"),
  });
  if (!input.success) return { code: "INVALID_INPUT", error: "Enter a valid name, email, role and location." };

  try {
    const result = await inviteManagedUser({ ...input.data, correlationId: randomUUID() });
    revalidatePath("/operations/admin/users");
    return {
      success: result.invitationSent
        ? `Invitation sent to ${input.data.email}.`
        : `Existing Supabase identity ${input.data.email} was granted access.`,
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function updateUserAccessAction(_state: UserManagementState, formData: FormData): Promise<UserManagementState> {
  const input = updateSchema.safeParse({
    userId: formData.get("userId"),
    expectedVersion: formData.get("expectedVersion"),
    displayName: formData.get("displayName"),
    active: formData.get("active"),
    reason: formData.get("reason"),
    roles: formData.getAll("roles"),
    locationIds: formData.getAll("locationIds"),
  });
  if (!input.success) return { code: "INVALID_INPUT", error: "Complete every required access field and provide a reason." };

  try {
    await updateManagedUser({ ...input.data, correlationId: randomUUID() });
    revalidatePath("/operations/admin/users");
    revalidatePath(`/operations/admin/users/${input.data.userId}`);
    revalidatePath("/operations/admin/audit");
    return { success: "User access updated." };
  } catch (error) {
    return actionFailure(error);
  }
}
