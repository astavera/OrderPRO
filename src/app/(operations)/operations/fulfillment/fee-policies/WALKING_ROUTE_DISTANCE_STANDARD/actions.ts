"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  publishWalkingFeePolicy,
  type PublishWalkingFeePolicyError,
} from "@/application/fulfillment/publish-walking-fee-policy";
import { WALKING_FEE_POLICY_PUBLISH_CONFIRMATION } from "@/application/fulfillment/walking-fee-policy-publication-policy";

const inputSchema = z.object({
  commandId: z.string().uuid(),
  versionId: z.string().uuid(),
  expectedRevision: z.coerce.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
  confirmation: z.literal(WALKING_FEE_POLICY_PUBLISH_CONFIRMATION),
});

export type PublishWalkingFeePolicyActionState = {
  commandId?: string;
  success?: string;
  error?: string;
  code?: PublishWalkingFeePolicyError | "INVALID_INPUT";
};

const errorMessages: Record<PublishWalkingFeePolicyError, string> = {
  INVALID_APPROVAL: "Provide an audit reason and type the exact publication confirmation.",
  FEATURE_DISABLED: "The publication feature gate is disabled for this environment.",
  POLICY_VERSION_NOT_FOUND: "The selected policy version no longer exists.",
  VERSION_CONFLICT: "This version changed in another session. Reload before publishing.",
  VERSION_IMMUTABLE: "This historical version is immutable and cannot be published in place.",
  ALREADY_PUBLISHED: "This version is already published and cannot be published again.",
  LOCATION_FORBIDDEN: "You need active access to every store affected by this policy.",
  INVALID_LOCATION_POLICY: "The linked store policies are incomplete or contain forbidden legacy pricing.",
  INVALID_POLICY_DEFINITION: "The policy no longer matches the approved walking-distance calibration.",
  IDEMPOTENCY_CONFLICT: "This command ID was already used for a different approval.",
  COMMAND_IN_PROGRESS: "The same approval is already being processed. Retry shortly.",
};

export async function publishWalkingFeePolicyAction(
  previousState: PublishWalkingFeePolicyActionState,
  formData: FormData,
): Promise<PublishWalkingFeePolicyActionState> {
  const commandId = String(formData.get("commandId") ?? previousState.commandId ?? "");
  const parsed = inputSchema.safeParse({
    commandId,
    versionId: formData.get("versionId"),
    expectedRevision: formData.get("expectedRevision"),
    reason: formData.get("reason"),
    confirmation: formData.get("confirmation"),
  });
  if (!parsed.success) {
    return {
      commandId,
      code: "INVALID_INPUT",
      error: "Review the reason and type the exact confirmation phrase before publishing.",
    };
  }

  try {
    const result = await publishWalkingFeePolicy({
      ...parsed.data,
      correlationId: randomUUID(),
    });
    revalidatePath("/operations/fulfillment");
    revalidatePath(
      "/operations/fulfillment/fee-policies/WALKING_ROUTE_DISTANCE_STANDARD",
    );
    return {
      commandId: randomUUID(),
      success: `STAGING publication ${result.publicationNumber} approved. Digest ${result.digest}.`,
    };
  } catch (error) {
    const code = error instanceof Error ? (error.message as PublishWalkingFeePolicyError) : undefined;
    if (code && code in errorMessages) {
      return { commandId, code, error: errorMessages[code] };
    }
    return {
      commandId,
      error: "The policy could not be published. Retry with the same command ID.",
    };
  }
}
