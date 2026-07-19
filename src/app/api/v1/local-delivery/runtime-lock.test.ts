import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as quote } from "./quote/route";
import { POST as hold } from "./holds/route";
import { POST as confirm } from "./holds/[holdId]/confirm/route";
import { POST as release } from "./holds/[holdId]/release/route";
import {
  composeLocalDeliveryV4Runtime,
  type LocalDeliveryV4RuntimeDependencies,
} from "./runtime";

function request(path: string, body: unknown = {}) {
  return new Request(`http://orderpro.test${path}`, {
    method: "POST",
    headers: {
      Cookie: "human-session=must-not-authorize-machine-api",
      "Content-Type": "application/json",
      "Idempotency-Key": "request-key-001",
      "X-Correlation-ID": "correlation-001",
    },
    body: JSON.stringify(body),
  });
}

function dependencySpies() {
  return {
    authenticate: vi.fn(async () => {
      throw new Error("authenticate must not execute while runtime is locked");
    }),
    evaluateQuote: vi.fn(async () => {
      throw new Error("evaluateQuote must not execute while runtime is locked");
    }),
    createHold: vi.fn(async () => {
      throw new Error("createHold must not execute while runtime is locked");
    }),
    confirmHold: vi.fn(async () => {
      throw new Error("confirmHold must not execute while runtime is locked");
    }),
    releaseHold: vi.fn(async () => {
      throw new Error("releaseHold must not execute while runtime is locked");
    }),
  } satisfies LocalDeliveryV4RuntimeDependencies;
}

async function invokeEveryHandler(handlers: ReturnType<typeof composeLocalDeliveryV4Runtime>["handlers"]) {
  const context = { params: Promise.resolve({ holdId: "capacity-hold-1" }) };
  return Promise.all([
    handlers.quote(request("/api/v1/local-delivery/quote")),
    handlers.createHold(request("/api/v1/local-delivery/holds")),
    handlers.confirmHold(
      request("/api/v1/local-delivery/holds/capacity-hold-1/confirm"),
      context,
    ),
    handlers.releaseHold(
      request("/api/v1/local-delivery/holds/capacity-hold-1/release"),
      context,
    ),
  ]);
}

function expectNoDependencyCalls(dependencies: LocalDeliveryV4RuntimeDependencies) {
  expect(dependencies.authenticate).not.toHaveBeenCalled();
  expect(dependencies.evaluateQuote).not.toHaveBeenCalled();
  expect(dependencies.createHold).not.toHaveBeenCalled();
  expect(dependencies.confirmHold).not.toHaveBeenCalled();
  expect(dependencies.releaseHold).not.toHaveBeenCalled();
}

async function expectLockedResponses(responses: readonly Response[]) {
  expect(responses.map(({ status }) => status)).toEqual([503, 503, 503, 503]);
  for (const response of responses) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toBe("correlation-001");
    await expect(response.json()).resolves.toMatchObject({ code: "M2M_AUTH_NOT_CONFIGURED" });
  }
}

describe("local delivery runtime safety lock", () => {
  it("keeps every route locked when the explicit API gate is false", async () => {
    const dependencies = dependencySpies();
    const runtime = composeLocalDeliveryV4Runtime({
      environment: {
        ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "false",
        ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
      },
      dependencies,
    });

    expect(runtime.readiness).toMatchObject({ ready: false, reason: "API_DISABLED" });
    await expectLockedResponses(await invokeEveryHandler(runtime.handlers));
    expectNoDependencyCalls(dependencies);
  });

  it.each([undefined, "FALSE", "1", "yes", " true "])(
    "treats missing or invalid gate value %s as disabled",
    (value) => {
      const runtime = composeLocalDeliveryV4Runtime({
        environment: {
          ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: value,
          ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
        },
        dependencies: dependencySpies(),
      });
      expect(runtime.readiness).toMatchObject({ ready: false, reason: "API_DISABLED" });
    },
  );

  it("keeps every route locked outside the explicit STAGING environment", async () => {
    const dependencies = dependencySpies();
    const runtime = composeLocalDeliveryV4Runtime({
      environment: {
        ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "true",
        ORDERPRO_RUNTIME_ENVIRONMENT: "PRODUCTION",
      },
      dependencies,
    });

    expect(runtime.readiness).toMatchObject({
      ready: false,
      reason: "ENVIRONMENT_NOT_STAGING",
    });
    await expectLockedResponses(await invokeEveryHandler(runtime.handlers));
    expectNoDependencyCalls(dependencies);
  });

  it("locks all routes when the gate is true but one dependency is missing", async () => {
    const dependencies = dependencySpies();
    const partialDependencies: Partial<LocalDeliveryV4RuntimeDependencies> = {
      authenticate: dependencies.authenticate,
      evaluateQuote: dependencies.evaluateQuote,
      createHold: dependencies.createHold,
      confirmHold: dependencies.confirmHold,
    };
    const runtime = composeLocalDeliveryV4Runtime({
      environment: {
        ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "true",
        ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
      },
      dependencies: partialDependencies,
    });

    expect(runtime.readiness).toEqual({
      ready: false,
      reason: "DEPENDENCIES_INCOMPLETE",
      missingDependencies: ["releaseHold"],
    });
    await expectLockedResponses(await invokeEveryHandler(runtime.handlers));
    expectNoDependencyCalls(dependencies);
  });

  it("keeps a complete stub bundle locked pending real runtime certification", async () => {
    const dependencies = dependencySpies();
    const runtime = composeLocalDeliveryV4Runtime({
      environment: {
        ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "true",
        ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
      },
      dependencies,
    });

    expect(runtime.readiness).toEqual({
      ready: false,
      reason: "RUNTIME_CERTIFICATION_REQUIRED",
      missingDependencies: [],
    });
    await expectLockedResponses(await invokeEveryHandler(runtime.handlers));
    expectNoDependencyCalls(dependencies);
  });

  it("keeps the exported route handlers locked without an injected runtime bundle", async () => {
    const context = { params: Promise.resolve({ holdId: "capacity-hold-1" }) };
    const responses = await Promise.all([
      quote(request("/api/v1/local-delivery/quote")),
      hold(request("/api/v1/local-delivery/holds")),
      confirm(request("/api/v1/local-delivery/holds/capacity-hold-1/confirm"), context),
      release(request("/api/v1/local-delivery/holds/capacity-hold-1/release"), context),
    ]);
    await expectLockedResponses(responses);
  });
});
