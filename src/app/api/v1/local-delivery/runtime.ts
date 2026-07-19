import "server-only";

import { randomUUID } from "node:crypto";
import type {
  createCapacityHoldPostHandler,
  createCapacityHoldTransitionPostHandler,
  createLocalDeliveryQuotePostHandler,
} from "../../../../application/local-delivery-v4/local-delivery-http-handlers";

const apiGateName = "ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED" as const;
const runtimeEnvironmentName = "ORDERPRO_RUNTIME_ENVIRONMENT" as const;
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type QuoteHandlerDependencies = Parameters<typeof createLocalDeliveryQuotePostHandler>[0];
type HoldHandlerDependencies = Parameters<typeof createCapacityHoldPostHandler>[0];
type TransitionHandlerDependencies = Parameters<typeof createCapacityHoldTransitionPostHandler>[0];
type TransitionOperation = TransitionHandlerDependencies["transition"];
type TransitionCommand = Parameters<TransitionOperation>[0];
type TransitionResult = ReturnType<TransitionOperation>;

export type LocalDeliveryV4RuntimeDependencies = {
  readonly authenticate: QuoteHandlerDependencies["authenticate"];
  readonly evaluateQuote: QuoteHandlerDependencies["evaluate"];
  readonly createHold: HoldHandlerDependencies["create"];
  readonly confirmHold: (
    command: Extract<TransitionCommand, { readonly action: "confirm" }>,
  ) => TransitionResult;
  readonly releaseHold: (
    command: Extract<TransitionCommand, { readonly action: "release" }>,
  ) => TransitionResult;
};

type RuntimeDependencyName = keyof LocalDeliveryV4RuntimeDependencies;

export type LocalDeliveryV4RuntimeReadiness =
  {
    readonly ready: false;
    readonly reason:
      | "API_DISABLED"
      | "ENVIRONMENT_NOT_STAGING"
      | "DEPENDENCIES_INCOMPLETE"
      | "RUNTIME_CERTIFICATION_REQUIRED";
    readonly missingDependencies: readonly RuntimeDependencyName[];
  };

export type LocalDeliveryV4RuntimeEnvironment = Readonly<{
  [apiGateName]?: string;
  [runtimeEnvironmentName]?: string;
}>;

const dependencyNames = [
  "authenticate",
  "evaluateQuote",
  "createHold",
  "confirmHold",
  "releaseHold",
] as const satisfies readonly RuntimeDependencyName[];

function missingDependencies(
  dependencies: Partial<LocalDeliveryV4RuntimeDependencies> | undefined,
): readonly RuntimeDependencyName[] {
  return dependencyNames.filter((name) => typeof dependencies?.[name] !== "function");
}

function lockedCorrelationId(request: Request) {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && supplied.length <= 120 && stableId.test(supplied)
    ? supplied
    : randomUUID();
}

function lockedResponse(request: Request) {
  const correlationId = lockedCorrelationId(request);
  return Response.json(
    {
      code: "M2M_AUTH_NOT_CONFIGURED",
      message: "Local delivery V4 is locked until machine authentication and all runtime dependencies are configured.",
      correlationId,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Correlation-ID": correlationId,
      },
    },
  );
}

function lockedTransitionResponse(request: Request, _context?: unknown) {
  void _context;
  return lockedResponse(request);
}

function lockedHandlers() {
  return {
    quote: lockedResponse,
    createHold: lockedResponse,
    confirmHold: lockedTransitionResponse,
    releaseHold: lockedTransitionResponse,
  } as const;
}

function isEnabled(environment: LocalDeliveryV4RuntimeEnvironment) {
  // Only the exact, explicit server value enables composition. Missing, false,
  // differently-cased and otherwise malformed values all remain fail-closed.
  return environment[apiGateName] === "true";
}

function isStaging(environment: LocalDeliveryV4RuntimeEnvironment) {
  return environment[runtimeEnvironmentName] === "STAGING";
}

export function composeLocalDeliveryV4Runtime(input: {
  readonly environment: LocalDeliveryV4RuntimeEnvironment;
  readonly dependencies?: Partial<LocalDeliveryV4RuntimeDependencies>;
}) {
  const missing = missingDependencies(input.dependencies);
  if (!isEnabled(input.environment)) {
    return {
      readiness: {
        ready: false,
        reason: "API_DISABLED",
        missingDependencies: missing,
      },
      handlers: lockedHandlers(),
    } as const;
  }

  if (!isStaging(input.environment)) {
    return {
      readiness: {
        ready: false,
        reason: "ENVIRONMENT_NOT_STAGING",
        missingDependencies: missing,
      },
      handlers: lockedHandlers(),
    } as const;
  }

  if (missing.length > 0) {
    return {
      readiness: {
        ready: false,
        reason: "DEPENDENCIES_INCOMPLETE",
        missingDependencies: missing,
      },
      handlers: lockedHandlers(),
    } as const;
  }

  // Deliberately no generic attestation input and no READY branch exist here.
  // A future, non-exported composition root must verify the real M2M issuer and
  // client registry, geocoder, policy, zone, router, inventory, slots, durable
  // quote/hold stores, order-location resolver, allocation strategy and expiry
  // worker before it can introduce an activatable runtime.
  return {
    readiness: {
      ready: false,
      reason: "RUNTIME_CERTIFICATION_REQUIRED",
      missingDependencies: missing,
    },
    handlers: lockedHandlers(),
  } as const;
}

// No dependency bundle is resolved implicitly. A future, reviewed server
// composition root must inject the complete bundle before this can be ready.
export const localDeliveryV4Runtime = composeLocalDeliveryV4Runtime({
  environment: {
    [apiGateName]: process.env[apiGateName],
    [runtimeEnvironmentName]: process.env[runtimeEnvironmentName],
  },
});
