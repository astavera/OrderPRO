import "server-only";

import type {
  MachineClientRegistry,
  ResolveMachineClientInput,
  ResolveMachineClientResult,
} from "../../application/m2m/machine-client-registry";
import { prisma } from "../database/prisma";

const stableClientKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const externalClientId = /^[A-Za-z0-9_-]{8,120}$/;
const notAuthorized = { resolved: false, reason: "NOT_AUTHORIZED" } as const;
const unavailable = { resolved: false, reason: "UNAVAILABLE" } as const;

type MachineCredentialRecord = {
  readonly environment: "STAGING" | "PRODUCTION";
  readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly client: {
    readonly key: string;
    readonly environment: "STAGING" | "PRODUCTION";
    readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
    readonly grants: readonly {
      readonly environment: "STAGING" | "PRODUCTION";
      readonly scope: string;
    }[];
  };
};

type MachineRegistryPrismaClient = {
  readonly machineCredential: {
    findUnique(input: unknown): Promise<MachineCredentialRecord | null>;
  };
};

function validInput(input: ResolveMachineClientInput) {
  if (
    input.provider !== "AUTH0" ||
    !input.issuer ||
    input.issuer.length > 255 ||
    !externalClientId.test(input.externalClientId) ||
    (input.environment !== "STAGING" && input.environment !== "PRODUCTION") ||
    input.tokenScopes.length > 100
  ) {
    return false;
  }

  try {
    const issuer = new URL(input.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      issuer.port ||
      !issuer.hostname.endsWith(".auth0.com") ||
      issuer.href !== input.issuer
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return input.tokenScopes.every(
    (scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 100,
  );
}

export class PrismaMachineClientRegistry implements MachineClientRegistry {
  constructor(
    private readonly client: MachineRegistryPrismaClient =
      prisma as unknown as MachineRegistryPrismaClient,
  ) {}

  async resolve(input: ResolveMachineClientInput): Promise<ResolveMachineClientResult> {
    if (!validInput(input)) return notAuthorized;

    try {
      const credential = await this.client.machineCredential.findUnique({
        where: {
          provider_issuer_externalClientId: {
            provider: input.provider,
            issuer: input.issuer,
            externalClientId: input.externalClientId,
          },
        },
        select: {
          environment: true,
          status: true,
          client: {
            select: {
              key: true,
              environment: true,
              status: true,
              grants: {
                where: { status: "ACTIVE" },
                orderBy: { scope: "asc" },
                select: { environment: true, scope: true },
              },
            },
          },
        },
      });

      if (
        !credential ||
        credential.status !== "ACTIVE" ||
        credential.environment !== input.environment ||
        credential.client.status !== "ACTIVE" ||
        credential.client.environment !== input.environment ||
        !stableClientKey.test(credential.client.key) ||
        credential.client.grants.some((grant) => grant.environment !== input.environment)
      ) {
        return notAuthorized;
      }

      const registeredScopes = new Set(
        credential.client.grants.map((grant) => grant.scope),
      );
      const scopes = [...new Set(input.tokenScopes)]
        .filter((scope) => registeredScopes.has(scope))
        .sort();

      return {
        resolved: true,
        principal: {
          clientId: credential.client.key,
          environment: credential.client.environment,
          scopes,
        },
      };
    } catch {
      return unavailable;
    }
  }
}
