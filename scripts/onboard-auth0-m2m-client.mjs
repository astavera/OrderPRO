import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const clientKey = "storefront-staging";
const displayName = "OrderPro Storefront STAGING";
const environment = "STAGING";
const provider = "AUTH0";
const pendingStatus = "PENDING_VERIFICATION";
const scopes = ["local-delivery:quote", "local-delivery:holds"].sort();
const allowedArguments = new Set(["issuer", "client-id"]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function argumentsFrom(commandLine) {
  const parsed = new Map();
  for (const argument of commandLine) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !allowedArguments.has(match[1]) || parsed.has(match[1])) {
      throw new Error("Only one --issuer and one --client-id argument are accepted.");
    }
    parsed.set(match[1], match[2].trim());
  }
  if (parsed.size !== allowedArguments.size) {
    throw new Error("Both --issuer and --client-id are required.");
  }
  return { issuer: parsed.get("issuer"), externalClientId: parsed.get("client-id") };
}

function validateInput(input) {
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(input.externalClientId)) return false;
  try {
    const issuer = new URL(input.issuer);
    return (
      issuer.protocol === "https:" &&
      issuer.pathname === "/" &&
      issuer.search === "" &&
      issuer.hash === "" &&
      issuer.username === "" &&
      issuer.password === "" &&
      issuer.port === "" &&
      issuer.hostname.endsWith(".auth0.com") &&
      issuer.href === input.issuer
    );
  } catch {
    return false;
  }
}

function exactlyPendingRegistration(client, credential) {
  if (
    !client ||
    !credential ||
    client.id !== credential.machineClientId ||
    client.key !== clientKey ||
    client.displayName !== displayName ||
    client.environment !== environment ||
    client.status !== pendingStatus ||
    credential.environment !== environment ||
    credential.provider !== provider ||
    credential.status !== pendingStatus
  ) {
    return false;
  }
  const actualScopes = client.grants
    .filter(
      (grant) =>
        grant.environment === environment && grant.status === pendingStatus,
    )
    .map((grant) => grant.scope)
    .sort();
  return JSON.stringify(actualScopes) === JSON.stringify(scopes);
}

let input;
try {
  input = argumentsFrom(process.argv.slice(2));
  if (!validateInput(input)) throw new Error("The Auth0 onboarding values are invalid.");
} catch (error) {
  fail(error instanceof Error ? error.message : "The onboarding command is invalid.");
}

if (!input) {
  // The validation error above is already safe and actionable.
  process.exit();
}

const prisma = new PrismaClient();

try {
  const result = await prisma.$transaction(async (transaction) => {
    const [existingClient, existingCredential] = await Promise.all([
      transaction.machineClient.findUnique({
        where: { key: clientKey },
        include: { grants: true },
      }),
      transaction.machineCredential.findUnique({
        where: {
          provider_issuer_externalClientId: {
            provider,
            issuer: input.issuer,
            externalClientId: input.externalClientId,
          },
        },
      }),
    ]);

    if (existingClient || existingCredential) {
      if (exactlyPendingRegistration(existingClient, existingCredential)) {
        return { result: "ALREADY_REGISTERED", clientKey, status: pendingStatus };
      }
      throw new Error("The client key or external credential is already registered differently.");
    }

    const client = await transaction.machineClient.create({
      data: {
        key: clientKey,
        displayName,
        environment,
        status: pendingStatus,
        credentials: {
          create: {
            environment,
            provider,
            issuer: input.issuer,
            externalClientId: input.externalClientId,
            status: pendingStatus,
          },
        },
        grants: {
          create: scopes.map((scope) => ({
            environment,
            scope,
            status: pendingStatus,
          })),
        },
      },
      select: { id: true, key: true, status: true },
    });

    const correlationId = randomUUID();
    await transaction.auditEvent.create({
      data: {
        action: "m2m.client.onboarding_staged",
        entityType: "MachineClient",
        entityId: client.id,
        correlationId,
        reason: "Auth0 STAGING client registered pending verification and approval.",
        after: {
          schemaVersion: "orderpro.m2m-client-onboarding.v1",
          clientKey,
          displayName,
          environment,
          status: pendingStatus,
          provider,
          issuer: input.issuer,
          externalClientId: input.externalClientId,
          scopes,
          ownerUserId: null,
        },
      },
    });

    return {
      result: "REGISTERED",
      clientKey,
      status: client.status,
      correlationId,
    };
  });

  console.log(JSON.stringify(result));
} catch {
  fail("M2M onboarding failed closed; no authorization was activated.");
} finally {
  await prisma.$disconnect();
}
