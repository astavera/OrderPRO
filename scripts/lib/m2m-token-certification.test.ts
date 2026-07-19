import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Auth0M2mConfiguration } from "../../src/infrastructure/m2m/auth0-config";
import {
  readAccessTokenFromStream,
  readTokenTiming,
} from "../certify-auth0-m2m-token";
import {
  CERTIFICATION_CLIENT_KEY,
  CERTIFICATION_SCOPES,
  createMachineTokenCertificationEvidence,
  evidenceDigest,
  isExactPendingCertificationSnapshot,
  type PendingMachineClientSnapshot,
} from "./m2m-token-certification";

const config: Auth0M2mConfiguration = {
  mode: "AUTH0",
  environment: "STAGING",
  issuer: "https://orderpro-staging.us.auth0.com/",
  audience: "https://api.orderpro.internal/local-delivery/staging",
  jwksUri: "https://orderpro-staging.us.auth0.com/.well-known/jwks.json",
  allowedAlgorithm: "RS256",
  tokenProfile: "RFC9068",
};

function snapshot(
  overrides: Partial<PendingMachineClientSnapshot> = {},
): PendingMachineClientSnapshot {
  return {
    machineClientId: "11111111-1111-4111-8111-111111111111",
    clientKey: CERTIFICATION_CLIENT_KEY,
    clientVersion: 1,
    clientStatus: "PENDING_VERIFICATION",
    credentialId: "22222222-2222-4222-8222-222222222222",
    credentialVersion: 1,
    credentialStatus: "PENDING_VERIFICATION",
    credentialVerifiedAt: null,
    provider: "AUTH0",
    issuer: config.issuer,
    externalClientId: "auth0ClientId_1234567890",
    environment: "STAGING",
    grants: CERTIFICATION_SCOPES.map((scope) => ({
      scope,
      status: "PENDING_VERIFICATION" as const,
      version: 1,
    })),
    ...overrides,
  };
}

describe("pending Auth0 M2M token certification", () => {
  it("accepts only the exact untouched pending registration", () => {
    expect(isExactPendingCertificationSnapshot(snapshot(), config)).toBe(true);
    expect(isExactPendingCertificationSnapshot(snapshot({
      credentialVerifiedAt: new Date("2026-07-19T12:00:00.000Z"),
    }), config)).toBe(false);
    expect(isExactPendingCertificationSnapshot(snapshot({
      grants: [
        { scope: "local-delivery:holds", status: "PENDING_VERIFICATION", version: 1 },
        { scope: "local-delivery:holds", status: "PENDING_VERIFICATION", version: 1 },
      ],
    }), config)).toBe(false);
    expect(isExactPendingCertificationSnapshot(snapshot({
      clientStatus: "ACTIVE",
    }), config)).toBe(false);
  });

  it("builds deterministic evidence without external credentials or token claims", () => {
    const evidence = createMachineTokenCertificationEvidence({
      snapshot: snapshot(),
      config,
      tokenLifetimeSeconds: 3_600,
      sourceCommitSha: "c".repeat(40),
      sourceTreeSha: "d".repeat(40),
      verifierDigestSha256: "a".repeat(64),
      certifiedAt: new Date("2026-07-19T12:00:00.000Z"),
      correlationId: "33333333-3333-4333-8333-333333333333",
    });
    const serialized = JSON.stringify(evidence);

    expect(evidenceDigest(evidence)).toMatch(/^[a-f0-9]{64}$/);
    expect(evidenceDigest(evidence)).toBe(evidenceDigest(evidence));
    expect(serialized).not.toContain("auth0ClientId_1234567890");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("jti");
    expect(evidence).toMatchObject({
      certificationOutcome: "VERIFIED_PENDING_APPROVAL",
      runtimeRegistryOutcome: "UNAUTHORIZED_PENDING",
      clientStatus: "PENDING_VERIFICATION",
      clientVersion: 1,
      credentialStatus: "PENDING_VERIFICATION",
      grantStatus: "PENDING_VERIFICATION",
      grantVersions: CERTIFICATION_SCOPES.map((scope) => ({
        scope,
        version: 1,
      })),
    });
  });

  it("reads one compact JWT only from a bounded stdin stream", async () => {
    const compact = "header.payload.signature";
    await expect(
      readAccessTokenFromStream(Readable.from([`${compact}\r\n`])),
    ).resolves.toBe(compact);
    await expect(
      readAccessTokenFromStream(Readable.from([`${compact}\nextra`])),
    ).rejects.toThrow();
    await expect(
      readAccessTokenFromStream(Readable.from(["a".repeat(8_195)])),
    ).rejects.toThrow();
  });

  it("accepts only safe, positive token timing claims", () => {
    const compactToken = (payload: object) =>
      `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;

    expect(readTokenTiming(compactToken({ iat: 1_700_000_000, exp: 1_700_003_600 })))
      .toEqual({
        lifetimeSeconds: 3_600,
        expiresAtEpochSeconds: 1_700_003_600,
      });
    expect(() => readTokenTiming(compactToken({
      iat: 1_700_003_600,
      exp: 1_700_000_000,
    }))).toThrow();
    expect(() => readTokenTiming(compactToken({
      iat: 1_700_000_000,
      exp: Number.MAX_SAFE_INTEGER,
    }))).toThrow();
  });
});
