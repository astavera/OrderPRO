import type { MachineAuthenticator } from "./machine-authentication";
import { STAGING_M2M_CLIENT_KEY, STAGING_M2M_SCOPES } from "./staging-authorization-approval-policy";

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function correlationId(request: Request) {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && stableId.test(supplied) ? supplied : crypto.randomUUID();
}

function json(
  request: Request,
  body: Record<string, unknown>,
  status: number,
) {
  const id = correlationId(request);
  return Response.json(
    { ...body, correlationId: id },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Correlation-ID": id,
      },
    },
  );
}

export function createMachineAuthCheckPostHandler(dependencies: {
  authenticate: MachineAuthenticator;
}) {
  return async function POST(request: Request) {
    const authentication = await dependencies.authenticate(request);
    if (!authentication.authenticated) {
      return authentication.code === "M2M_AUTH_NOT_CONFIGURED"
        ? json(
            request,
            {
              result: "FAILED_CLOSED",
              code: "M2M_AUTH_NOT_CONFIGURED",
            },
            503,
          )
        : json(
            request,
            { result: "UNAUTHORIZED", code: "UNAUTHORIZED" },
            401,
          );
    }

    const scopes = [...authentication.principal.scopes].sort();
    if (
      authentication.principal.clientId !== STAGING_M2M_CLIENT_KEY ||
      authentication.principal.environment !== "STAGING" ||
      scopes.length !== STAGING_M2M_SCOPES.length ||
      !STAGING_M2M_SCOPES.every((scope, index) => scopes[index] === scope)
    ) {
      return json(
        request,
        { result: "FORBIDDEN", code: "INSUFFICIENT_SCOPE" },
        403,
      );
    }

    return json(
      request,
      {
        result: "AUTHENTICATED",
        clientId: authentication.principal.clientId,
        environment: authentication.principal.environment,
        scopes,
        localDeliveryApiStatus: "DEPENDENCY_BLOCKED",
      },
      200,
    );
  };
}
