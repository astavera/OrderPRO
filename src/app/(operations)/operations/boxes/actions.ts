"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePrincipal } from "@/application/auth/current-principal";
import { createBox } from "@/application/boxes/create-box";

export type CreateBoxState = { success?: string; error?: string };
const schema = z.object({ commandId: z.string().uuid(), ownerLocationId: z.string().uuid(), currentLocationId: z.string().uuid() });

export async function createBoxAction(_state: CreateBoxState, formData: FormData): Promise<CreateBoxState> {
  const input = schema.safeParse({ commandId: formData.get("commandId"), ownerLocationId: formData.get("ownerLocationId"), currentLocationId: formData.get("currentLocationId") });
  if (!input.success) return { error: "Invalid box request." };
  const { account } = await requirePrincipal();
  try {
    const result = await createBox({ ...input.data, actorId: account.id, roles: account.roles.map(({ role }) => role), allowedLocationIds: account.locations.map(({ locationId }) => locationId), correlationId: randomUUID() });
    revalidatePath("/operations/boxes");
    return { success: `Box ${result.code} created.` };
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    if (code === "FEATURE_DISABLED") return { error: "Box creation is currently locked." };
    if (code === "FORBIDDEN" || code === "LOCATION_FORBIDDEN") return { error: "You are not authorized for this operation." };
    return { error: "The box could not be created. Retry with the same command." };
  }
}
