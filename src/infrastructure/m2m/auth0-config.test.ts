import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseAuth0M2mConfiguration } from "./auth0-config";

const validEnvironment = {
  ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
  ORDERPRO_M2M_AUTH_MODE: "AUTH0",
  ORDERPRO_M2M_ISSUER: "https://orderpro-staging.us.auth0.com/",
  ORDERPRO_M2M_AUDIENCE: "https://api.orderpro.internal/local-delivery/staging",
  ORDERPRO_M2M_JWKS_URI:
    "https://orderpro-staging.us.auth0.com/.well-known/jwks.json",
  ORDERPRO_M2M_ALLOWED_ALGORITHM: "RS256",
};

describe("Auth0 M2M configuration", () => {
  it("stays disabled when the mode is absent or explicitly disabled", () => {
    expect(parseAuth0M2mConfiguration({})).toEqual({ valid: false, state: "DISABLED" });
    expect(
      parseAuth0M2mConfiguration({ ORDERPRO_M2M_AUTH_MODE: "DISABLED" }),
    ).toEqual({ valid: false, state: "DISABLED" });
  });

  it("reports only the names of missing variables", () => {
    expect(parseAuth0M2mConfiguration({ ORDERPRO_M2M_AUTH_MODE: "AUTH0" })).toEqual({
      valid: false,
      state: "INCOMPLETE",
      missingVariables: [
        "ORDERPRO_RUNTIME_ENVIRONMENT",
        "ORDERPRO_M2M_ISSUER",
        "ORDERPRO_M2M_AUDIENCE",
        "ORDERPRO_M2M_JWKS_URI",
        "ORDERPRO_M2M_ALLOWED_ALGORITHM",
      ],
    });
  });

  it("accepts the exact STAGING contract without enabling the runtime", () => {
    expect(parseAuth0M2mConfiguration(validEnvironment)).toEqual({
      valid: true,
      config: {
        mode: "AUTH0",
        environment: "STAGING",
        issuer: validEnvironment.ORDERPRO_M2M_ISSUER,
        audience: validEnvironment.ORDERPRO_M2M_AUDIENCE,
        jwksUri: validEnvironment.ORDERPRO_M2M_JWKS_URI,
        allowedAlgorithm: "RS256",
        tokenProfile: "RFC9068",
      },
    });
  });

  it.each([
    "http://orderpro-staging.us.auth0.com/",
    "https://user:password@orderpro-staging.us.auth0.com/",
    "https://orderpro-staging.us.auth0.com/tenant",
    "https://orderpro-staging.us.auth0.com/?environment=staging",
    "https://orderpro-staging.us.auth0.com/#staging",
    "https://orderpro-staging.us.auth0.com:444/",
    "https://orderpro-staging.us.auth0.com",
    "https://identity.example.com/",
  ])("rejects a non-canonical Auth0 issuer: %s", (issuer) => {
    const result = parseAuth0M2mConfiguration({
      ...validEnvironment,
      ORDERPRO_M2M_ISSUER: issuer,
    });

    expect(result).toEqual({
      valid: false,
      state: "INVALID",
      invalidVariables: expect.arrayContaining(["ORDERPRO_M2M_ISSUER"]),
    });
  });

  it.each([
    "http://api.orderpro.example/local-delivery/staging",
    "https://api.orderpro.example/",
    "https://api.orderpro.example/local-delivery/staging?version=1",
    "https://api.orderpro.internal/local-delivery/another-api",
    "https://orderpro-staging.us.auth0.com/orderpro/local-delivery/staging",
    "urn:orderpro:local-delivery:staging",
  ])("rejects an unsafe or unstable audience: %s", (audience) => {
    const result = parseAuth0M2mConfiguration({
      ...validEnvironment,
      ORDERPRO_M2M_AUDIENCE: audience,
    });

    expect(result).toEqual({
      valid: false,
      state: "INVALID",
      invalidVariables: expect.arrayContaining(["ORDERPRO_M2M_AUDIENCE"]),
    });
  });

  it("requires the configured JWKS endpoint to be derived from the trusted issuer", () => {
    expect(
      parseAuth0M2mConfiguration({
        ...validEnvironment,
        ORDERPRO_M2M_JWKS_URI: "https://attacker.example/.well-known/jwks.json",
      }),
    ).toEqual({
      valid: false,
      state: "INVALID",
      invalidVariables: ["ORDERPRO_M2M_JWKS_URI"],
    });
  });

  it("allows only RS256", () => {
    expect(
      parseAuth0M2mConfiguration({
        ...validEnvironment,
        ORDERPRO_M2M_ALLOWED_ALGORITHM: "HS256",
      }),
    ).toEqual({
      valid: false,
      state: "INVALID",
      invalidVariables: ["ORDERPRO_M2M_ALLOWED_ALGORITHM"],
    });
  });

  it("rejects use outside the STAGING environment", () => {
    expect(
      parseAuth0M2mConfiguration({
        ...validEnvironment,
        ORDERPRO_RUNTIME_ENVIRONMENT: "PRODUCTION",
      }),
    ).toEqual({
      valid: false,
      state: "ENVIRONMENT_MISMATCH",
      invalidVariables: ["ORDERPRO_RUNTIME_ENVIRONMENT"],
    });
  });

  it("never includes unrelated secret material in an error result", () => {
    const secret = "do-not-leak-this-client-secret";
    const result = parseAuth0M2mConfiguration({
      ORDERPRO_M2M_AUTH_MODE: "AUTH0",
      AUTH0_CLIENT_SECRET: secret,
      AUTHORIZATION: `Bearer ${secret}`,
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("AUTH0_CLIENT_SECRET");
    expect(JSON.stringify(result)).not.toContain("AUTHORIZATION");
  });
});
