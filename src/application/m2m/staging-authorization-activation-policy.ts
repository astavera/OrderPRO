import {
  STAGING_M2M_AUDIENCE,
  STAGING_M2M_CLIENT_KEY,
  STAGING_M2M_ENVIRONMENT,
  type ActivationBlockerRow,
} from "./staging-authorization-approval-policy";

export const STAGING_M2M_ACTIVATION_CONFIRMATION =
  "ACTIVATE STOREFRONT-STAGING M2M ONLY";
export const STAGING_M2M_ACTIVATION_PROCEDURE =
  "record_staging_machine_authorization_activation(text,uuid,text,uuid,text,text,text,uuid,uuid)";
export const STAGING_M2M_ACTIVATION_RESULT = "ACTIVATED";
export const STAGING_M2M_ACTIVE_STATUS = "ACTIVE";

const sha = /^[a-f0-9]{40,64}$/;
const sha256 = /^[a-f0-9]{64}$/;

const forbiddenSecretEnvironmentVariables = [
  "AUTH0_CLIENT_SECRET",
  "AUTH0_M2M_CLIENT_SECRET",
  "ORDERPRO_M2M_CLIENT_SECRET",
  "AUTH0_ACCESS_TOKEN",
  "ORDERPRO_M2M_ACCESS_TOKEN",
  "AUTH0_MANAGEMENT_API_TOKEN",
  "AUTH0_MGMT_API_TOKEN",
  "AUTHORIZATION",
] as const;

export type StagingActivationEnvironment = Record<string, string | undefined>;

export type StagingActivationReadinessCode =
  | "ACTIVATION_UI_GATE_DISABLED"
  | "APPROVAL_UI_STILL_ENABLED"
  | "NOT_STAGING_RELEASE"
  | "RUNTIME_NOT_CLOSED"
  | "M2M_CONFIGURATION_INVALID"
  | "RELEASE_PROVENANCE_MISSING"
  | "FORBIDDEN_SECRET_PRESENT";

export type StagingActivationDeploymentAttestation = {
  issuer: string;
  audience: typeof STAGING_M2M_AUDIENCE;
  sourceCommitSha: string;
  sourceTreeSha: string;
  certifiedCommitSha: string;
  certifiedTreeSha: string;
  verifierDigestSha256: string;
};

function canonicalAuth0Configuration(environment: StagingActivationEnvironment) {
  const issuer = environment.ORDERPRO_M2M_ISSUER?.trim() ?? "";
  const audience = environment.ORDERPRO_M2M_AUDIENCE?.trim() ?? "";
  const jwksUri = environment.ORDERPRO_M2M_JWKS_URI?.trim() ?? "";
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return null;
  }

  if (
    audience !== STAGING_M2M_AUDIENCE ||
    environment.ORDERPRO_M2M_ALLOWED_ALGORITHM?.trim() !== "RS256" ||
    issuerUrl.protocol !== "https:" ||
    issuerUrl.username !== "" ||
    issuerUrl.password !== "" ||
    issuerUrl.port !== "" ||
    issuerUrl.pathname !== "/" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    !issuerUrl.hostname.endsWith(".auth0.com") ||
    issuerUrl.href !== issuer ||
    jwksUri !== `${issuer}.well-known/jwks.json`
  ) {
    return null;
  }

  return { issuer, audience: STAGING_M2M_AUDIENCE } as const;
}

export function getStagingActivationEnvironmentReadiness(
  environment: StagingActivationEnvironment,
) {
  const activationUiEnabled =
    environment.ORDERPRO_M2M_STAGING_ACTIVATION_UI_ENABLED?.trim() === "true";
  const approvalUiDisabled =
    environment.ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED?.trim() === "false";
  const productionBuild = environment.NODE_ENV?.trim() === "production";
  const stagingRuntime =
    environment.ORDERPRO_RUNTIME_ENVIRONMENT?.trim() === STAGING_M2M_ENVIRONMENT;
  const m2mAuthDisabled =
    environment.ORDERPRO_M2M_AUTH_MODE?.trim() === "DISABLED";
  const localDeliveryApiDisabled =
    environment.ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED?.trim() === "false";
  const forbiddenSecretsAbsent = forbiddenSecretEnvironmentVariables.every(
    (name) => !environment[name]?.trim(),
  );
  const sourceCommitSha = environment.ORDERPRO_RELEASE_COMMIT_SHA?.trim() ?? "";
  const sourceTreeSha = environment.ORDERPRO_RELEASE_TREE_SHA?.trim() ?? "";
  const certifiedCommitSha =
    environment.ORDERPRO_RELEASE_M2M_CERTIFIED_COMMIT_SHA?.trim() ?? "";
  const certifiedTreeSha =
    environment.ORDERPRO_RELEASE_M2M_CERTIFIED_TREE_SHA?.trim() ?? "";
  const verifierDigestSha256 =
    environment.ORDERPRO_RELEASE_M2M_VERIFIER_DIGEST_SHA256?.trim() ?? "";
  const certificationAncestorConfirmed =
    environment.ORDERPRO_RELEASE_M2M_CERTIFICATION_ANCESTOR_CONFIRMED?.trim() ===
    "true";
  const releaseProvenancePresent =
    sha.test(sourceCommitSha) &&
    sha.test(sourceTreeSha) &&
    sha.test(certifiedCommitSha) &&
    sha.test(certifiedTreeSha) &&
    sha256.test(verifierDigestSha256) &&
    certificationAncestorConfirmed;
  const publicConfiguration = canonicalAuth0Configuration(environment);
  const blockers: StagingActivationReadinessCode[] = [];

  if (!activationUiEnabled) blockers.push("ACTIVATION_UI_GATE_DISABLED");
  if (!approvalUiDisabled) blockers.push("APPROVAL_UI_STILL_ENABLED");
  if (!productionBuild || !stagingRuntime) blockers.push("NOT_STAGING_RELEASE");
  if (!m2mAuthDisabled || !localDeliveryApiDisabled) {
    blockers.push("RUNTIME_NOT_CLOSED");
  }
  if (!publicConfiguration) blockers.push("M2M_CONFIGURATION_INVALID");
  if (!releaseProvenancePresent) blockers.push("RELEASE_PROVENANCE_MISSING");
  if (!forbiddenSecretsAbsent) blockers.push("FORBIDDEN_SECRET_PRESENT");

  return {
    blockers,
    attestation:
      blockers.length === 0 && publicConfiguration
        ? {
            ...publicConfiguration,
            sourceCommitSha,
            sourceTreeSha,
            certifiedCommitSha,
            certifiedTreeSha,
            verifierDigestSha256,
          }
        : null,
    gates: {
      activationUiEnabled,
      approvalUiDisabled,
      productionBuild,
      stagingRuntime,
      m2mAuthDisabled,
      localDeliveryApiDisabled,
      releaseProvenancePresent,
      forbiddenSecretsAbsent,
    },
  };
}

export function activationTransitionGuardsAreIntact(
  rows: readonly ActivationBlockerRow[],
) {
  const expectedTables = new Map([
    ["machine_client_no_activation", "MachineClient"],
    ["machine_credential_no_activation", "MachineCredential"],
    ["machine_grant_no_activation", "MachineClientGrant"],
  ]);

  return (
    rows.length === expectedTables.size &&
    rows.every(
      (row) =>
        expectedTables.get(row.triggerName) === row.tableName &&
        row.schemaName === "public" &&
        row.enabledMode === "O" &&
        row.functionName === "guard_staging_machine_authorization_activation" &&
        row.triggerType === 23,
    )
  );
}

export function activationRecordGuardsAreIntact(
  rows: readonly ActivationBlockerRow[],
) {
  const expected = new Map<
    string,
    { tableName: string; functionName: string; triggerType: number }
  >([
    [
      "machine_authorization_activation_no_update",
      {
        tableName: "MachineAuthorizationActivation",
        functionName: "reject_machine_authorization_activation_record_mutation",
        triggerType: 19,
      },
    ],
    [
      "machine_authorization_activation_no_delete",
      {
        tableName: "MachineAuthorizationActivation",
        functionName: "reject_machine_authorization_activation_record_mutation",
        triggerType: 11,
      },
    ],
    [
      "machine_authorization_activation_validate_insert",
      {
        tableName: "MachineAuthorizationActivation",
        functionName: "validate_machine_authorization_activation_insert",
        triggerType: 7,
      },
    ],
  ]);

  return (
    rows.length === expected.size &&
    rows.every((row) => {
      const guard = expected.get(row.triggerName);
      return (
        guard?.tableName === row.tableName &&
        row.schemaName === "public" &&
        row.enabledMode === "O" &&
        guard.functionName === row.functionName &&
        guard.triggerType === row.triggerType
      );
    })
  );
}

export function activationIdentityIsExpected(input: {
  clientKey: string;
  environment: string;
}) {
  return (
    input.clientKey === STAGING_M2M_CLIENT_KEY &&
    input.environment === STAGING_M2M_ENVIRONMENT
  );
}
