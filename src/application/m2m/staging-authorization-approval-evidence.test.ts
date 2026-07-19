import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let parseStagingCertificationEvidence: typeof import("./staging-authorization-approval-evidence").parseStagingCertificationEvidence;
let isExactPendingApprovalSnapshot: typeof import("./staging-authorization-approval-evidence").isExactPendingApprovalSnapshot;

const clientId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const auditId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";
const certifiedAt = "2026-07-19T20:00:00.000Z";
const issuer = "https://orderpro-staging.us.auth0.com/";
const verifierDigestSha256 = "c".repeat(64);

function fixture() {
  const grantVersions = [
    { scope: "local-delivery:holds", version: 1 },
    { scope: "local-delivery:quote", version: 1 },
  ];
  const canonicalEvidence = {
    schemaVersion: "orderpro.m2m-token-certification.v1",
    certificationOutcome: "VERIFIED_PENDING_APPROVAL",
    runtimeRegistryOutcome: "UNAUTHORIZED_PENDING",
    clientKey: "storefront-staging",
    machineClientId: clientId,
    credentialId,
    environment: "STAGING",
    provider: "AUTH0",
    issuer,
    audience: "https://api.orderpro.internal/local-delivery/staging",
    allowedAlgorithm: "RS256",
    tokenProfile: "RFC9068",
    tokenLifetimeSeconds: 3600,
    scopes: ["local-delivery:holds", "local-delivery:quote"],
    clientStatus: "PENDING_VERIFICATION",
    clientVersion: 1,
    credentialStatus: "PENDING_VERIFICATION",
    grantStatus: "PENDING_VERIFICATION",
    grantVersions,
    previousCredentialVersion: 1,
    certifiedCredentialVersion: 2,
    sourceCommitSha: "a".repeat(40),
    sourceTreeSha: "b".repeat(40),
    verifierDigestSha256,
    certifiedAt,
    correlationId,
  };
  const evidenceDigestSha256 = createHash("sha256")
    .update(JSON.stringify(canonicalEvidence), "utf8")
    .digest("hex");
  const audit = {
    id: auditId,
    actorId: null,
    action: "m2m.client.token_certified",
    entityType: "MachineClient",
    entityId: clientId,
    correlationId,
    before: {
      clientStatus: "PENDING_VERIFICATION",
      clientVersion: 1,
      credentialStatus: "PENDING_VERIFICATION",
      credentialVersion: 1,
      grantStatus: "PENDING_VERIFICATION",
      grantVersions,
      verifiedAt: null,
    },
    after: { ...canonicalEvidence, evidenceDigestSha256 },
    occurredAt: new Date(certifiedAt),
  };
  const attestation = {
    issuer,
    audience: "https://api.orderpro.internal/local-delivery/staging" as const,
    sourceCommitSha: "d".repeat(40),
    sourceTreeSha: "e".repeat(40),
    certifiedCommitSha: "a".repeat(40),
    certifiedTreeSha: "b".repeat(40),
    verifierDigestSha256,
  };
  const client = {
    id: clientId,
    key: "storefront-staging",
    displayName: "OrderPro Storefront STAGING",
    environment: "STAGING",
    status: "PENDING_VERIFICATION",
    ownerUserId: null,
    version: 1,
    activatedAt: null,
    suspendedAt: null,
    revokedAt: null,
    credentials: [
      {
        id: credentialId,
        environment: "STAGING",
        provider: "AUTH0",
        issuer,
        externalClientId: "public_client_id_123",
        status: "PENDING_VERIFICATION",
        version: 2,
        verifiedAt: new Date(certifiedAt),
        activatedAt: null,
        suspendedAt: null,
        revokedAt: null,
      },
    ],
    grants: grantVersions.map(({ scope, version }) => ({
      scope,
      version,
      environment: "STAGING",
      status: "PENDING_VERIFICATION",
      activatedAt: null,
      suspendedAt: null,
      revokedAt: null,
    })),
  };

  return { audit, attestation, client, evidenceDigestSha256 };
}

beforeAll(async () => {
  ({ parseStagingCertificationEvidence, isExactPendingApprovalSnapshot } =
    await import("./staging-authorization-approval-evidence"));
});

describe("STAGING certification evidence", () => {
  it("accepts the exact canonical certification and pending snapshot", () => {
    const data = fixture();
    const evidence = parseStagingCertificationEvidence({
      audit: data.audit,
      expectedAuditEventId: auditId,
      expectedEvidenceDigestSha256: data.evidenceDigestSha256,
      attestation: data.attestation,
    });

    expect(evidence).not.toBeNull();
    expect(
      isExactPendingApprovalSnapshot({
        actor: { id: "owner", active: true, roles: [{ role: "OWNER" }] },
        client: data.client,
        evidence: evidence!,
        issuer,
      }),
    ).toBe(true);
  });

  it("rejects a release verifier that differs from the certification", () => {
    const data = fixture();
    expect(
      parseStagingCertificationEvidence({
        audit: data.audit,
        expectedAuditEventId: auditId,
        expectedEvidenceDigestSha256: data.evidenceDigestSha256,
        attestation: {
          ...data.attestation,
          verifierDigestSha256: "f".repeat(64),
        },
      }),
    ).toBeNull();
  });

  it("rejects certification evidence from a commit not bound by CI", () => {
    const data = fixture();
    expect(
      parseStagingCertificationEvidence({
        audit: data.audit,
        expectedAuditEventId: auditId,
        expectedEvidenceDigestSha256: data.evidenceDigestSha256,
        attestation: {
          ...data.attestation,
          certifiedCommitSha: "f".repeat(40),
        },
      }),
    ).toBeNull();
  });

  it("rejects digest tampering and any state that is no longer pending", () => {
    const data = fixture();
    const evidence = parseStagingCertificationEvidence({
      audit: data.audit,
      expectedAuditEventId: auditId,
      expectedEvidenceDigestSha256: "0".repeat(64),
      attestation: data.attestation,
    });
    expect(evidence).toBeNull();

    const validEvidence = parseStagingCertificationEvidence({
      audit: data.audit,
      expectedAuditEventId: auditId,
      expectedEvidenceDigestSha256: data.evidenceDigestSha256,
      attestation: data.attestation,
    });
    expect(
      isExactPendingApprovalSnapshot({
        actor: { id: "owner", active: true, roles: [{ role: "OWNER" }] },
        client: { ...data.client, status: "ACTIVE" },
        evidence: validEvidence!,
        issuer,
      }),
    ).toBe(false);
  });

  it("rejects a non-Owner even when the machine snapshot is intact", () => {
    const data = fixture();
    const evidence = parseStagingCertificationEvidence({
      audit: data.audit,
      expectedAuditEventId: auditId,
      expectedEvidenceDigestSha256: data.evidenceDigestSha256,
      attestation: data.attestation,
    });

    expect(
      isExactPendingApprovalSnapshot({
        actor: {
          id: "operations-admin",
          active: true,
          roles: [{ role: "OPERATIONS_ADMIN" }],
        },
        client: data.client,
        evidence: evidence!,
        issuer,
      }),
    ).toBe(false);
  });
});
