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
