"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { updateWalkingZoneDraft, type UpdateWalkingZoneDraftError } from "@/application/fulfillment/update-walking-zone-draft";

const weekdays = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

const nullableNumber = z.preprocess(
  (value) => value === null || value === undefined || String(value).trim() === "" ? null : Number(value),
  z.number().nonnegative().nullable(),
);

const inputSchema = z.object({
  commandId: z.string().uuid(),
  versionId: z.string().uuid(),
  zoneId: z.string().uuid(),
  expectedRevision: z.coerce.number().int().positive(),
  name: z.string().trim().min(2).max(120),
  postalCodes: z.string().max(200),
  priority: z.preprocess(
    (value) => value === null || value === undefined || String(value).trim() === "" ? null : Number(value),
    z.number().int().nullable(),
  ),
  assignmentStrategy: z.enum(["FIXED", "NEAREST_WALKING_ROUTE"]),
  candidateLocationIds: z.array(z.string().uuid()).min(1),
  geometryText: z.string().max(700_000),
  activeDays: z.array(z.enum(weekdays)),
  maxDistanceMiles: nullableNumber,
  maxRouteMinutes: nullableNumber.refine((value) => value === null || Number.isInteger(value)),
  minimumOrderCents: nullableNumber.refine((value) => value === null || Number.isInteger(value)),
});

export type WalkingZoneDraftActionState = {
  commandId?: string;
  revision?: number;
  success?: string;
  error?: string;
  code?: UpdateWalkingZoneDraftError | "INVALID_INPUT" | "INVALID_GEOMETRY_JSON";
};

const errorMessages: Record<UpdateWalkingZoneDraftError, string> = {
  FEATURE_DISABLED: "Walking-zone draft administration is locked.",
  DRAFT_NOT_FOUND: "The selected walking-zone draft no longer exists.",
  DRAFT_IMMUTABLE: "Published or archived versions cannot be edited.",
  VERSION_CONFLICT: "This draft changed in another session. Reload before saving again.",
  LOCATION_FORBIDDEN: "You are not authorized for every affected store.",
  INVALID_CANDIDATE_LOCATION: "One or more candidate stores are unavailable.",
  INVALID_DRAFT: "The draft contains an invalid field or geometry.",
  IDEMPOTENCY_CONFLICT: "This command ID was already used for different content.",
  COMMAND_IN_PROGRESS: "The same save is already being processed. Retry shortly.",
};

export async function updateWalkingZoneDraftAction(
  previousState: WalkingZoneDraftActionState,
  formData: FormData,
): Promise<WalkingZoneDraftActionState> {
  const commandId = String(formData.get("commandId") ?? previousState.commandId ?? "");
  const parsed = inputSchema.safeParse({
    commandId,
    versionId: formData.get("versionId"),
    zoneId: formData.get("zoneId"),
    expectedRevision: formData.get("expectedRevision"),
    name: formData.get("name"),
    postalCodes: formData.get("postalCodes"),
    priority: formData.get("priority"),
    assignmentStrategy: formData.get("assignmentStrategy"),
    candidateLocationIds: formData.getAll("candidateLocationIds"),
    geometryText: formData.get("geometryText") ?? "",
    activeDays: formData.getAll("activeDays"),
    maxDistanceMiles: formData.get("maxDistanceMiles"),
    maxRouteMinutes: formData.get("maxRouteMinutes"),
    minimumOrderCents: formData.get("minimumOrderCents"),
  });
  if (!parsed.success) {
    return { commandId, revision: previousState.revision, code: "INVALID_INPUT", error: "Review the required fields, stores and numeric limits." };
  }

  let geometry: unknown | null = null;
  const geometryText = parsed.data.geometryText.trim();
  if (geometryText) {
    try {
      geometry = JSON.parse(geometryText) as unknown;
    } catch {
      return { commandId, revision: previousState.revision, code: "INVALID_GEOMETRY_JSON", error: "GeoJSON must be valid JSON." };
    }
  }

  try {
    const result = await updateWalkingZoneDraft({
      commandId: parsed.data.commandId,
      versionId: parsed.data.versionId,
      expectedRevision: parsed.data.expectedRevision,
      name: parsed.data.name,
      postalCodes: parsed.data.postalCodes.split(",").map((code) => code.trim()).filter(Boolean),
      priority: parsed.data.priority,
      assignmentStrategy: parsed.data.assignmentStrategy,
      candidateLocationIds: parsed.data.candidateLocationIds,
      geometry,
      activeDays: parsed.data.activeDays,
      maxDistanceMiles: parsed.data.maxDistanceMiles,
      maxRouteMinutes: parsed.data.maxRouteMinutes,
      minimumOrderCents: parsed.data.minimumOrderCents,
      correlationId: randomUUID(),
    });
    revalidatePath("/operations/fulfillment");
    revalidatePath(`/operations/fulfillment/walking-zones/${parsed.data.zoneId}`);
    return {
      commandId: randomUUID(),
      revision: result.revision,
      success: `Draft saved at revision ${result.revision}. Publication remains locked.`,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message as UpdateWalkingZoneDraftError : undefined;
    if (code && code in errorMessages) return { commandId, revision: previousState.revision, code, error: errorMessages[code] };
    return { commandId, revision: previousState.revision, error: "The draft could not be saved. Retry with the same command ID." };
  }
}
