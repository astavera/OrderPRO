import { describe, expect, it } from "vitest";
import {
  STAGING_M2M_APPROVAL_CONFIRMATION,
  activationBlockersAreIntact,
  approvalGuardsAreIntact,
  getStagingApprovalEnvironmentReadiness,
  isSafeStagingApprovalReason,
  type ActivationBlockerRow,
  type StagingApprovalEnvironment,
} from "./staging-authorization-approval-policy";

function validEnvironment(
  overrides: StagingApprovalEnvironment = {},
): StagingApprovalEnvironment {
  return {
    NODE_ENV: "production",
    ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
    ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED: "true",
    ORDERPRO_M2M_AUTH_MODE: "DISABLED",
    ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "false",
    ORDERPRO_M2M_ISSUER: "https://orderpro-staging.us.auth0.com/",
    ORDERPRO_M2M_AUDIENCE:
      "https://api.orderpro.internal/local-delivery/staging",
    ORDERPRO_M2M_JWKS_URI:
      "https://orderpro-staging.us.auth0.com/.well-known/jwks.json",
    ORDERPRO_M2M_ALLOWED_ALGORITHM: "RS256",
    ORDERPRO_RELEASE_COMMIT_SHA: "a".repeat(40),
    ORDERPRO_RELEASE_TREE_SHA: "b".repeat(40),
    ORDERPRO_RELEASE_M2M_CERTIFIED_COMMIT_SHA: "d".repeat(40),
    ORDERPRO_RELEASE_M2M_CERTIFIED_TREE_SHA: "e".repeat(40),
    ORDERPRO_RELEASE_M2M_CERTIFICATION_ANCESTOR_CONFIRMED: "true",
    ORDERPRO_RELEASE_M2M_VERIFIER_DIGEST_SHA256: "c".repeat(64),
    ...overrides,
  };
}

function blockers(): ActivationBlockerRow[] {
  return [
    ["machine_client_no_activation", "MachineClient"],
    ["machine_credential_no_activation", "MachineCredential"],
    ["machine_grant_no_activation", "MachineClientGrant"],
  ].map(([triggerName, tableName]) => ({
    triggerName,
    tableName,
    schemaName: "public",
    enabledMode: "O",
    functionName: "reject_machine_authorization_activation",
    triggerType: 23,
  }));
}

function approvalGuards(): ActivationBlockerRow[] {
  return [
    [
      "machine_authorization_approval_no_update",
      "reject_machine_authorization_approval_mutation",
      19,
    ],
    [
      "machine_authorization_approval_no_delete",
      "reject_machine_authorization_approval_mutation",
      11,
    ],
    [
      "machine_authorization_approval_validate_insert",
      "validate_machine_authorization_approval_insert",
      7,
    ],
  ].map(([triggerName, functionName, triggerType]) => ({
    triggerName: String(triggerName),
    tableName: "MachineAuthorizationApproval",
    schemaName: "public",
    enabledMode: "O",
    functionName: String(functionName),
    triggerType: Number(triggerType),
  }));
}

describe("STAGING M2M approval policy", () => {
  it("accepts only an explicitly enabled, closed STAGING release", () => {
    const result = getStagingApprovalEnvironmentReadiness(validEnvironment());

    expect(result.blockers).toEqual([]);
    expect(result.attestation).toEqual({
      issuer: "https://orderpro-staging.us.auth0.com/",
      audience: "https://api.orderpro.internal/local-delivery/staging",
      sourceCommitSha: "a".repeat(40),
      sourceTreeSha: "b".repeat(40),
      certifiedCommitSha: "d".repeat(40),
      certifiedTreeSha: "e".repeat(40),
      verifierDigestSha256: "c".repeat(64),
    });
  });

  it("fails closed when the UI gate is omitted", () => {
    const result = getStagingApprovalEnvironmentReadiness(
      validEnvironment({ ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED: undefined }),
    );

    expect(result.attestation).toBeNull();
    expect(result.blockers).toContain("UI_GATE_DISABLED");
  });

  it("rejects an active runtime and any inherited Auth0 secret", () => {
    const result = getStagingApprovalEnvironmentReadiness(
      validEnvironment({
        ORDERPRO_M2M_AUTH_MODE: "AUTH0",
        ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "true",
        AUTH0_M2M_CLIENT_SECRET: "must-never-enter-the-approval-process",
      }),
    );

    expect(result.attestation).toBeNull();
    expect(result.blockers).toEqual(
      expect.arrayContaining(["RUNTIME_NOT_CLOSED", "FORBIDDEN_SECRET_PRESENT"]),
    );
  });

  it("requires a canonical Auth0 issuer, audience, JWKS and RS256", () => {
    const result = getStagingApprovalEnvironmentReadiness(
      validEnvironment({
        ORDERPRO_M2M_JWKS_URI: "https://attacker.example/.well-known/jwks.json",
      }),
    );

    expect(result.blockers).toContain("M2M_CONFIGURATION_INVALID");
  });

  it("requires CI to bind the certified commit to the release ancestry", () => {
    const result = getStagingApprovalEnvironmentReadiness(
      validEnvironment({
        ORDERPRO_RELEASE_M2M_CERTIFICATION_ANCESTOR_CONFIRMED: "false",
      }),
    );

    expect(result.attestation).toBeNull();
    expect(result.blockers).toContain("RELEASE_PROVENANCE_MISSING");
  });

  it("accepts an operational reason and rejects token-like evidence", () => {
    expect(
      isSafeStagingApprovalReason(
        "Owner reviewed the certified storefront STAGING snapshot.",
      ),
    ).toBe(true);
    expect(isSafeStagingApprovalReason("Bearer abc.def.ghi")).toBe(false);
    expect(isSafeStagingApprovalReason("client_secret = do-not-store-this")).toBe(
      false,
    );
    expect(isSafeStagingApprovalReason("too short")).toBe(false);
    expect(STAGING_M2M_APPROVAL_CONFIRMATION).toContain("WITHOUT ACTIVATION");
  });

  it("recognizes only the three exact enabled no-activation triggers", () => {
    expect(activationBlockersAreIntact(blockers())).toBe(true);
    expect(
      activationBlockersAreIntact(
        blockers().map((row, index) =>
          index === 1 ? { ...row, enabledMode: "D" } : row,
        ),
      ),
    ).toBe(false);
    expect(activationBlockersAreIntact(blockers().slice(0, 2))).toBe(false);
  });

  it("recognizes the exact append-only and insert-validation approval guards", () => {
    expect(approvalGuardsAreIntact(approvalGuards())).toBe(true);
    expect(
      approvalGuardsAreIntact(
        approvalGuards().map((row, index) =>
          index === 2 ? { ...row, functionName: "unsafe_insert" } : row,
        ),
      ),
    ).toBe(false);
  });
});
