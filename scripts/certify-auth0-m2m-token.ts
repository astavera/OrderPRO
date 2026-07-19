import "server-only";

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { decodeJwt } from "jose";
import type {
  MachineClientRegistry,
  ResolveMachineClientInput,
  ResolveMachineClientResult,
} from "../src/application/m2m/machine-client-registry";
import type { Auth0M2mConfiguration } from "../src/infrastructure/m2m/auth0-config";
import {
  CERTIFICATION_CLIENT_KEY,
  CERTIFICATION_SCOPES,
  createMachineTokenCertificationEvidence,
  evidenceDigest,
  isExactPendingCertificationSnapshot,
  type PendingMachineClientSnapshot,
} from "./lib/m2m-token-certification";

const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const execFile = promisify(execFileCallback);
const forbiddenSecretEnvironmentVariables = [
  "AUTH0_CLIENT_SECRET",
  "AUTH0_M2M_CLIENT_SECRET",
  "ORDERPRO_M2M_CLIENT_SECRET",
  "AUTH0_ACCESS_TOKEN",
  "ORDERPRO_M2M_ACCESS_TOKEN",
  "AUTH0_MANAGEMENT_API_TOKEN",
  "AUTH0_MGMT_API_TOKEN",
  "AUTHORIZATION",
] as const;

const verifierFiles = [
  "eslint.config.mjs",
  "package.json",
  "package-lock.json",
  "scripts/certify-auth0-m2m-token.ts",
  "scripts/lib/m2m-token-certification.ts",
  "scripts/prompt-auth0-m2m-token.ps1",
  "src/application/m2m/machine-authentication.ts",
  "src/application/m2m/machine-client-registry.ts",
  "src/infrastructure/m2m/auth0-config.ts",
  "src/infrastructure/m2m/auth0-machine-authenticator.ts",
  "src/infrastructure/m2m/prisma-machine-client-registry.ts",
] as const;

type CertificationErrorCode =
  | "UNSAFE_CERTIFICATION_ENVIRONMENT"
  | "PENDING_REGISTRATION_NOT_READY"
  | "TOKEN_INPUT_INVALID"
  | "TOKEN_VERIFICATION_FAILED"
  | "EVIDENCE_WRITE_FAILED";

class CertificationError extends Error {
  constructor(readonly code: CertificationErrorCode) {
    super(code);
  }
}

let disconnectDatabase: (() => Promise<void>) | undefined;

type MachineClientRecord = {
  readonly id: string;
  readonly key: string;
  readonly environment: "STAGING" | "PRODUCTION";
  readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly version: number;
  readonly credentials: readonly {
    readonly id: string;
    readonly environment: "STAGING" | "PRODUCTION";
    readonly provider: "AUTH0";
    readonly issuer: string;
    readonly externalClientId: string;
    readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
    readonly version: number;
    readonly verifiedAt: Date | null;
  }[];
  readonly grants: readonly {
    readonly scope: string;
    readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "REVOKED";
    readonly version: number;
  }[];
};

type MachineClientReader = {
  readonly machineClient: {
    findUnique(input: unknown): Promise<MachineClientRecord | null>;
  };
};

function hasExactCertificationScopes(scopes: readonly string[]) {
  return (
    scopes.length === CERTIFICATION_SCOPES.length &&
    new Set(scopes).size === CERTIFICATION_SCOPES.length &&
    [...scopes].sort().every(
      (scope, index) => scope === CERTIFICATION_SCOPES[index],
    )
  );
}

function createPendingCertificationRegistry(input: {
  readonly runtimeRegistry: MachineClientRegistry;
  readonly snapshot: PendingMachineClientSnapshot;
  readonly config: Auth0M2mConfiguration;
}) {
  const state = { runtimeRegistryDeniedPending: false };
  const registry: MachineClientRegistry = {
    async resolve(
      resolutionInput: ResolveMachineClientInput,
    ): Promise<ResolveMachineClientResult> {
      const runtimeResult = await input.runtimeRegistry.resolve(resolutionInput);
      if (runtimeResult.resolved || runtimeResult.reason === "UNAVAILABLE") {
        return { resolved: false, reason: "UNAVAILABLE" };
      }

      if (
        !isExactPendingCertificationSnapshot(input.snapshot, input.config) ||
        resolutionInput.provider !== "AUTH0" ||
        resolutionInput.environment !== input.config.environment ||
        resolutionInput.issuer !== input.config.issuer ||
        resolutionInput.externalClientId !== input.snapshot.externalClientId ||
        !hasExactCertificationScopes(resolutionInput.tokenScopes)
      ) {
        return { resolved: false, reason: "NOT_AUTHORIZED" };
      }

      state.runtimeRegistryDeniedPending = true;
      return {
        resolved: true,
        principal: {
          clientId: input.snapshot.clientKey,
          environment: input.snapshot.environment,
          scopes: [...CERTIFICATION_SCOPES],
        },
      };
    },
  };

  return { registry, state } as const;
}

function assertSafeCertificationEnvironment() {
  const gitExecutable =
    process.env.ORDERPRO_CERTIFICATION_GIT_EXECUTABLE?.trim() ?? "";
  const expectedCommit =
    process.env.ORDERPRO_CERTIFICATION_EXPECTED_COMMIT?.trim() ?? "";
  const expectedTree =
    process.env.ORDERPRO_CERTIFICATION_EXPECTED_TREE?.trim() ?? "";
  if (
    process.env.ORDERPRO_M2M_AUTH_MODE?.trim() !== "DISABLED" ||
    process.env.ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED?.trim() !== "false" ||
    !isAbsolute(gitExecutable) ||
    !["git", "git.exe"].includes(basename(gitExecutable).toLowerCase()) ||
    !/^[a-f0-9]{40,64}$/.test(expectedCommit) ||
    !/^[a-f0-9]{40,64}$/.test(expectedTree) ||
    forbiddenSecretEnvironmentVariables.some(
      (variable) => Boolean(process.env[variable]?.trim()),
    )
  ) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }
}

async function configurationForCertification(): Promise<Auth0M2mConfiguration> {
  assertSafeCertificationEnvironment();
  const { parseAuth0M2mConfiguration } = await import(
    "../src/infrastructure/m2m/auth0-config"
  );
  const result = parseAuth0M2mConfiguration({
    ORDERPRO_M2M_AUTH_MODE: "AUTH0",
    ORDERPRO_RUNTIME_ENVIRONMENT: process.env.ORDERPRO_RUNTIME_ENVIRONMENT,
    ORDERPRO_M2M_ISSUER: process.env.ORDERPRO_M2M_ISSUER,
    ORDERPRO_M2M_AUDIENCE: process.env.ORDERPRO_M2M_AUDIENCE,
    ORDERPRO_M2M_JWKS_URI: process.env.ORDERPRO_M2M_JWKS_URI,
    ORDERPRO_M2M_ALLOWED_ALGORITHM:
      process.env.ORDERPRO_M2M_ALLOWED_ALGORITHM,
  });
  if (!result.valid) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }

  return result.config;
}

async function loadSnapshot(
  reader: MachineClientReader,
): Promise<PendingMachineClientSnapshot> {
  const client = await reader.machineClient.findUnique({
    where: { key: CERTIFICATION_CLIENT_KEY },
    select: {
      id: true,
      key: true,
      environment: true,
      status: true,
      version: true,
      credentials: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          environment: true,
          provider: true,
          issuer: true,
          externalClientId: true,
          status: true,
          version: true,
          verifiedAt: true,
        },
      },
      grants: {
        orderBy: { scope: "asc" },
        select: { scope: true, status: true, version: true },
      },
    },
  });

  if (!client || client.credentials.length !== 1) {
    throw new CertificationError("PENDING_REGISTRATION_NOT_READY");
  }
  const credential = client.credentials[0];
  if (
    credential.provider !== "AUTH0" ||
    credential.environment !== client.environment
  ) {
    throw new CertificationError("PENDING_REGISTRATION_NOT_READY");
  }

  return {
    machineClientId: client.id,
    clientKey: client.key,
    clientVersion: client.version,
    clientStatus: client.status,
    credentialId: credential.id,
    credentialVersion: credential.version,
    credentialStatus: credential.status,
    credentialVerifiedAt: credential.verifiedAt,
    provider: credential.provider,
    issuer: credential.issuer,
    externalClientId: credential.externalClientId,
    environment: client.environment,
    grants: client.grants,
  };
}

function sameSnapshot(
  left: PendingMachineClientSnapshot,
  right: PendingMachineClientSnapshot,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function readAccessTokenFromStream(stream: Readable) {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += bytes.byteLength;
    if (byteLength > MAX_ACCESS_TOKEN_LENGTH + 2) {
      throw new CertificationError("TOKEN_INPUT_INVALID");
    }
    chunks.push(bytes);
  }

  const input = Buffer.concat(chunks, byteLength).toString("utf8");

  const token = input.endsWith("\r\n")
    ? input.slice(0, -2)
    : input.endsWith("\n")
      ? input.slice(0, -1)
      : input;
  if (
    token.length < 1 ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new CertificationError("TOKEN_INPUT_INVALID");
  }

  return token;
}

async function verifierDigest(root: string) {
  const hash = createHash("sha256");
  for (const relativePath of verifierFiles) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(resolve(root, relativePath)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

type WorkspaceAttestation = {
  readonly sourceCommitSha: string;
  readonly sourceTreeSha: string;
};

async function gitOutput(root: string, arguments_: readonly string[]) {
  const gitExecutable = process.env.ORDERPRO_CERTIFICATION_GIT_EXECUTABLE?.trim();
  if (!gitExecutable) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }

  try {
    const { stdout, stderr } = await execFile(gitExecutable, arguments_, {
      cwd: root,
      encoding: "utf8",
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 256 * 1_024,
      timeout: 10_000,
      windowsHide: true,
    });
    if (stderr.trim()) {
      throw new Error("Unexpected git diagnostics.");
    }
    return stdout.trim();
  } catch {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }
}

async function workspaceAttestation(root: string): Promise<WorkspaceAttestation> {
  const status = await gitOutput(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }

  const [sourceCommitSha, sourceTreeSha] = await Promise.all([
    gitOutput(root, ["rev-parse", "--verify", "HEAD"]),
    gitOutput(root, ["rev-parse", "--verify", "HEAD^{tree}"]),
  ]);
  if (
    !/^[a-f0-9]{40,64}$/.test(sourceCommitSha) ||
    !/^[a-f0-9]{40,64}$/.test(sourceTreeSha) ||
    sourceCommitSha !== process.env.ORDERPRO_CERTIFICATION_EXPECTED_COMMIT ||
    sourceTreeSha !== process.env.ORDERPRO_CERTIFICATION_EXPECTED_TREE
  ) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }
  return { sourceCommitSha, sourceTreeSha };
}

function sameWorkspaceAttestation(
  left: WorkspaceAttestation,
  right: WorkspaceAttestation,
) {
  return (
    left.sourceCommitSha === right.sourceCommitSha &&
    left.sourceTreeSha === right.sourceTreeSha
  );
}

export function readTokenTiming(token: string) {
  const payload = decodeJwt(token);
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
    throw new CertificationError("TOKEN_VERIFICATION_FAILED");
  }
  const issuedAtEpochSeconds = payload.iat as number;
  const expiresAtEpochSeconds = payload.exp as number;
  const expiresAtMilliseconds = expiresAtEpochSeconds * 1_000;
  if (
    expiresAtEpochSeconds <= issuedAtEpochSeconds ||
    !Number.isSafeInteger(expiresAtMilliseconds)
  ) {
    throw new CertificationError("TOKEN_VERIFICATION_FAILED");
  }
  return {
    lifetimeSeconds: expiresAtEpochSeconds - issuedAtEpochSeconds,
    expiresAtEpochSeconds,
  } as const;
}

async function persistEvidence(input: {
  readonly database: PrismaClient;
  readonly initialSnapshot: PendingMachineClientSnapshot;
  readonly config: Auth0M2mConfiguration;
  readonly tokenLifetimeSeconds: number;
  readonly tokenExpiresAtEpochSeconds: number;
  readonly sourceCommitSha: string;
  readonly sourceTreeSha: string;
  readonly verifierDigestSha256: string;
  readonly correlationId: string;
}) {
  try {
    return await input.database.$transaction(async (transaction) => {
      const currentSnapshot = await loadSnapshot(
        transaction as unknown as MachineClientReader,
      );
      if (
        !sameSnapshot(input.initialSnapshot, currentSnapshot) ||
        !isExactPendingCertificationSnapshot(currentSnapshot, input.config)
      ) {
        throw new CertificationError("EVIDENCE_WRITE_FAILED");
      }

      const priorCertificationCount = await transaction.auditEvent.count({
        where: {
          action: "m2m.client.token_certified",
          entityType: "MachineClient",
          entityId: currentSnapshot.machineClientId,
        },
      });
      if (priorCertificationCount !== 0) {
        throw new CertificationError("EVIDENCE_WRITE_FAILED");
      }

      const clocks = await transaction.$queryRaw<
        readonly { readonly certifiedAt: Date }[]
      >`SELECT clock_timestamp() AS "certifiedAt"`;
      const certifiedAt = clocks[0]?.certifiedAt;
      if (
        !(certifiedAt instanceof Date) ||
        Number.isNaN(certifiedAt.getTime()) ||
        certifiedAt.getTime() >= input.tokenExpiresAtEpochSeconds * 1_000
      ) {
        throw new CertificationError("EVIDENCE_WRITE_FAILED");
      }

      const update = await transaction.machineCredential.updateMany({
        where: {
          id: currentSnapshot.credentialId,
          status: "PENDING_VERIFICATION",
          version: currentSnapshot.credentialVersion,
          verifiedAt: null,
        },
        data: {
          verifiedAt: certifiedAt,
          version: { increment: 1 },
        },
      });
      if (update.count !== 1) {
        throw new CertificationError("EVIDENCE_WRITE_FAILED");
      }

      const evidence = createMachineTokenCertificationEvidence({
        snapshot: currentSnapshot,
        config: input.config,
        tokenLifetimeSeconds: input.tokenLifetimeSeconds,
        sourceCommitSha: input.sourceCommitSha,
        sourceTreeSha: input.sourceTreeSha,
        verifierDigestSha256: input.verifierDigestSha256,
        certifiedAt,
        correlationId: input.correlationId,
      });
      const digest = evidenceDigest(evidence);
      const auditEvent = await transaction.auditEvent.create({
        data: {
          action: "m2m.client.token_certified",
          entityType: "MachineClient",
          entityId: currentSnapshot.machineClientId,
          correlationId: input.correlationId,
          reason: "Auth0 STAGING token certified; authorization remains pending approval.",
          before: {
            clientStatus: "PENDING_VERIFICATION",
            clientVersion: currentSnapshot.clientVersion,
            credentialStatus: "PENDING_VERIFICATION",
            grantStatus: "PENDING_VERIFICATION",
            grantVersions: currentSnapshot.grants.map((grant) => ({
              scope: grant.scope,
              version: grant.version,
            })),
            credentialVersion: currentSnapshot.credentialVersion,
            verifiedAt: null,
          },
          after: { ...evidence, evidenceDigestSha256: digest },
        },
        select: { id: true },
      });

      const postSnapshot = await loadSnapshot(
        transaction as unknown as MachineClientReader,
      );
      const expectedPostSnapshot: PendingMachineClientSnapshot = {
        ...currentSnapshot,
        credentialVersion: currentSnapshot.credentialVersion + 1,
        credentialVerifiedAt: certifiedAt,
      };
      const certificationAuditCount = await transaction.auditEvent.count({
        where: {
          id: auditEvent.id,
          action: "m2m.client.token_certified",
          entityType: "MachineClient",
          entityId: currentSnapshot.machineClientId,
          correlationId: input.correlationId,
        },
      });
      if (
        !sameSnapshot(expectedPostSnapshot, postSnapshot) ||
        certificationAuditCount !== 1
      ) {
        throw new CertificationError("EVIDENCE_WRITE_FAILED");
      }

      return {
        result: "CERTIFIED_PENDING_APPROVAL" as const,
        clientKey: CERTIFICATION_CLIENT_KEY,
        environment: "STAGING" as const,
        status: "PENDING_VERIFICATION" as const,
        audience: input.config.audience,
        scopes: [...CERTIFICATION_SCOPES],
        sourceCommitSha: input.sourceCommitSha,
        correlationId: input.correlationId,
        auditEventId: auditEvent.id,
        evidenceDigestSha256: digest,
      };
    }, { isolationLevel: "Serializable" });
  } catch {
    throw new CertificationError("EVIDENCE_WRITE_FAILED");
  }
}

async function runCertification(token: string) {
  assertSafeCertificationEnvironment();
  const config = await configurationForCertification();
  const root = resolve(process.cwd());
  const [initialWorkspace, initialVerifierDigest] = await Promise.all([
    workspaceAttestation(root),
    verifierDigest(root),
  ]);
  const [
    { createAuth0MachineAuthenticator },
    { prisma },
    { PrismaMachineClientRegistry },
  ] = await Promise.all([
    import("../src/infrastructure/m2m/auth0-machine-authenticator"),
    import("../src/infrastructure/database/prisma"),
    import("../src/infrastructure/m2m/prisma-machine-client-registry"),
  ]);
  disconnectDatabase = () => prisma.$disconnect();
  let initialSnapshot: PendingMachineClientSnapshot;
  try {
    initialSnapshot = await loadSnapshot(prisma as unknown as MachineClientReader);
  } catch {
    throw new CertificationError("PENDING_REGISTRATION_NOT_READY");
  }
  if (!isExactPendingCertificationSnapshot(initialSnapshot, config)) {
    throw new CertificationError("PENDING_REGISTRATION_NOT_READY");
  }

  const runtimeRegistry = new PrismaMachineClientRegistry(
    prisma as unknown as ConstructorParameters<
      typeof PrismaMachineClientRegistry
    >[0],
  );
  const certification = createPendingCertificationRegistry({
    runtimeRegistry,
    snapshot: initialSnapshot,
    config,
  });
  const authenticate = createAuth0MachineAuthenticator({
    config,
    registry: certification.registry,
  });
  const authentication = await authenticate(new Request(
    "https://orderpro.invalid/internal/m2m-certification",
    { headers: { Authorization: `Bearer ${token}` } },
  ));
  if (
    !authentication.authenticated ||
    !certification.state.runtimeRegistryDeniedPending ||
    authentication.principal.clientId !== CERTIFICATION_CLIENT_KEY ||
    JSON.stringify([...authentication.principal.scopes].sort()) !==
      JSON.stringify(CERTIFICATION_SCOPES)
  ) {
    throw new CertificationError("TOKEN_VERIFICATION_FAILED");
  }

  const tokenTiming = readTokenTiming(token);
  if (tokenTiming.lifetimeSeconds !== 3_600) {
    throw new CertificationError("TOKEN_VERIFICATION_FAILED");
  }

  const [finalWorkspace, finalVerifierDigest] = await Promise.all([
    workspaceAttestation(root),
    verifierDigest(root),
  ]);
  if (
    !sameWorkspaceAttestation(initialWorkspace, finalWorkspace) ||
    initialVerifierDigest !== finalVerifierDigest
  ) {
    throw new CertificationError("UNSAFE_CERTIFICATION_ENVIRONMENT");
  }
  return persistEvidence({
    database: prisma,
    initialSnapshot,
    config,
    tokenLifetimeSeconds: tokenTiming.lifetimeSeconds,
    tokenExpiresAtEpochSeconds: tokenTiming.expiresAtEpochSeconds,
    sourceCommitSha: finalWorkspace.sourceCommitSha,
    sourceTreeSha: finalWorkspace.sourceTreeSha,
    verifierDigestSha256: finalVerifierDigest,
    correlationId: randomUUID(),
  });
}

async function main() {
  assertSafeCertificationEnvironment();
  let stdinIsRegularFile: boolean;
  try {
    stdinIsRegularFile = fstatSync(process.stdin.fd).isFile();
  } catch {
    throw new CertificationError("TOKEN_INPUT_INVALID");
  }
  if (
    process.argv.slice(2).length > 0 ||
    process.stdin.isTTY ||
    stdinIsRegularFile
  ) {
    throw new CertificationError("TOKEN_INPUT_INVALID");
  }
  await workspaceAttestation(resolve(process.cwd()));
  const token = await readAccessTokenFromStream(process.stdin);
  return runCertification(token);
}

async function executeEntryPoint() {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof CertificationError
      ? error.code
      : "TOKEN_VERIFICATION_FAILED";
    process.stderr.write(`${JSON.stringify({ result: "FAILED_CLOSED", code })}\n`);
    process.exitCode = 1;
  } finally {
    if (disconnectDatabase) {
      await disconnectDatabase();
    }
  }
}

if (typeof require !== "undefined" && require.main === module) {
  void executeEntryPoint();
}
