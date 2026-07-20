"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  approveStagingMachineAuthorization,
  stagingAuthorizationApprovalErrorCode,
  type StagingAuthorizationApprovalError,
} from "@/application/m2m/staging-authorization-approval";
import { STAGING_M2M_APPROVAL_CONFIRMATION } from "@/application/m2m/staging-authorization-approval-policy";
import {
  activateStagingMachineAuthorization,
  stagingAuthorizationActivationErrorCode,
  type StagingAuthorizationActivationError,
} from "@/application/m2m/staging-authorization-activation";
import { STAGING_M2M_ACTIVATION_CONFIRMATION } from "@/application/m2m/staging-authorization-activation-policy";

const inputSchema = z.object({
  commandId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
  confirmation: z.literal(STAGING_M2M_APPROVAL_CONFIRMATION),
  expectedCertificationAuditEventId: z.string().uuid(),
  expectedEvidenceDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type StagingM2mApprovalActionState = {
  commandId?: string;
  success?: string;
  error?: string;
  code?: StagingAuthorizationApprovalError | "INVALID_INPUT";
};

const errorMessages: Record<StagingAuthorizationApprovalError, string> = {
  AUTHENTICATION_REQUIRED: "Your authenticated OrderPRO session is no longer active.",
  OWNER_REQUIRED: "Only an active Owner can record this approval.",
  INVALID_APPROVAL_INPUT:
    "Review the reason and type the exact no-activation confirmation.",
  APPROVAL_ENVIRONMENT_NOT_READY:
    "STAGING is still fail-closed. Review the deployment and runtime blockers shown on this page.",
  APPROVAL_MIGRATION_NOT_READY:
    "The audited database approval boundary is not ready.",
  CERTIFICATION_STALE:
    "The certification changed after this page loaded. Reload and review the current evidence.",
  PENDING_APPROVAL_NOT_READY:
    "The certified client snapshot no longer matches the exact pending state.",
  ALREADY_APPROVED:
    "An approval has already been recorded. The page has been refreshed.",
  IDEMPOTENCY_CONFLICT:
    "This submission ID was already used for different approval data. Reload before retrying.",
  APPROVAL_WRITE_FAILED:
    "The approval was not recorded. All changes were rolled back; reload before retrying.",
};

export async function approveStagingM2mAction(
  previousState: StagingM2mApprovalActionState,
  formData: FormData,
): Promise<StagingM2mApprovalActionState> {
  const commandId = String(
    formData.get("commandId") ?? previousState.commandId ?? "",
  );
  const parsed = inputSchema.safeParse({
    commandId,
    reason: formData.get("reason"),
    confirmation: formData.get("confirmation"),
    expectedCertificationAuditEventId: formData.get(
      "expectedCertificationAuditEventId",
    ),
    expectedEvidenceDigestSha256: formData.get(
      "expectedEvidenceDigestSha256",
    ),
  });
  if (!parsed.success) {
    return {
      commandId,
      code: "INVALID_INPUT",
      error:
        "Provide a 10–500 character reason and type the exact confirmation phrase.",
    };
  }

  try {
    const result = await approveStagingMachineAuthorization(parsed.data);
    revalidatePath("/operations/admin/m2m");
    return {
      commandId: randomUUID(),
      success: result.replayed
        ? "The existing audited approval was recovered. M2M remains pending and disabled."
        : "Approval recorded as APPROVED_PENDING_ACTIVATION. M2M remains pending and disabled.",
    };
  } catch (error) {
    const code = stagingAuthorizationApprovalErrorCode(error);
    if (code) {
      if (code === "ALREADY_APPROVED") {
        revalidatePath("/operations/admin/m2m");
      }
      return { commandId, code, error: errorMessages[code] };
    }
    return {
      commandId,
      error: "The approval could not be recorded. No activation was performed.",
    };
  }
}

const activationInputSchema = z.object({
  commandId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
  confirmation: z.literal(STAGING_M2M_ACTIVATION_CONFIRMATION),
  expectedApprovalId: z.string().uuid(),
  expectedApprovalDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type StagingM2mActivationActionState = {
  commandId?: string;
  success?: string;
  error?: string;
  code?: StagingAuthorizationActivationError | "INVALID_INPUT";
};

const activationErrorMessages: Record<
  StagingAuthorizationActivationError,
  string
> = {
  AUTHENTICATION_REQUIRED:
    "Your authenticated OrderPRO session is no longer active.",
  OWNER_REQUIRED: "Only an active Owner can activate STAGING machine access.",
  INVALID_ACTIVATION_INPUT:
    "Review the reason and type the exact M2M-only activation confirmation.",
  ACTIVATION_ENVIRONMENT_NOT_READY:
    "The separate STAGING activation window is not ready. Review the gates on this page.",
  ACTIVATION_MIGRATION_NOT_READY:
    "The audited database activation boundary is not ready.",
  APPROVAL_STALE:
    "The immutable approval changed or no longer matches this page. Reload before retrying.",
  PENDING_ACTIVATION_NOT_READY:
    "The approved client, credential or grant snapshot is no longer eligible for activation.",
  ALREADY_ACTIVATED:
    "This STAGING machine authorization has already been activated.",
  IDEMPOTENCY_CONFLICT:
    "This submission ID was already used for different activation data. Reload before retrying.",
  ACTIVATION_WRITE_FAILED:
    "Activation was rolled back. No partial client, credential or grant state was retained.",
};

export async function activateStagingM2mAction(
  previousState: StagingM2mActivationActionState,
  formData: FormData,
): Promise<StagingM2mActivationActionState> {
  const commandId = String(
    formData.get("commandId") ?? previousState.commandId ?? "",
  );
  const parsed = activationInputSchema.safeParse({
    commandId,
    reason: formData.get("reason"),
    confirmation: formData.get("confirmation"),
    expectedApprovalId: formData.get("expectedApprovalId"),
    expectedApprovalDigestSha256: formData.get(
      "expectedApprovalDigestSha256",
    ),
  });
  if (!parsed.success) {
    return {
      commandId,
      code: "INVALID_INPUT",
      error:
        "Provide a 10-500 character reason and type the exact activation phrase.",
    };
  }

  try {
    const result = await activateStagingMachineAuthorization(parsed.data);
    revalidatePath("/operations/admin/m2m");
    return {
      commandId: randomUUID(),
      success: result.replayed
        ? "The existing audited activation was recovered."
        : "Registry activation completed. Auth0 runtime verification and Local Delivery remain separate and closed.",
    };
  } catch (error) {
    const code = stagingAuthorizationActivationErrorCode(error);
    if (code) {
      if (code === "ALREADY_ACTIVATED") {
        revalidatePath("/operations/admin/m2m");
      }
      return { commandId, code, error: activationErrorMessages[code] };
    }
    return {
      commandId,
      error: "Activation failed closed. No partial authorization was retained.",
    };
  }
}
