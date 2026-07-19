import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PrismaMachineClientRegistry } from "./prisma-machine-client-registry";

const input = {
  provider: "AUTH0" as const,
  issuer: "https://dev-rfzzpvgkfg1mwf3m.us.auth0.com/",
  externalClientId: "Auth0TestClientId1234567890AbCd",
  environment: "STAGING" as const,
  tokenScopes: ["local-delivery:quote", "unregistered:scope"],
};

function activeCredential(overrides: Record<string, unknown> = {}) {
  return {
    environment: "STAGING",
    status: "ACTIVE",
    client: {
      key: "storefront-staging",
      environment: "STAGING",
      status: "ACTIVE",
      grants: [
        { environment: "STAGING", scope: "local-delivery:holds" },
        { environment: "STAGING", scope: "local-delivery:quote" },
      ],
    },
    ...overrides,
  };
}

function registry(record: unknown, rejects = false) {
  const findUnique = vi.fn(async () => {
    if (rejects) throw new Error("database unavailable with sensitive context");
    return record;
  });
  const client = {
    machineCredential: { findUnique },
  } as ConstructorParameters<typeof PrismaMachineClientRegistry>[0];
  return { registry: new PrismaMachineClientRegistry(client), findUnique };
}

describe("PrismaMachineClientRegistry", () => {
  it("maps an active Auth0 credential to the stable internal client and intersects scopes", async () => {
    const subject = registry(activeCredential());

    await expect(subject.registry.resolve(input)).resolves.toEqual({
      resolved: true,
      principal: {
        clientId: "storefront-staging",
        environment: "STAGING",
        scopes: ["local-delivery:quote"],
      },
    });
    expect(subject.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        provider_issuer_externalClientId: {
          provider: "AUTH0",
          issuer: input.issuer,
          externalClientId: input.externalClientId,
        },
      },
    }));
  });

  it.each([
    ["unknown credential", null],
    ["pending credential", activeCredential({ status: "PENDING_VERIFICATION" })],
    ["suspended credential", activeCredential({ status: "SUSPENDED" })],
    ["revoked credential", activeCredential({ status: "REVOKED" })],
    [
      "pending client",
      activeCredential({ client: { ...activeCredential().client, status: "PENDING_VERIFICATION" } }),
    ],
    [
      "suspended client",
      activeCredential({ client: { ...activeCredential().client, status: "SUSPENDED" } }),
    ],
    [
      "invalid stored client key",
      activeCredential({ client: { ...activeCredential().client, key: " invalid client " } }),
    ],
    [
      "cross-environment client",
      activeCredential({ client: { ...activeCredential().client, environment: "PRODUCTION" } }),
    ],
    ["cross-environment credential", activeCredential({ environment: "PRODUCTION" })],
    [
      "cross-environment grant",
      activeCredential({
        client: {
          ...activeCredential().client,
          grants: [{ environment: "PRODUCTION", scope: "local-delivery:quote" }],
        },
      }),
    ],
  ])("fails closed for %s", async (_label, record) => {
    await expect(registry(record).registry.resolve(input)).resolves.toEqual({
      resolved: false,
      reason: "NOT_AUTHORIZED",
    });
  });

  it("matches issuer and external Client ID exactly and case-sensitively", async () => {
    const subject = registry(activeCredential());

    await subject.registry.resolve({ ...input, externalClientId: input.externalClientId.toLowerCase() });
    await subject.registry.resolve({ ...input, issuer: input.issuer.toUpperCase() });

    expect(subject.findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          provider_issuer_externalClientId: expect.objectContaining({
            externalClientId: input.externalClientId.toLowerCase(),
          }),
        },
      }),
    );
    expect(subject.findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed input before querying", async () => {
    const subject = registry(activeCredential());
    const malformed = [
      { ...input, issuer: "http://dev-rfzzpvgkfg1mwf3m.us.auth0.com/" },
      { ...input, issuer: "https://dev-rfzzpvgkfg1mwf3m.us.auth0.com/path" },
      { ...input, externalClientId: "short" },
      { ...input, tokenScopes: [""] },
    ];

    for (const value of malformed) {
      await expect(subject.registry.resolve(value)).resolves.toEqual({
        resolved: false,
        reason: "NOT_AUTHORIZED",
      });
    }
    expect(subject.findUnique).not.toHaveBeenCalled();
  });

  it("distinguishes database unavailability without exposing error details", async () => {
    await expect(registry(null, true).registry.resolve(input)).resolves.toEqual({
      resolved: false,
      reason: "UNAVAILABLE",
    });
  });
});
