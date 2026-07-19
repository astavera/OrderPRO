export const STAGING_M2M_CLIENT_KEY = "storefront-staging";
export const STAGING_M2M_ENVIRONMENT = "STAGING";
export const STAGING_M2M_PENDING_STATUS = "PENDING_VERIFICATION";
export const STAGING_M2M_DISPLAY_NAME = "OrderPro Storefront STAGING";
export const STAGING_M2M_AUDIENCE =
  "https://api.orderpro.internal/local-delivery/staging";
export const STAGING_M2M_SCOPES = [
  "local-delivery:holds",
  "local-delivery:quote",
] as const;
export const STAGING_M2M_APPROVAL_CONFIRMATION =
  "APPROVE STOREFRONT-STAGING WITHOUT ACTIVATION";
export const STAGING_M2M_APPROVAL_PROCEDURE =
  "record_staging_machine_authorization_approval(text,uuid,text,uuid,text,text,text,uuid,uuid,uuid)";

const sha = /^[a-f0-9]{40,64}$/;
const sha256 = /^[a-f0-9]{64}$/;
const compactJwt =
  /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/;

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

export type StagingApprovalEnvironment = Record<string, string | undefined>;

export type StagingApprovalReadinessCode =
  | "UI_GATE_DISABLED"
  | "NOT_STAGING_RELEASE"
  | "RUNTIME_NOT_CLOSED"
  | "M2M_CONFIGURATION_INVALID"
  | "RELEASE_PROVENANCE_MISSING"
  | "FORBIDDEN_SECRET_PRESENT";

export type StagingApprovalDeploymentAttestation = {
  issuer: string;
  audience: typeof STAGING_M2M_AUDIENCE;
  sourceCommitSha: string;
  sourceTreeSha: string;
  certifiedCommitSha: string;
  certifiedTreeSha: string;
  verifierDigestSha256: string;
};

export type StagingApprovalEnvironmentReadiness = {
  blockers: StagingApprovalReadinessCode[];
  attestation: StagingApprovalDeploymentAttestation | null;
  gates: {
    approvalUiEnabled: boolean;
    productionBuild: boolean;
    stagingRuntime: boolean;
    m2mAuthDisabled: boolean;
    localDeliveryApiDisabled: boolean;
    releaseProvenancePresent: boolean;
    forbiddenSecretsAbsent: boolean;
  };
};

function canonicalAuth0Configuration(environment: StagingApprovalEnvironment) {
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

export function getStagingApprovalEnvironmentReadiness(
  environment: StagingApprovalEnvironment,
): StagingApprovalEnvironmentReadiness {
  const approvalUiEnabled =
    environment.ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED?.trim() === "true";
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
  const sourceCommitSha =
    environment.ORDERPRO_RELEASE_COMMIT_SHA?.trim() ?? "";
  const sourceTreeSha = environment.ORDERPRO_RELEASE_TREE_SHA?.trim() ?? "";
  const verifierDigestSha256 =
    environment.ORDERPRO_RELEASE_M2M_VERIFIER_DIGEST_SHA256?.trim() ?? "";
  const certifiedCommitSha =
    environment.ORDERPRO_RELEASE_M2M_CERTIFIED_COMMIT_SHA?.trim() ?? "";
  const certifiedTreeSha =
    environment.ORDERPRO_RELEASE_M2M_CERTIFIED_TREE_SHA?.trim() ?? "";
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
  const blockers: StagingApprovalReadinessCode[] = [];

  if (!approvalUiEnabled) blockers.push("UI_GATE_DISABLED");
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
      approvalUiEnabled,
      productionBuild,
      stagingRuntime,
      m2mAuthDisabled,
      localDeliveryApiDisabled,
      releaseProvenancePresent,
      forbiddenSecretsAbsent,
    },
  };
}

export function isSafeStagingApprovalReason(reason: string) {
  return (
    reason === reason.trim() &&
    reason.length >= 10 &&
    reason.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(reason) &&
    !/\bBearer\s+/i.test(reason) &&
    !/(client[_ -]?secret|access[_ -]?token|authorization\s*:)/i.test(reason) &&
    !compactJwt.test(reason) &&
    !/(?:^|\s)[A-Za-z0-9_-]{32,}(?:\s|$)/.test(reason)
  );
}

export type ActivationBlockerRow = {
  triggerName: string;
  tableName: string;
  schemaName: string;
  enabledMode: string;
  functionName: string;
  triggerType: number;
};

export function activationBlockersAreIntact(rows: readonly ActivationBlockerRow[]) {
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
        row.functionName === "reject_machine_authorization_activation" &&
        row.triggerType === 23,
    )
  );
}

export function approvalGuardsAreIntact(rows: readonly ActivationBlockerRow[]) {
  const expected = new Map<
    string,
    { tableName: string; functionName: string; triggerType: number }
  >([
    [
      "machine_authorization_approval_no_update",
      {
        tableName: "MachineAuthorizationApproval",
        functionName: "reject_machine_authorization_approval_mutation",
        triggerType: 19,
      },
    ],
    [
      "machine_authorization_approval_no_delete",
      {
        tableName: "MachineAuthorizationApproval",
        functionName: "reject_machine_authorization_approval_mutation",
        triggerType: 11,
      },
    ],
    [
      "machine_authorization_approval_validate_insert",
      {
        tableName: "MachineAuthorizationApproval",
        functionName: "validate_machine_authorization_approval_insert",
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

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && sha256.test(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function containsSensitiveEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /\bBearer\s+/i.test(value) ||
      /(client[_ -]?secret|access[_ -]?token|authorization\s*:)/i.test(value) ||
      compactJwt.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsSensitiveEvidence);
  if (!isRecord(value)) return false;

  const forbiddenKeys = new Set([
    "accesstoken",
    "authorization",
    "authorizationheader",
    "clientsecret",
    "externalclientid",
    "jti",
    "rawtoken",
  ]);
  return Object.entries(value).some(
    ([key, nested]) =>
      forbiddenKeys.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")) ||
      containsSensitiveEvidence(nested),
  );
}
