import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("authenticated STAGING activation boundary", () => {
  it("derives the activating Owner from the authenticated server session", () => {
    const action = read("src/app/(operations)/operations/admin/m2m/actions.ts");
    const form = read(
      "src/app/(operations)/operations/admin/m2m/activation-form.tsx",
    );
    const service = read(
      "src/application/m2m/staging-authorization-activation.ts",
    );

    expect(action).not.toMatch(/formData\.get\(["']actor/i);
    expect(form).not.toMatch(/name=["']actor/i);
    expect(service).toContain("getCurrentPrincipal()");
    expect(service).toContain('requirePermission("m2m.activate")');
    expect(service).toContain('role === "OWNER"');
  });

  it("uses only the audited RPC for registry state transitions", () => {
    const service = read(
      "src/application/m2m/staging-authorization-activation.ts",
    );
    expect(service).toContain(
      "record_staging_machine_authorization_activation(",
    );
    expect(service).toContain("activationTransitionGuardsAreIntact");
    expect(service).toContain("activationRecordGuardsAreIntact");
    expect(service).toContain("has_function_privilege");
    expect(service).toContain("procedure_row.prosecdef");
    expect(service).toContain("table_row.relrowsecurity");
    expect(service).not.toMatch(/machineClient\.(update|upsert|create)/);
    expect(service).not.toMatch(/machineCredential\.(update|upsert|create)/);
    expect(service).not.toMatch(/machineClientGrant\.(update|upsert|create)/);
  });

  it("keeps Auth0 and Local Delivery runtime gates closed during activation", () => {
    const policy = read(
      "src/application/m2m/staging-authorization-activation-policy.ts",
    );
    expect(policy).toContain("ORDERPRO_M2M_AUTH_MODE");
    expect(policy).toContain('=== "DISABLED"');
    expect(policy).toContain("ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED");
    expect(policy).toContain("ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED");
    expect(policy).toContain("ORDERPRO_M2M_STAGING_ACTIVATION_UI_ENABLED");
  });
});
