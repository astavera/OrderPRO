import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("authenticated STAGING approval boundary", () => {
  it("derives the actor on the server and exposes no actor field in the form", () => {
    const action = read(
      "src/app/(operations)/operations/admin/m2m/actions.ts",
    );
    const form = read(
      "src/app/(operations)/operations/admin/m2m/approval-form.tsx",
    );
    const service = read(
      "src/application/m2m/staging-authorization-approval.ts",
    );

    expect(action).not.toMatch(/formData\.get\(["']actor/i);
    expect(form).not.toMatch(/name=["']actor/i);
    expect(form).not.toContain("crypto.randomUUID");
    expect(service).toContain("getCurrentPrincipal()");
    expect(service).toContain('requirePermission("m2m.approve")');
    expect(service).toContain('role === "OWNER"');
  });

  it("uses the audited RPC and never activates or updates authorization rows", () => {
    const service = read(
      "src/application/m2m/staging-authorization-approval.ts",
    );

    expect(service).toContain("record_staging_machine_authorization_approval(");
    expect(service).toContain('"APPROVED_PENDING_ACTIVATION"');
    expect(service).toContain("activationBlockersAreIntact");
    expect(service).toContain("approvalGuardsAreIntact");
    expect(service).toContain("has_function_privilege");
    expect(service).toContain("procedure_row.prosecdef");
    expect(service).toContain("table_row.relrowsecurity");
    expect(service).toContain("aclexplode");
    expect(service).toContain("untrustedExecuteRevoked");
    expect(service).toContain("untrustedTableAccessRevoked");
    expect(service).not.toMatch(/machineClient\.(update|upsert|create)/);
    expect(service).not.toMatch(/machineCredential\.(update|upsert|create)/);
    expect(service).not.toMatch(/machineClientGrant\.(update|upsert|create)/);
    expect(service).not.toMatch(/featureFlag\.(update|upsert|create)/);
  });

  it("revalidates evidence, provenance and pending state before replaying a command", () => {
    const service = read(
      "src/application/m2m/staging-authorization-approval.ts",
    );

    expect(service).toContain("approval.certificationEvidenceDigestSha256");
    expect(service).toContain("approval.approvalSourceCommitSha");
    expect(service).toContain("approval.approvalSourceTreeSha");
    expect(service).toContain("evidence.grantVersions");
    expect(service).toContain("isExactPendingApprovalSnapshot({");
    expect(service).toContain('fail("IDEMPOTENCY_CONFLICT")');
    expect(service).toContain("findExactReplayApproval({");
    expect(service).toContain(
      "exactGrantVersions(approval.grantVersions, evidence.grantVersions)",
    );
  });

  it("keeps external Client IDs and raw certification JSON out of the page DTO", () => {
    const page = read("src/app/(operations)/operations/admin/m2m/page.tsx");
    const service = read(
      "src/application/m2m/staging-authorization-approval.ts",
    );

    expect(page).not.toContain("externalClientId");
    expect(page).not.toContain("certification.before");
    expect(page).not.toContain("certification.after");
    expect(service).toContain("safeCertificationSummary");
  });
});
