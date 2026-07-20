import { describe, expect, it } from "vitest";
import {
  activationRecordGuardsAreIntact,
  activationTransitionGuardsAreIntact,
  getStagingActivationEnvironmentReadiness,
} from "./staging-authorization-activation-policy";

const validEnvironment = {
  NODE_ENV: "production",
  ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
  ORDERPRO_M2M_AUTH_MODE: "DISABLED",
  ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "false",
  ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED: "false",
  ORDERPRO_M2M_STAGING_ACTIVATION_UI_ENABLED: "true",
  ORDERPRO_M2M_ISSUER: "https://orderpro-test.us.auth0.com/",
  ORDERPRO_M2M_AUDIENCE:
    "https://api.orderpro.internal/local-delivery/staging",
  ORDERPRO_M2M_JWKS_URI:
    "https://orderpro-test.us.auth0.com/.well-known/jwks.json",
  ORDERPRO_M2M_ALLOWED_ALGORITHM: "RS256",
  ORDERPRO_RELEASE_COMMIT_SHA: "a".repeat(40),
  ORDERPRO_RELEASE_TREE_SHA: "b".repeat(40),
  ORDERPRO_RELEASE_M2M_CERTIFIED_COMMIT_SHA: "c".repeat(40),
  ORDERPRO_RELEASE_M2M_CERTIFIED_TREE_SHA: "d".repeat(40),
  ORDERPRO_RELEASE_M2M_CERTIFICATION_ANCESTOR_CONFIRMED: "true",
  ORDERPRO_RELEASE_M2M_VERIFIER_DIGEST_SHA256: "e".repeat(64),
};

describe("STAGING M2M activation policy", () => {
  it("opens only the separate, fail-closed activation window", () => {
    const readiness = getStagingActivationEnvironmentReadiness(validEnvironment);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.attestation).not.toBeNull();
  });

  it("requires approval UI closed and both runtime gates disabled", () => {
    const readiness = getStagingActivationEnvironmentReadiness({
      ...validEnvironment,
      ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED: "true",
      ORDERPRO_M2M_AUTH_MODE: "AUTH0",
      ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "true",
    });
    expect(readiness.blockers).toContain("APPROVAL_UI_STILL_ENABLED");
    expect(readiness.blockers).toContain("RUNTIME_NOT_CLOSED");
    expect(readiness.attestation).toBeNull();
  });

  it("rejects inherited credentials or tokens", () => {
    const readiness = getStagingActivationEnvironmentReadiness({
      ...validEnvironment,
      AUTH0_ACCESS_TOKEN: "must-not-enter-activation-process",
    });
    expect(readiness.blockers).toContain("FORBIDDEN_SECRET_PRESENT");
  });

  it("recognizes all three evolved transition guards", () => {
    const rows = [
      ["machine_client_no_activation", "MachineClient"],
      ["machine_credential_no_activation", "MachineCredential"],
      ["machine_grant_no_activation", "MachineClientGrant"],
    ].map(([triggerName, tableName]) => ({
      triggerName,
      tableName,
      schemaName: "public",
      enabledMode: "O",
      functionName: "guard_staging_machine_authorization_activation",
      triggerType: 23,
    }));
    expect(activationTransitionGuardsAreIntact(rows)).toBe(true);
  });

  it("requires append-only and canonical-insert activation guards", () => {
    const rows = [
      {
        triggerName: "machine_authorization_activation_no_update",
        tableName: "MachineAuthorizationActivation",
        schemaName: "public",
        enabledMode: "O",
        functionName: "reject_machine_authorization_activation_record_mutation",
        triggerType: 19,
      },
      {
        triggerName: "machine_authorization_activation_no_delete",
        tableName: "MachineAuthorizationActivation",
        schemaName: "public",
        enabledMode: "O",
        functionName: "reject_machine_authorization_activation_record_mutation",
        triggerType: 11,
      },
      {
        triggerName: "machine_authorization_activation_validate_insert",
        tableName: "MachineAuthorizationActivation",
        schemaName: "public",
        enabledMode: "O",
        functionName: "validate_machine_authorization_activation_insert",
        triggerType: 7,
      },
    ];
    expect(activationRecordGuardsAreIntact(rows)).toBe(true);
  });
});
