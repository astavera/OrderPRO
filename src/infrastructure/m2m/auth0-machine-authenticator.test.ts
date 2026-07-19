import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JWTHeaderParameters,
  type JWTPayload,
} from "jose";
import type {
  MachineClientRegistry,
  ResolveMachineClientResult,
} from "../../application/m2m/machine-client-registry";
import type { Auth0M2mConfiguration } from "./auth0-config";
import {
  createAuth0MachineAuthenticator,
  createAuth0MachineAuthenticatorForTesting,
} from "./auth0-machine-authenticator";

const config: Auth0M2mConfiguration = {
  mode: "AUTH0",
  environment: "STAGING",
  issuer: "https://orderpro-staging.us.auth0.com/",
  audience: "https://api.orderpro.internal/local-delivery/staging",
  jwksUri: "https://orderpro-staging.us.auth0.com/.well-known/jwks.json",
  allowedAlgorithm: "RS256",
  tokenProfile: "RFC9068",
};

const now = new Date("2026-07-19T16:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);
const externalClientId = "auth0ClientId_1234567890";
const keyId = "auth0-test-key-1";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let otherPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let verificationKey: ReturnType<typeof createLocalJWKSet>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { modulusLength: 2_048 });
  const secondary = await generateKeyPair("RS256", { modulusLength: 2_048 });
  privateKey = primary.privateKey;
  otherPrivateKey = secondary.privateKey;
  publicJwk = await exportJWK(primary.publicKey);
  verificationKey = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function defaultClaims(): JWTPayload & { client_id?: unknown; scope?: unknown } {
  return {
    iss: config.issuer,
    sub: `${externalClientId}@clients`,
    aud: config.audience,
    exp: nowSeconds + 3_600,
    iat: nowSeconds,
    jti: "access-token-jti-1",
    client_id: externalClientId,
    scope: "local-delivery:quote local-delivery:holds",
  };
}

async function signToken(options: {
  claims?: Partial<ReturnType<typeof defaultClaims>>;
  header?: Partial<JWTHeaderParameters>;
  signingKey?: typeof privateKey;
} = {}) {
  return new SignJWT({ ...defaultClaims(), ...options.claims })
    .setProtectedHeader({
      alg: "RS256",
      typ: "at+jwt",
      kid: keyId,
      ...options.header,
    })
    .sign(options.signingKey ?? privateKey);
}

function registryWith(result: ResolveMachineClientResult = {
  resolved: true,
  principal: {
    clientId: "storefront-staging",
    environment: "STAGING",
    scopes: ["local-delivery:quote"],
  },
}) {
  const resolve = vi.fn(async () => result);
  return {
    registry: { resolve } satisfies MachineClientRegistry,
    resolve,
  };
}

function requestWithAuthorization(value?: string) {
  const headers = new Headers();
  if (value !== undefined) headers.set("Authorization", value);
  return new Request("https://orderpro.test/api/v1/local-delivery/quote", { headers });
}

async function authenticate(
  token: string,
  registry: MachineClientRegistry = registryWith().registry,
) {
  return createAuth0MachineAuthenticatorForTesting({
    config,
    registry,
    verificationKey,
    now: () => now,
  })(requestWithAuthorization(`Bearer ${token}`));
}

describe("Auth0 RFC 9068 machine authenticator", () => {
  it("verifies the token and returns only the internal registered principal", async () => {
    const token = await signToken();
    const { registry, resolve } = registryWith();

    await expect(authenticate(token, registry)).resolves.toEqual({
      authenticated: true,
      principal: {
        clientId: "storefront-staging",
        environment: "STAGING",
        scopes: ["local-delivery:quote"],
      },
    });
    expect(resolve).toHaveBeenCalledWith({
      provider: "AUTH0",
      issuer: config.issuer,
      externalClientId,
      environment: "STAGING",
      tokenScopes: ["local-delivery:quote", "local-delivery:holds"],
    });
  });

  it("accepts a single exact audience array and standards-compliant bearer spacing", async () => {
    const token = await signToken({ claims: { aud: [config.audience] } });
    const authenticator = createAuth0MachineAuthenticatorForTesting({
      config,
      registry: registryWith().registry,
      verificationKey,
      now: () => now,
    });

    await expect(
      authenticator(requestWithAuthorization(`bEaReR   ${token}`)),
    ).resolves.toMatchObject({ authenticated: true });
  });

  it("rejects missing, malformed, ambiguous, or oversized bearer headers", async () => {
    const token = await signToken();
    const authenticator = createAuth0MachineAuthenticatorForTesting({
      config,
      registry: registryWith().registry,
      verificationKey,
      now: () => now,
    });
    const duplicateHeaders = new Headers();
    duplicateHeaders.append("Authorization", `Bearer ${token}`);
    duplicateHeaders.append("Authorization", `Bearer ${token}`);

    for (const request of [
      requestWithAuthorization(),
      requestWithAuthorization("Basic credentials"),
      requestWithAuthorization("Bearer not-a-jwt"),
      requestWithAuthorization("Bearer  two-spaces"),
      new Request("https://orderpro.test", { headers: duplicateHeaders }),
      requestWithAuthorization(`Bearer ${"a".repeat(8_193)}`),
    ]) {
      await expect(authenticator(request)).resolves.toEqual({
        authenticated: false,
        code: "UNAUTHORIZED",
      });
    }
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.us.auth0.com/" }],
    ["wrong audience", { aud: "https://api.attacker.test/" }],
    ["mixed audience", { aud: [config.audience, "https://api.attacker.test/"] }],
    ["expired token", { iat: nowSeconds - 3_661, exp: nowSeconds - 61 }],
    ["future iat", { iat: nowSeconds + 61, exp: nowSeconds + 3_600 }],
    ["lifetime over one hour", { exp: nowSeconds + 3_601 }],
    ["subject mismatch", { sub: "different-client@clients" }],
    ["missing client_id", { client_id: undefined, azp: externalClientId }],
    ["missing jti", { jti: undefined }],
    ["missing scope", { scope: undefined, permissions: ["local-delivery:quote"] }],
    ["duplicate scope", { scope: "local-delivery:quote local-delivery:quote" }],
    ["non-space scope separator", { scope: "local-delivery:quote\tlocal-delivery:holds" }],
    ["sender-constrained token without proof validation", { cnf: { jkt: "thumbprint" } }],
    ["unbound Auth0 organization id", { org_id: "org_123" }],
    ["unbound Auth0 organization name", { org_name: "example" }],
  ])("rejects %s", async (_label, claims) => {
    const token = await signToken({ claims });
    await expect(authenticate(token)).resolves.toEqual({
      authenticated: false,
      code: "UNAUTHORIZED",
    });
  });

  it.each([
    ["wrong type", { typ: "JWT" }],
    ["non-pilot RFC type", { typ: "application/at+jwt" }],
    ["missing key id", { kid: undefined }],
    ["untrusted jku", { jku: "https://attacker.test/jwks.json" }],
    ["untrusted x5u", { x5u: "https://attacker.test/cert.pem" }],
    ["embedded jwk", { jwk: { kty: "RSA", n: "bad", e: "AQAB" } }],
  ] satisfies [string, Partial<JWTHeaderParameters>][]) (
    "rejects a protected header with %s",
    async (_label, header) => {
      const token = await signToken({ header });
      await expect(authenticate(token)).resolves.toEqual({
        authenticated: false,
        code: "UNAUTHORIZED",
      });
    },
  );

  it("rejects the wrong algorithm, kid, or signature", async () => {
    const hs256 = await generateSecret("HS256");
    const wrongAlgorithm = await new SignJWT(defaultClaims())
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: keyId })
      .sign(hs256);
    const wrongKid = await signToken({ header: { kid: "different-key" } });
    const wrongSignature = await signToken({ signingKey: otherPrivateKey });

    for (const token of [wrongAlgorithm, wrongKid, wrongSignature]) {
      await expect(authenticate(token)).resolves.toEqual({
        authenticated: false,
        code: "UNAUTHORIZED",
      });
    }
  });

  it("fails closed for unknown/pending clients and reports registry outages as unavailable", async () => {
    const token = await signToken();
    const pending = registryWith({ resolved: false, reason: "NOT_AUTHORIZED" });
    const outage = registryWith({ resolved: false, reason: "UNAVAILABLE" });
    const throwingRegistry: MachineClientRegistry = {
      async resolve() {
        throw new Error("database connection details must stay private");
      },
    };

    await expect(authenticate(token, pending.registry)).resolves.toEqual({
      authenticated: false,
      code: "UNAUTHORIZED",
    });
    await expect(authenticate(token, outage.registry)).resolves.toEqual({
      authenticated: false,
      code: "M2M_AUTH_NOT_CONFIGURED",
    });
    await expect(authenticate(token, throwingRegistry)).resolves.toEqual({
      authenticated: false,
      code: "M2M_AUTH_NOT_CONFIGURED",
    });
  });

  it("rejects a registry adapter that crosses environments or elevates token scopes", async () => {
    const token = await signToken({ claims: { scope: "local-delivery:quote" } });
    const crossEnvironment = registryWith({
      resolved: true,
      principal: {
        clientId: "storefront-production",
        environment: "PRODUCTION",
        scopes: ["local-delivery:quote"],
      },
    });
    const elevated = registryWith({
      resolved: true,
      principal: {
        clientId: "storefront-staging",
        environment: "STAGING",
        scopes: ["local-delivery:quote", "local-delivery:holds"],
      },
    });

    await expect(authenticate(token, crossEnvironment.registry)).resolves.toEqual({
      authenticated: false,
      code: "M2M_AUTH_NOT_CONFIGURED",
    });
    await expect(authenticate(token, elevated.registry)).resolves.toEqual({
      authenticated: false,
      code: "M2M_AUTH_NOT_CONFIGURED",
    });
  });

  it.each([
    ["network failure", async () => {
      throw new TypeError("network details must stay private");
    }],
    ["timeout", async () => {
      const error = new Error("timeout details must stay private");
      error.name = "TimeoutError";
      throw error;
    }],
    ["HTTP 429", async () => new Response("rate limited", { status: 429 })],
    ["HTTP 500", async () => new Response("upstream error", { status: 500 })],
    ["invalid JSON", async () => new Response("not-json", { status: 200 })],
    ["malformed JWKS", async () => Response.json({ keys: "not-an-array" })],
  ] satisfies [string, () => Promise<Response>][]) (
    "maps remote JWKS %s to temporary unavailability",
    async (_label, fetchImplementation) => {
      vi.stubGlobal("fetch", vi.fn(fetchImplementation));
      const token = await signToken();
      const authenticator = createAuth0MachineAuthenticator({
        config,
        registry: registryWith().registry,
      });

      await expect(
        authenticator(requestWithAuthorization(`Bearer ${token}`)),
      ).resolves.toEqual({
        authenticated: false,
        code: "M2M_AUTH_NOT_CONFIGURED",
      });
    },
  );

  it("keeps an unknown remote JWKS kid as unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
    })));
    const token = await signToken({ header: { kid: "unknown-auth0-key" } });
    const authenticator = createAuth0MachineAuthenticator({
      config,
      registry: registryWith().registry,
    });

    await expect(
      authenticator(requestWithAuthorization(`Bearer ${token}`)),
    ).resolves.toEqual({
      authenticated: false,
      code: "UNAUTHORIZED",
    });
  });

  it("never returns bearer, claim, or verifier details", async () => {
    const sentinel = "secret-sentinel-must-not-escape";
    const token = await signToken({
      claims: { aud: `https://attacker.test/${sentinel}`, jti: sentinel },
    });
    const result = await authenticate(token);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("issuer");
    expect(serialized).not.toContain("jwks");
  });
});
