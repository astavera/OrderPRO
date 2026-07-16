import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  WalkingQuoteEvaluationError,
  type EvaluateWalkingDeliveryQuoteCommand,
  type WalkingQuoteResult,
} from "./evaluate-walking-delivery-quote";

const requiredScopes = ["walking-zones:read", "availability:read"] as const;
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const requestSchema = z.object({
  address: z.string().trim().min(5).max(500),
  serviceAt: z.iso.datetime({ offset: true }),
  subtotalCents: z.number().int().nonnegative(),
}).strict();

export type WalkingQuoteMachinePrincipal = {
  readonly clientId: string;
  readonly environment: "STAGING" | "PRODUCTION";
  readonly scopes: readonly string[];
};

export type WalkingQuoteAuthenticationResult =
  | { readonly authenticated: true; readonly principal: WalkingQuoteMachinePrincipal }
  | {
      readonly authenticated: false;
      readonly status: 401 | 503;
      readonly code: "UNAUTHORIZED" | "M2M_AUTH_NOT_CONFIGURED";
      readonly message: string;
    };

export type WalkingQuoteHttpDependencies = {
  authenticate(request: Request): Promise<WalkingQuoteAuthenticationResult>;
  evaluate(command: EvaluateWalkingDeliveryQuoteCommand): Promise<WalkingQuoteResult>;
};

function requestCorrelationId(request: Request) {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && stableId.test(supplied)
    ? { value: supplied, valid: true as const }
    : { value: randomUUID(), valid: false as const };
}

function jsonError(status: number, code: string, message: string, correlationId: string) {
  return Response.json(
    { code, message, correlationId },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Correlation-ID": correlationId },
    },
  );
}

function statusForEvaluationError(error: WalkingQuoteEvaluationError) {
  if (error.code === "IDEMPOTENCY_CONFLICT") return 409;
  if (
    [
      "INVALID_REQUEST",
      "INVALID_INPUT",
      "INVALID_ADDRESS",
      "GEOCODING_FAILED",
      "AMBIGUOUS_ADDRESS",
      "OUTSIDE_WALKING_ZONE",
      "NO_ACTIVE_ZONE",
      "SERVICE_DAY_UNAVAILABLE",
      "MINIMUM_ORDER_NOT_MET",
    ].includes(error.code)
  ) {
    return 422;
  }
  return 503;
}

export function createWalkingQuotePostHandler(dependencies: WalkingQuoteHttpDependencies) {
  return async function POST(request: Request) {
    const correlation = requestCorrelationId(request);
    const correlationId = correlation.value;
    const authentication = await dependencies.authenticate(request);
    if (!authentication.authenticated) {
      return jsonError(authentication.status, authentication.code, authentication.message, correlationId);
    }

    const grantedScopes = new Set(authentication.principal.scopes);
    if (requiredScopes.some((scope) => !grantedScopes.has(scope))) {
      return jsonError(403, "FORBIDDEN", "The machine credential lacks a required scope.", correlationId);
    }

    if (!correlation.valid) {
      return jsonError(422, "INVALID_CORRELATION_ID", "A valid X-Correlation-ID header is required.", correlationId);
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return jsonError(422, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required.", correlationId);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "INVALID_JSON", "The request body must be valid JSON.", correlationId);
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(422, "INVALID_REQUEST", "The walking quote request is invalid.", correlationId);
    }

    try {
      const result = await dependencies.evaluate({
        clientId: authentication.principal.clientId,
        idempotencyKey,
        correlationId,
        address: parsed.data.address,
        serviceAt: parsed.data.serviceAt,
        subtotalCents: parsed.data.subtotalCents,
        environment: authentication.principal.environment,
      });
      return Response.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Correlation-ID": correlationId },
      });
    } catch (error) {
      if (error instanceof WalkingQuoteEvaluationError) {
        return jsonError(statusForEvaluationError(error), error.code, "The walking quote could not be evaluated.", correlationId);
      }
      throw error;
    }
  };
}
