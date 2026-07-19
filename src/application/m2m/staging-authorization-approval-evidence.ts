import "server-only";
import { createHash } from "node:crypto";
import {
  STAGING_M2M_CLIENT_KEY,
  STAGING_M2M_DISPLAY_NAME,
  STAGING_M2M_ENVIRONMENT,
  STAGING_M2M_PENDING_STATUS,
  STAGING_M2M_SCOPES,
  containsSensitiveEvidence,
  isRecord,
  isSha256,
  isUuid,
  type StagingApprovalDeploymentAttestation,
} from "./staging-authorization-approval-policy";

const sha = /^[a-f0-9]{40,64}$/;
const externalClientId = /^[A-Za-z0-9_-]{8,120}$/;

export type CertificationAuditSnapshot = {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  correlationId: string;
  before: unknown;
  after: unknown;
  occurredAt: Date;
};

export type MachineClientApprovalSnapshot = {
  id: string;
  key: string;
  displayName: string;
  environment: string;
  status: string;
  ownerUserId: string | null;
  version: number;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
  credentials: readonly {
    id: string;
    environment: string;
    provider: string;
    issuer: string;
    externalClientId: string;
    status: string;
    version: number;
    verifiedAt: Date | null;
    activatedAt: Date | null;
    suspendedAt: Date | null;
    revokedAt: Date | null;
  }[];
  grants: readonly {
    environment: string;
    scope: string;
    status: string;
    version: number;
    activatedAt: Date | null;
    suspendedAt: Date | null;
    revokedAt: Date | null;
  }[];
};

export type OwnerApprovalActor = {
  id: string;
  active: boolean;
  roles: readonly { role: string }[];
};

export type StagingCertificationEvidence = {
  schemaVersion: "orderpro.m2m-token-certification.v1";
  certificationOutcome: "VERIFIED_PENDING_APPROVAL";
  runtimeRegistryOutcome: "UNAUTHORIZED_PENDING";
  clientKey: typeof STAGING_M2M_CLIENT_KEY;
  machineClientId: string;
  credentialId: string;
  environment: typeof STAGING_M2M_ENVIRONMENT;
  provider: "AUTH0";
  issuer: string;
  audience: string;
  allowedAlgorithm: "RS256";
  tokenProfile: "RFC9068";
  tokenLifetimeSeconds: 3600;
  scopes: readonly string[];
  clientStatus: typeof STAGING_M2M_PENDING_STATUS;
  clientVersion: number;
  credentialStatus: typeof STAGING_M2M_PENDING_STATUS;
  grantStatus: typeof STAGING_M2M_PENDING_STATUS;
  grantVersions: readonly { scope: string; version: number }[];
  previousCredentialVersion: number;
  certifiedCredentialVersion: number;
  sourceCommitSha: string;
  sourceTreeSha: string;
  verifierDigestSha256: string;
  certifiedAt: string;
  correlationId: string;
  evidenceDigestSha256: string;
};

function exactJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integer(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function exactGrantVersions(
  value: unknown,
  expected: readonly { scope: string; version: number }[],
) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every(
      ({ scope, version }, index) =>
        isRecord(value[index]) &&
        value[index].scope === scope &&
        value[index].version === version,
    )
  );
}

export function parseStagingCertificationEvidence(input: {
  audit: CertificationAuditSnapshot | null;
  expectedAuditEventId: string;
  expectedEvidenceDigestSha256: string;
  attestation: StagingApprovalDeploymentAttestation;
}): StagingCertificationEvidence | null {
  const { audit, expectedAuditEventId, expectedEvidenceDigestSha256, attestation } =
    input;
  if (
    !audit ||
    audit.id !== expectedAuditEventId ||
    audit.action !== "m2m.client.token_certified" ||
    audit.entityType !== "MachineClient" ||
    audit.actorId !== null ||
    !isUuid(audit.correlationId) ||
    !isRecord(audit.before) ||
    !isRecord(audit.after) ||
    containsSensitiveEvidence(audit.before) ||
    containsSensitiveEvidence(audit.after)
  ) {
    return null;
  }

  const evidence = audit.after;
  if (
    evidence.schemaVersion !== "orderpro.m2m-token-certification.v1" ||
    evidence.certificationOutcome !== "VERIFIED_PENDING_APPROVAL" ||
    evidence.runtimeRegistryOutcome !== "UNAUTHORIZED_PENDING" ||
    evidence.clientKey !== STAGING_M2M_CLIENT_KEY ||
    !isUuid(evidence.machineClientId) ||
    !isUuid(evidence.credentialId) ||
    evidence.environment !== STAGING_M2M_ENVIRONMENT ||
    evidence.provider !== "AUTH0" ||
    evidence.issuer !== attestation.issuer ||
    evidence.audience !== attestation.audience ||
    evidence.allowedAlgorithm !== "RS256" ||
    evidence.tokenProfile !== "RFC9068" ||
    evidence.tokenLifetimeSeconds !== 3_600 ||
    !exactJson(evidence.scopes, STAGING_M2M_SCOPES) ||
    evidence.clientStatus !== STAGING_M2M_PENDING_STATUS ||
    !integer(evidence.clientVersion) ||
    evidence.credentialStatus !== STAGING_M2M_PENDING_STATUS ||
    evidence.grantStatus !== STAGING_M2M_PENDING_STATUS ||
    !Array.isArray(evidence.grantVersions) ||
    !integer(evidence.previousCredentialVersion) ||
    !integer(evidence.certifiedCredentialVersion) ||
    evidence.certifiedCredentialVersion !== evidence.previousCredentialVersion + 1 ||
    typeof evidence.sourceCommitSha !== "string" ||
    !sha.test(evidence.sourceCommitSha) ||
    typeof evidence.sourceTreeSha !== "string" ||
    !sha.test(evidence.sourceTreeSha) ||
    evidence.sourceCommitSha !== attestation.certifiedCommitSha ||
    evidence.sourceTreeSha !== attestation.certifiedTreeSha ||
    !isSha256(evidence.verifierDigestSha256) ||
    evidence.verifierDigestSha256 !== attestation.verifierDigestSha256 ||
    evidence.correlationId !== audit.correlationId ||
    evidence.evidenceDigestSha256 !== expectedEvidenceDigestSha256 ||
    !isSha256(evidence.evidenceDigestSha256) ||
    typeof evidence.certifiedAt !== "string" ||
    Number.isNaN(Date.parse(evidence.certifiedAt)) ||
    audit.before.clientStatus !== STAGING_M2M_PENDING_STATUS ||
    audit.before.clientVersion !== evidence.clientVersion ||
    audit.before.credentialStatus !== STAGING_M2M_PENDING_STATUS ||
    audit.before.credentialVersion !== evidence.previousCredentialVersion ||
    audit.before.verifiedAt !== null
  ) {
    return null;
  }

  const rawGrantVersions = evidence.grantVersions as unknown[];
  const grantVersions: Array<{ scope: string; version: number } | null> =
    STAGING_M2M_SCOPES.map((scope) => {
    const grant = rawGrantVersions.find(
      (candidate: unknown) => isRecord(candidate) && candidate.scope === scope,
    );
    if (!isRecord(grant) || !integer(grant.version)) return null;
    return { scope, version: grant.version };
  });
  if (
    grantVersions.some((grant) => grant === null) ||
    rawGrantVersions.length !== STAGING_M2M_SCOPES.length
  ) {
    return null;
  }

  const exactGrants = grantVersions as { scope: string; version: number }[];
  if (!exactGrantVersions(audit.before.grantVersions, exactGrants)) return null;
  const canonicalEvidence = {
    schemaVersion: evidence.schemaVersion,
    certificationOutcome: evidence.certificationOutcome,
    runtimeRegistryOutcome: evidence.runtimeRegistryOutcome,
    clientKey: evidence.clientKey,
    machineClientId: evidence.machineClientId,
    credentialId: evidence.credentialId,
    environment: evidence.environment,
    provider: evidence.provider,
    issuer: evidence.issuer,
    audience: evidence.audience,
    allowedAlgorithm: evidence.allowedAlgorithm,
    tokenProfile: evidence.tokenProfile,
    tokenLifetimeSeconds: evidence.tokenLifetimeSeconds,
    scopes: evidence.scopes,
    clientStatus: evidence.clientStatus,
    clientVersion: evidence.clientVersion,
    credentialStatus: evidence.credentialStatus,
    grantStatus: evidence.grantStatus,
    grantVersions: exactGrants,
    previousCredentialVersion: evidence.previousCredentialVersion,
    certifiedCredentialVersion: evidence.certifiedCredentialVersion,
    sourceCommitSha: evidence.sourceCommitSha,
    sourceTreeSha: evidence.sourceTreeSha,
    verifierDigestSha256: evidence.verifierDigestSha256,
    certifiedAt: evidence.certifiedAt,
    correlationId: evidence.correlationId,
  };
  const calculatedDigest = createHash("sha256")
    .update(JSON.stringify(canonicalEvidence), "utf8")
    .digest("hex");
  if (
    calculatedDigest !== evidence.evidenceDigestSha256 ||
    calculatedDigest !== expectedEvidenceDigestSha256
  ) {
    return null;
  }

  return {
    ...(evidence as unknown as StagingCertificationEvidence),
    grantVersions: exactGrants,
  };
}

export function isExactPendingApprovalSnapshot(input: {
  client: MachineClientApprovalSnapshot | null;
  actor: OwnerApprovalActor | null;
  evidence: StagingCertificationEvidence;
  issuer: string;
}) {
  const { client, actor, evidence, issuer } = input;
  if (
    !actor ||
    actor.active !== true ||
    !actor.roles.some(({ role }) => role === "OWNER") ||
    !client ||
    client.id !== evidence.machineClientId ||
    client.key !== STAGING_M2M_CLIENT_KEY ||
    client.displayName !== STAGING_M2M_DISPLAY_NAME ||
    client.environment !== STAGING_M2M_ENVIRONMENT ||
    client.status !== STAGING_M2M_PENDING_STATUS ||
    client.ownerUserId !== null ||
    client.version !== evidence.clientVersion ||
    client.activatedAt !== null ||
    client.suspendedAt !== null ||
    client.revokedAt !== null ||
    client.credentials.length !== 1 ||
    client.grants.length !== STAGING_M2M_SCOPES.length
  ) {
    return false;
  }

  const credential = client.credentials[0];
  if (
    credential.id !== evidence.credentialId ||
    credential.environment !== STAGING_M2M_ENVIRONMENT ||
    credential.provider !== "AUTH0" ||
    credential.issuer !== issuer ||
    !externalClientId.test(credential.externalClientId) ||
    credential.status !== STAGING_M2M_PENDING_STATUS ||
    credential.version !== evidence.certifiedCredentialVersion ||
    !(credential.verifiedAt instanceof Date) ||
    credential.verifiedAt.toISOString() !== evidence.certifiedAt ||
    credential.activatedAt !== null ||
    credential.suspendedAt !== null ||
    credential.revokedAt !== null
  ) {
    return false;
  }

  return STAGING_M2M_SCOPES.every((scope, index) => {
    const grant = client.grants[index];
    const evidenceGrant = evidence.grantVersions[index];
    return (
      grant.scope === scope &&
      grant.environment === STAGING_M2M_ENVIRONMENT &&
      grant.status === STAGING_M2M_PENDING_STATUS &&
      grant.version === evidenceGrant.version &&
      grant.activatedAt === null &&
      grant.suspendedAt === null &&
      grant.revokedAt === null
    );
  });
}
