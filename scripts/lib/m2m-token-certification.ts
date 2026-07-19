import { createHash } from "node:crypto";
import type { Auth0M2mConfiguration } from "../../src/infrastructure/m2m/auth0-config";

export const CERTIFICATION_CLIENT_KEY = "storefront-staging";
export const CERTIFICATION_SCOPES = [
  "local-delivery:holds",
  "local-delivery:quote",
] as const;

const pendingStatus = "PENDING_VERIFICATION" as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PendingMachineClientSnapshot = {
  readonly machineClientId: string;
  readonly clientKey: string;
  readonly clientVersion: number;
  readonly clientStatus: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly credentialStatus: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly credentialVerifiedAt: Date | null;
  readonly provider: "AUTH0";
  readonly issuer: string;
  readonly externalClientId: string;
  readonly environment: "STAGING" | "PRODUCTION";
  readonly grants: readonly {
    readonly scope: string;
    readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
    readonly version: number;
  }[];
};

function exactScopes(scopes: readonly string[]) {
  return (
    scopes.length === CERTIFICATION_SCOPES.length &&
    new Set(scopes).size === CERTIFICATION_SCOPES.length &&
    [...new Set(scopes)].sort().every(
      (scope, index) => scope === CERTIFICATION_SCOPES[index],
    )
  );
}

export function isExactPendingCertificationSnapshot(
  snapshot: PendingMachineClientSnapshot,
  config: Auth0M2mConfiguration,
) {
  return (
    snapshot.clientKey === CERTIFICATION_CLIENT_KEY &&
    snapshot.environment === "STAGING" &&
    snapshot.environment === config.environment &&
    snapshot.provider === "AUTH0" &&
    snapshot.issuer === config.issuer &&
    snapshot.clientStatus === pendingStatus &&
    snapshot.credentialStatus === pendingStatus &&
    snapshot.credentialVerifiedAt === null &&
    snapshot.clientVersion > 0 &&
    snapshot.credentialVersion > 0 &&
    uuid.test(snapshot.machineClientId) &&
    uuid.test(snapshot.credentialId) &&
    /^[A-Za-z0-9_-]{8,120}$/.test(snapshot.externalClientId) &&
    snapshot.grants.length === CERTIFICATION_SCOPES.length &&
    snapshot.grants.every(
      (grant) =>
        grant.status === pendingStatus &&
        grant.version > 0,
    ) &&
    exactScopes(snapshot.grants.map((grant) => grant.scope))
  );
}

export type MachineTokenCertificationEvidence = {
  readonly schemaVersion: "orderpro.m2m-token-certification.v1";
  readonly certificationOutcome: "VERIFIED_PENDING_APPROVAL";
  readonly runtimeRegistryOutcome: "UNAUTHORIZED_PENDING";
  readonly clientKey: typeof CERTIFICATION_CLIENT_KEY;
  readonly machineClientId: string;
  readonly credentialId: string;
  readonly environment: "STAGING";
  readonly provider: "AUTH0";
  readonly issuer: string;
  readonly audience: string;
  readonly allowedAlgorithm: "RS256";
  readonly tokenProfile: "RFC9068";
  readonly tokenLifetimeSeconds: number;
  readonly scopes: readonly string[];
  readonly clientStatus: "PENDING_VERIFICATION";
  readonly clientVersion: number;
  readonly credentialStatus: "PENDING_VERIFICATION";
  readonly grantStatus: "PENDING_VERIFICATION";
  readonly grantVersions: readonly {
    readonly scope: string;
    readonly version: number;
  }[];
  readonly previousCredentialVersion: number;
  readonly certifiedCredentialVersion: number;
  readonly sourceCommitSha: string;
  readonly sourceTreeSha: string;
  readonly verifierDigestSha256: string;
  readonly certifiedAt: string;
  readonly correlationId: string;
};

export function createMachineTokenCertificationEvidence(input: {
  readonly snapshot: PendingMachineClientSnapshot;
  readonly config: Auth0M2mConfiguration;
  readonly tokenLifetimeSeconds: number;
  readonly sourceCommitSha: string;
  readonly sourceTreeSha: string;
  readonly verifierDigestSha256: string;
  readonly certifiedAt: Date;
  readonly correlationId: string;
}): MachineTokenCertificationEvidence {
  if (
    !isExactPendingCertificationSnapshot(input.snapshot, input.config) ||
    input.tokenLifetimeSeconds !== 3_600 ||
    !/^[a-f0-9]{40,64}$/.test(input.sourceCommitSha) ||
    !/^[a-f0-9]{40,64}$/.test(input.sourceTreeSha) ||
    !/^[a-f0-9]{64}$/.test(input.verifierDigestSha256) ||
    Number.isNaN(input.certifiedAt.getTime()) ||
    !uuid.test(input.correlationId)
  ) {
    throw new Error("Certification evidence input is invalid.");
  }

  return {
    schemaVersion: "orderpro.m2m-token-certification.v1",
    certificationOutcome: "VERIFIED_PENDING_APPROVAL",
    runtimeRegistryOutcome: "UNAUTHORIZED_PENDING",
    clientKey: CERTIFICATION_CLIENT_KEY,
    machineClientId: input.snapshot.machineClientId,
    credentialId: input.snapshot.credentialId,
    environment: "STAGING",
    provider: "AUTH0",
    issuer: input.config.issuer,
    audience: input.config.audience,
    allowedAlgorithm: "RS256",
    tokenProfile: "RFC9068",
    tokenLifetimeSeconds: input.tokenLifetimeSeconds,
    scopes: [...CERTIFICATION_SCOPES],
    clientStatus: pendingStatus,
    clientVersion: input.snapshot.clientVersion,
    credentialStatus: pendingStatus,
    grantStatus: pendingStatus,
    grantVersions: input.snapshot.grants.map((grant) => ({
      scope: grant.scope,
      version: grant.version,
    })),
    previousCredentialVersion: input.snapshot.credentialVersion,
    certifiedCredentialVersion: input.snapshot.credentialVersion + 1,
    sourceCommitSha: input.sourceCommitSha,
    sourceTreeSha: input.sourceTreeSha,
    verifierDigestSha256: input.verifierDigestSha256,
    certifiedAt: input.certifiedAt.toISOString(),
    correlationId: input.correlationId,
  };
}

export function evidenceDigest(evidence: MachineTokenCertificationEvidence) {
  return createHash("sha256")
    .update(JSON.stringify(evidence), "utf8")
    .digest("hex");
}
