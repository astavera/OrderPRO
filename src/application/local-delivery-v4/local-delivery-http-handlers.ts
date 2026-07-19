import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LocalDeliveryApplicationError,
  type EvaluateLocalDeliveryQuoteCommand,
  type LocalDeliveryQuoteResult,
} from "./contracts";
import type {
  CapacityHold,
  CapacityHoldResult,
  CreateCapacityHoldCommand,
  TransitionCapacityHoldCommand,
} from "./capacity-holds";
import type {
  MachineAuthenticationResult,
  MachineAuthenticator,
} from "../m2m/machine-authentication";
import type { MachineClientPrincipal } from "../m2m/machine-client-registry";

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const quoteScopes = ["local-delivery:quote"] as const;
const holdScopes = ["local-delivery:holds"] as const;

const quoteRequestSchema = z.object({
  address: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).nullable(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().length(2),
    postalCode: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
    country: z.string().trim().length(2),
  }).strict(),
  cartLines: z.array(z.object({
    variantId: z.string().trim().max(160).regex(stableId),
    quantity: z.number().int().min(1).max(999),
  }).strict()).min(1).max(100),
  requestedDate: z.iso.date(),
}).strict();

const holdRequestSchema = z.object({
  quoteId: z.string().trim().max(160).regex(stableId),
  slotId: z.string().trim().max(160).regex(stableId),
}).strict();

const confirmHoldRequestSchema = z.object({
  orderId: z.string().trim().max(160).regex(stableId),
}).strict();

const releaseHoldRequestSchema = z.object({
  reason: z.enum(["ORDER_CANCELLED", "PAYMENT_FAILED", "MANUAL"]),
}).strict();

export type LocalDeliveryMachinePrincipal = MachineClientPrincipal;

export type LocalDeliveryAuthenticationResult = MachineAuthenticationResult;

type Authenticator = MachineAuthenticator;

const publicAuthenticationMessages = {
  UNAUTHORIZED: "The machine credential is invalid.",
  M2M_AUTH_NOT_CONFIGURED: "Machine authentication is not configured.",
} as const;

function correlation(request: Request) {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && supplied.length <= 120 && stableId.test(supplied)
    ? { id: supplied, valid: true as const }
    : { id: randomUUID(), valid: false as const };
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

function statusFor(error: LocalDeliveryApplicationError) {
  if (error.code === "IDEMPOTENCY_CONFLICT" || error.code === "CAPACITY_HOLD_FAILED") return 409;
  if (error.code === "QUOTE_EXPIRED") return 410;
  if (error.code === "INVENTORY_NOT_READY" || error.code === "TRANSFER_REQUIRED") return 409;
  if (
    error.code === "INVALID_REQUEST" ||
    error.code === "INVALID_ADDRESS" ||
    error.code === "ADDRESS_NOT_IN_MANHATTAN" ||
    error.code === "OUTSIDE_WALKING_AREA"
  ) {
    return 422;
  }
  return 503;
}

async function authorize(
  request: Request,
  authenticate: Authenticator,
  scopes: readonly string[],
): Promise<
  | { readonly ok: false; readonly response: Response }
  | {
      readonly ok: true;
      readonly principal: LocalDeliveryMachinePrincipal;
      readonly correlationId: string;
    }
> {
  const requestCorrelation = correlation(request);
  let authentication: LocalDeliveryAuthenticationResult;
  try {
    authentication = await authenticate(request);
  } catch {
    // Authentication internals may contain bearer tokens, issuer/JWKS details,
    // or upstream errors. None of that crosses this public HTTP boundary.
    return {
      ok: false,
      response: jsonError(
        503,
        "M2M_AUTH_NOT_CONFIGURED",
        publicAuthenticationMessages.M2M_AUTH_NOT_CONFIGURED,
        requestCorrelation.id,
      ),
    } as const;
  }
  if (!authentication.authenticated) {
    return {
      ok: false,
      response: jsonError(
        authentication.code === "UNAUTHORIZED" ? 401 : 503,
        authentication.code,
        publicAuthenticationMessages[authentication.code],
        requestCorrelation.id,
      ),
    } as const;
  }
  const grantedScopes = new Set(authentication.principal.scopes);
  if (scopes.some((scope) => !grantedScopes.has(scope))) {
    return {
      ok: false,
      response: jsonError(
        403,
        "FORBIDDEN",
        "The machine credential lacks a required scope.",
        requestCorrelation.id,
      ),
    } as const;
  }
  if (!requestCorrelation.valid) {
    return {
      ok: false,
      response: jsonError(
        422,
        "INVALID_CORRELATION_ID",
        "A valid X-Correlation-ID header is required.",
        requestCorrelation.id,
      ),
    } as const;
  }
  return {
    ok: true,
    principal: authentication.principal,
    correlationId: requestCorrelation.id,
  } as const;
}

function idempotencyKey(
  request: Request,
  correlationId: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly response: Response } {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  return value.length >= 8 && value.length <= 160
    ? { ok: true, value } as const
    : {
        ok: false,
        response: jsonError(
          422,
          "INVALID_IDEMPOTENCY_KEY",
          "A valid Idempotency-Key header is required.",
          correlationId,
        ),
      } as const;
}

async function requestJson(
  request: Request,
  correlationId: string,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly response: Response }> {
  try {
    return { ok: true, body: await request.json() } as const;
  } catch {
    return {
      ok: false,
      response: jsonError(400, "INVALID_JSON", "The request body must be valid JSON.", correlationId),
    } as const;
  }
}

export function createLocalDeliveryQuotePostHandler(dependencies: {
  readonly authenticate: Authenticator;
  readonly evaluate: (command: EvaluateLocalDeliveryQuoteCommand) => Promise<LocalDeliveryQuoteResult>;
}) {
  return async function POST(request: Request): Promise<Response> {
    const authorized = await authorize(request, dependencies.authenticate, quoteScopes);
    if (!authorized.ok) return authorized.response;
    const idempotency = idempotencyKey(request, authorized.correlationId);
    if (!idempotency.ok) return idempotency.response;
    const json = await requestJson(request, authorized.correlationId);
    if (!json.ok) return json.response;
    const parsed = quoteRequestSchema.safeParse(json.body);
    if (!parsed.success) {
      return jsonError(422, "INVALID_REQUEST", "The local delivery quote request is invalid.", authorized.correlationId);
    }
    try {
      const result = await dependencies.evaluate({
        clientId: authorized.principal.clientId,
        environment: authorized.principal.environment,
        idempotencyKey: idempotency.value,
        correlationId: authorized.correlationId,
        ...parsed.data,
      });
      return Response.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Correlation-ID": authorized.correlationId },
      });
    } catch (error) {
      if (error instanceof LocalDeliveryApplicationError) {
        return jsonError(statusFor(error), error.code, "The local delivery quote could not be evaluated.", authorized.correlationId);
      }
      throw error;
    }
  };
}

export function createCapacityHoldPostHandler(dependencies: {
  readonly authenticate: Authenticator;
  readonly create: (command: CreateCapacityHoldCommand) => Promise<CapacityHoldResult>;
}) {
  return async function POST(request: Request): Promise<Response> {
    const authorized = await authorize(request, dependencies.authenticate, holdScopes);
    if (!authorized.ok) return authorized.response;
    const idempotency = idempotencyKey(request, authorized.correlationId);
    if (!idempotency.ok) return idempotency.response;
    const json = await requestJson(request, authorized.correlationId);
    if (!json.ok) return json.response;
    const parsed = holdRequestSchema.safeParse(json.body);
    if (!parsed.success) {
      return jsonError(422, "INVALID_REQUEST", "The capacity hold request is invalid.", authorized.correlationId);
    }
    try {
      const result = await dependencies.create({
        clientId: authorized.principal.clientId,
        idempotencyKey: idempotency.value,
        correlationId: authorized.correlationId,
        ...parsed.data,
      });
      return Response.json(result, {
        status: result.replayed ? 200 : 201,
        headers: { "Cache-Control": "no-store", "X-Correlation-ID": authorized.correlationId },
      });
    } catch (error) {
      if (error instanceof LocalDeliveryApplicationError) {
        return jsonError(statusFor(error), error.code, "The capacity hold could not be created.", authorized.correlationId);
      }
      throw error;
    }
  };
}

type HoldRouteContext = { readonly params: Promise<{ readonly holdId: string }> };
type HoldTransitionResult = { readonly hold: CapacityHold; readonly changed: boolean };

export function createCapacityHoldTransitionPostHandler(dependencies: {
  readonly authenticate: Authenticator;
  readonly action: "confirm" | "release";
  readonly transition: (command: TransitionCapacityHoldCommand) => Promise<HoldTransitionResult>;
}) {
  return async function POST(request: Request, context: HoldRouteContext): Promise<Response> {
    const authorized = await authorize(request, dependencies.authenticate, holdScopes);
    if (!authorized.ok) return authorized.response;
    const { holdId } = await context.params;
    if (!stableId.test(holdId)) {
      return jsonError(422, "INVALID_REQUEST", "The capacity hold identifier is invalid.", authorized.correlationId);
    }
    const json = await requestJson(request, authorized.correlationId);
    if (!json.ok) return json.response;
    const parsed = dependencies.action === "confirm"
      ? confirmHoldRequestSchema.safeParse(json.body)
      : releaseHoldRequestSchema.safeParse(json.body);
    if (!parsed.success) {
      return jsonError(422, "INVALID_REQUEST", "The capacity hold transition request is invalid.", authorized.correlationId);
    }
    try {
      const common = {
        clientId: authorized.principal.clientId,
        correlationId: authorized.correlationId,
        holdId,
      };
      const command: TransitionCapacityHoldCommand = dependencies.action === "confirm"
        ? { ...common, action: "confirm", orderId: (parsed.data as { orderId: string }).orderId }
        : {
            ...common,
            action: "release",
            reason: (parsed.data as { reason: "ORDER_CANCELLED" | "PAYMENT_FAILED" | "MANUAL" }).reason,
          };
      const result = await dependencies.transition(command);
      return Response.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store", "X-Correlation-ID": authorized.correlationId },
      });
    } catch (error) {
      if (error instanceof LocalDeliveryApplicationError) {
        return jsonError(
          statusFor(error),
          error.code,
          dependencies.action === "confirm"
            ? "The capacity hold could not be confirmed."
            : "The capacity hold could not be released.",
          authorized.correlationId,
        );
      }
      throw error;
    }
  };
}
