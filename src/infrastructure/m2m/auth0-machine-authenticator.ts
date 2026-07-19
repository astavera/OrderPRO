import "server-only";

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type {
  MachineAuthenticationResult,
  MachineAuthenticator,
} from "../../application/m2m/machine-authentication";
import type {
  MachineClientRegistry,
  ResolveMachineClientResult,
} from "../../application/m2m/machine-client-registry";
import type { Auth0M2mConfiguration } from "./auth0-config";

const MAX_AUTHORIZATION_LENGTH = 8_200;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_SCOPE_CLAIM_LENGTH = 2_048;
const MAX_SCOPES = 100;
const MAX_SCOPE_LENGTH = 100;
const MAX_JTI_LENGTH = 200;
const MAX_TOKEN_LIFETIME_SECONDS = 3_600;
const CLOCK_TOLERANCE_SECONDS = 60;

const compactJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const auth0ClientId = /^[A-Za-z0-9_-]{8,120}$/;
const auth0KeyId = /^[A-Za-z0-9_-]{1,200}$/;
const scopeToken = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,99}$/;
const internalClientKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const unauthorized = {
  authenticated: false,
  code: "UNAUTHORIZED",
} as const satisfies MachineAuthenticationResult;

const unavailable = {
  authenticated: false,
  code: "M2M_AUTH_NOT_CONFIGURED",
} as const satisfies MachineAuthenticationResult;

type Auth0AccessTokenClaims = JWTPayload & {
  readonly client_id?: unknown;
  readonly scope?: unknown;
  readonly cnf?: unknown;
  readonly org_id?: unknown;
  readonly org_name?: unknown;
};

type ResolvedMachineClient = Extract<
  ResolveMachineClientResult,
  { readonly resolved: true }
>;

export type Auth0MachineAuthenticatorDependencies = {
  readonly config: Auth0M2mConfiguration;
  readonly registry: MachineClientRegistry;
};

type Auth0MachineAuthenticatorRuntimeDependencies =
  Auth0MachineAuthenticatorDependencies & {
  readonly verificationKey?: JWTVerifyGetKey;
  readonly now?: () => Date;
  };

function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (
    !authorization ||
    authorization.length > MAX_AUTHORIZATION_LENGTH ||
    authorization.includes(",")
  ) {
    return null;
  }

  const match = /^Bearer +([^\s]+)$/i.exec(authorization);
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH || !compactJwt.test(token)) {
    return null;
  }

  return token;
}

function hasStrictAuth0Header(token: string) {
  const header = decodeProtectedHeader(token);

  return (
    header.alg === "RS256" &&
    header.typ === "at+jwt" &&
    typeof header.kid === "string" &&
    auth0KeyId.test(header.kid) &&
    header.jku === undefined &&
    header.jwk === undefined &&
    header.x5u === undefined &&
    header.crit === undefined &&
    header.b64 === undefined
  );
}

function hasExactAudience(value: JWTPayload["aud"], expected: string) {
  return (
    value === expected ||
    (Array.isArray(value) && value.length === 1 && value[0] === expected)
  );
}

function isBoundedVisibleAscii(value: unknown, maximumLength: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character < 0x21 || character > 0x7e) return false;
  }

  return true;
}

function parseScopes(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SCOPE_CLAIM_LENGTH
  ) {
    return null;
  }

  const scopes = value.split(" ");
  if (
    scopes.length < 1 ||
    scopes.length > MAX_SCOPES ||
    scopes.some(
      (scope) =>
        scope.length > MAX_SCOPE_LENGTH ||
        !scopeToken.test(scope),
    ) ||
    new Set(scopes).size !== scopes.length
  ) {
    return null;
  }

  return scopes;
}

function hasValidResolvedPrincipal(
  principal: ResolvedMachineClient,
  tokenScopes: readonly string[],
  expectedEnvironment: Auth0M2mConfiguration["environment"],
) {
  const { clientId, environment, scopes } = principal.principal;
  if (
    !internalClientKey.test(clientId) ||
    environment !== expectedEnvironment ||
    !Array.isArray(scopes) ||
    scopes.length > MAX_SCOPES
  ) {
    return false;
  }

  const tokenScopeSet = new Set(tokenScopes);
  return (
    new Set(scopes).size === scopes.length &&
    scopes.every(
      (scope) =>
        typeof scope === "string" &&
        scopeToken.test(scope) &&
        tokenScopeSet.has(scope),
    )
  );
}

function validateClaims(
  payload: Auth0AccessTokenClaims,
  config: Auth0M2mConfiguration,
  now: Date,
) {
  if (
    typeof payload.client_id !== "string" ||
    !auth0ClientId.test(payload.client_id) ||
    payload.sub !== `${payload.client_id}@clients` ||
    payload.iss !== config.issuer ||
    !hasExactAudience(payload.aud, config.audience) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    !isBoundedVisibleAscii(payload.jti, MAX_JTI_LENGTH) ||
    payload.cnf !== undefined ||
    payload.org_id !== undefined ||
    payload.org_name !== undefined
  ) {
    return null;
  }

  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS ||
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS
  ) {
    return null;
  }

  const scopes = parseScopes(payload.scope);
  if (!scopes) return null;

  return {
    externalClientId: payload.client_id,
    scopes,
  } as const;
}

function isRemoteJwksUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return (
    error instanceof TypeError ||
    code === "ERR_JOSE_GENERIC" ||
    code === "ERR_JWKS_TIMEOUT" ||
    code === "ERR_JWKS_INVALID"
  );
}

function buildAuth0MachineAuthenticator(
  dependencies: Auth0MachineAuthenticatorRuntimeDependencies,
): MachineAuthenticator {
  const { config, registry } = dependencies;
  const usesRemoteJwks = dependencies.verificationKey === undefined;
  const verificationKey =
    dependencies.verificationKey ??
    createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  const now = dependencies.now ?? (() => new Date());

  return async function authenticate(request: Request): Promise<MachineAuthenticationResult> {
    const token = readBearerToken(request);
    if (!token) return unauthorized;

    try {
      if (!hasStrictAuth0Header(token)) return unauthorized;

      const currentDate = now();
      if (Number.isNaN(currentDate.getTime())) return unavailable;

      const { payload } = await jwtVerify<Auth0AccessTokenClaims>(token, verificationKey, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: [config.allowedAlgorithm],
        typ: "at+jwt",
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate,
        requiredClaims: [
          "iss",
          "sub",
          "aud",
          "exp",
          "iat",
          "jti",
          "client_id",
          "scope",
        ],
      });
      const claims = validateClaims(payload, config, currentDate);
      if (!claims) return unauthorized;

      let resolution: ResolveMachineClientResult;
      try {
        resolution = await registry.resolve({
          provider: "AUTH0",
          issuer: config.issuer,
          externalClientId: claims.externalClientId,
          environment: config.environment,
          tokenScopes: claims.scopes,
        });
      } catch {
        return unavailable;
      }

      if (!resolution.resolved) {
        return resolution.reason === "UNAVAILABLE" ? unavailable : unauthorized;
      }

      if (!hasValidResolvedPrincipal(resolution, claims.scopes, config.environment)) {
        return unavailable;
      }

      return {
        authenticated: true,
        principal: {
          clientId: resolution.principal.clientId,
          environment: resolution.principal.environment,
          scopes: [...resolution.principal.scopes],
        },
      };
    } catch (error) {
      if (usesRemoteJwks && isRemoteJwksUnavailable(error)) return unavailable;
      return unauthorized;
    }
  };
}

export function createAuth0MachineAuthenticator(
  dependencies: Auth0MachineAuthenticatorDependencies,
) {
  return buildAuth0MachineAuthenticator(dependencies);
}

/** @internal Test seam. Runtime composition must use createAuth0MachineAuthenticator. */
export function createAuth0MachineAuthenticatorForTesting(
  dependencies: Auth0MachineAuthenticatorDependencies & {
    readonly verificationKey: JWTVerifyGetKey;
    readonly now: () => Date;
  },
) {
  return buildAuth0MachineAuthenticator(dependencies);
}
