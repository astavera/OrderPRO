import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workspace = resolve(fileURLToPath(new URL("../", import.meta.url)));
const clientKey = "storefront-staging";
const environment = "STAGING";
const pendingStatus = "PENDING_VERIFICATION";
const scopes = ["local-delivery:holds", "local-delivery:quote"];
const expectedAudience = "https://api.orderpro.internal/local-delivery/staging";
const expectedDisplayName = "OrderPro Storefront STAGING";
const approvalProcedureSignature =
  "record_staging_machine_authorization_approval(text,uuid,text,uuid,text,text,text,uuid,uuid,uuid)";

// This list must remain byte-for-byte aligned with the verifierFiles list used
// by token certification. The boundary test detects drift without modifying the
// already-certified verifier files.
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
];

const forbiddenSecretEnvironmentVariables = [
  "AUTH0_CLIENT_SECRET",
  "AUTH0_M2M_CLIENT_SECRET",
  "ORDERPRO_M2M_CLIENT_SECRET",
  "AUTH0_ACCESS_TOKEN",
  "ORDERPRO_M2M_ACCESS_TOKEN",
  "AUTH0_MANAGEMENT_API_TOKEN",
  "AUTH0_MGMT_API_TOKEN",
  "AUTHORIZATION",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[a-f0-9]{40,64}$/;
const sha256 = /^[a-f0-9]{64}$/;
const externalClientId = /^[A-Za-z0-9_-]{8,120}$/;
const compactJwt = /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/;

class ApprovalError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactGrantVersions(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every(({ scope, version }, index) =>
      isRecord(value[index]) &&
      value[index].scope === scope &&
      value[index].version === version,
    )
  );
}

function containsSensitiveEvidence(value) {
  if (typeof value === "string") {
    return (
      /\bBearer\s+/i.test(value) ||
      /(client[_ -]?secret|access[_ -]?token|authorization\s*:)/i.test(value) ||
      compactJwt.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsSensitiveEvidence);
  if (!isRecord(value)) return false;

  const forbiddenKeys = new Set([
    "accesstoken",
    "authorization",
    "authorizationheader",
    "clientsecret",
    "externalclientid",
    "jti",
    "rawtoken",
  ]);
  return Object.entries(value).some(([key, nested]) =>
    forbiddenKeys.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")) ||
    containsSensitiveEvidence(nested),
  );
}

function sanitizedInput() {
  if (process.argv.slice(2).length !== 0) {
    throw new ApprovalError("APPROVAL_INPUT_INVALID");
  }

  const actorUserId = process.env.ORDERPRO_APPROVAL_ACTOR_USER_ID?.trim() ?? "";
  const reason = process.env.ORDERPRO_APPROVAL_REASON ?? "";
  const certificationAuditEventId =
    process.env.ORDERPRO_APPROVAL_CERTIFICATION_AUDIT_EVENT_ID?.trim() ?? "";
  const evidenceDigestSha256 =
    process.env.ORDERPRO_APPROVAL_EVIDENCE_DIGEST_SHA256?.trim() ?? "";
  const looksSensitive =
    /\bBearer\s+/i.test(reason) ||
    /(client[_ -]?secret|access[_ -]?token|authorization\s*:)/i.test(reason) ||
    compactJwt.test(reason) ||
    /(?:^|\s)[A-Za-z0-9_-]{32,}(?:\s|$)/.test(reason);

  if (
    !uuid.test(actorUserId) ||
    !uuid.test(certificationAuditEventId) ||
    !sha256.test(evidenceDigestSha256) ||
    reason !== reason.trim() ||
    reason.length < 10 ||
    reason.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(reason) ||
    looksSensitive
  ) {
    throw new ApprovalError("APPROVAL_INPUT_INVALID");
  }

  return {
    actorUserId,
    reason,
    certificationAuditEventId,
    evidenceDigestSha256,
  };
}

function publicConfiguration() {
  const issuer = process.env.ORDERPRO_M2M_ISSUER?.trim() ?? "";
  const audience = process.env.ORDERPRO_M2M_AUDIENCE?.trim() ?? "";
  const jwksUri = process.env.ORDERPRO_M2M_JWKS_URI?.trim() ?? "";
  let issuerUrl;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }

  if (
    process.env.NODE_ENV !== "production" ||
    process.env.ORDERPRO_M2M_AUTH_MODE?.trim() !== "DISABLED" ||
    process.env.ORDERPRO_RUNTIME_ENVIRONMENT?.trim() !== environment ||
    process.env.ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED?.trim() !== "false" ||
    process.env.ORDERPRO_M2M_ALLOWED_ALGORITHM?.trim() !== "RS256" ||
    audience !== expectedAudience ||
    issuerUrl.protocol !== "https:" ||
    issuerUrl.username !== "" ||
    issuerUrl.password !== "" ||
    issuerUrl.port !== "" ||
    issuerUrl.pathname !== "/" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    !issuerUrl.hostname.endsWith(".auth0.com") ||
    issuerUrl.href !== issuer ||
    jwksUri !== `${issuer}.well-known/jwks.json` ||
    !process.env.DATABASE_URL?.trim() ||
    forbiddenSecretEnvironmentVariables.some((name) =>
      Boolean(process.env[name]?.trim()),
    )
  ) {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }

  return { issuer, audience };
}

function gitEnvironment() {
  return {
    NODE_ENV: "production",
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function gitExecutable() {
  const executable = process.env.ORDERPRO_APPROVAL_GIT_EXECUTABLE?.trim() ?? "";
  if (
    !isAbsolute(executable) ||
    !["git", "git.exe"].includes(basename(executable).toLowerCase())
  ) {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }
  return executable;
}

async function gitOutput(arguments_) {
  try {
    const { stdout, stderr } = await execFile(gitExecutable(), arguments_, {
      cwd: workspace,
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: 256 * 1_024,
      timeout: 10_000,
      windowsHide: true,
    });
    if (stderr.trim()) throw new Error("Unexpected Git diagnostics.");
    return stdout.trim();
  } catch {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }
}

async function isAncestor(ancestor, descendant) {
  try {
    const { stderr } = await execFile(
      gitExecutable(),
      ["merge-base", "--is-ancestor", ancestor, descendant],
      {
        cwd: workspace,
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: 64 * 1_024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    return !stderr.trim();
  } catch {
    return false;
  }
}

async function workspaceAttestation() {
  const expectedCommit = process.env.ORDERPRO_APPROVAL_EXPECTED_COMMIT?.trim() ?? "";
  const expectedTree = process.env.ORDERPRO_APPROVAL_EXPECTED_TREE?.trim() ?? "";
  if (!sha.test(expectedCommit) || !sha.test(expectedTree)) {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }

  const status = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  const [sourceCommitSha, sourceTreeSha, trackedScript, trackedWrapper] =
    await Promise.all([
      gitOutput(["rev-parse", "--verify", "HEAD"]),
      gitOutput(["rev-parse", "--verify", "HEAD^{tree}"]),
      gitOutput(["ls-files", "--error-unmatch", "scripts/approve-auth0-m2m-staging.mjs"]),
      gitOutput(["ls-files", "--error-unmatch", "scripts/approve-auth0-m2m-staging.ps1"]),
    ]);
  if (
    status ||
    sourceCommitSha !== expectedCommit ||
    sourceTreeSha !== expectedTree ||
    trackedScript !== "scripts/approve-auth0-m2m-staging.mjs" ||
    trackedWrapper !== "scripts/approve-auth0-m2m-staging.ps1"
  ) {
    throw new ApprovalError("UNSAFE_APPROVAL_ENVIRONMENT");
  }
  return { sourceCommitSha, sourceTreeSha };
}

async function verifierDigest() {
  const hash = createHash("sha256");
  for (const relativePath of verifierFiles) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(resolve(workspace, relativePath)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function certificationEvidence(audit, input, config) {
  if (
    !audit ||
    audit.id !== input.certificationAuditEventId ||
    audit.action !== "m2m.client.token_certified" ||
    audit.entityType !== "MachineClient" ||
    audit.actorId !== null ||
    !uuid.test(audit.correlationId) ||
    !isRecord(audit.before) ||
    !isRecord(audit.after)
  ) {
    throw new ApprovalError("CERTIFICATION_EVIDENCE_MISMATCH");
  }

  const evidence = audit.after;
  if (
    evidence.schemaVersion !== "orderpro.m2m-token-certification.v1" ||
    evidence.certificationOutcome !== "VERIFIED_PENDING_APPROVAL" ||
    evidence.runtimeRegistryOutcome !== "UNAUTHORIZED_PENDING" ||
    evidence.clientKey !== clientKey ||
    !uuid.test(evidence.machineClientId) ||
    !uuid.test(evidence.credentialId) ||
    evidence.environment !== environment ||
    evidence.provider !== "AUTH0" ||
    evidence.issuer !== config.issuer ||
    evidence.audience !== config.audience ||
    evidence.allowedAlgorithm !== "RS256" ||
    evidence.tokenProfile !== "RFC9068" ||
    evidence.tokenLifetimeSeconds !== 3_600 ||
    !exactJson(evidence.scopes, scopes) ||
    evidence.clientStatus !== pendingStatus ||
    !Number.isInteger(evidence.clientVersion) ||
    evidence.clientVersion < 1 ||
    evidence.credentialStatus !== pendingStatus ||
    evidence.grantStatus !== pendingStatus ||
    !Array.isArray(evidence.grantVersions) ||
    !Number.isInteger(evidence.previousCredentialVersion) ||
    evidence.previousCredentialVersion < 1 ||
    evidence.certifiedCredentialVersion !== evidence.previousCredentialVersion + 1 ||
    !sha.test(evidence.sourceCommitSha) ||
    !sha.test(evidence.sourceTreeSha) ||
    !sha256.test(evidence.verifierDigestSha256) ||
    evidence.correlationId !== audit.correlationId ||
    evidence.evidenceDigestSha256 !== input.evidenceDigestSha256 ||
    Number.isNaN(Date.parse(evidence.certifiedAt)) ||
    audit.before.clientStatus !== pendingStatus ||
    audit.before.clientVersion !== evidence.clientVersion ||
    audit.before.credentialStatus !== pendingStatus ||
    audit.before.credentialVersion !== evidence.previousCredentialVersion ||
    audit.before.verifiedAt !== null
  ) {
    throw new ApprovalError("CERTIFICATION_EVIDENCE_MISMATCH");
  }

  const expectedGrantVersions = scopes.map((scope) => {
    const grant = evidence.grantVersions.find((candidate) =>
      isRecord(candidate) && candidate.scope === scope,
    );
    if (!grant || !Number.isInteger(grant.version) || grant.version < 1) {
      throw new ApprovalError("CERTIFICATION_EVIDENCE_MISMATCH");
    }
    return { scope, version: grant.version };
  });
  if (
    evidence.grantVersions.length !== scopes.length ||
    !exactGrantVersions(audit.before.grantVersions, expectedGrantVersions)
  ) {
    throw new ApprovalError("CERTIFICATION_EVIDENCE_MISMATCH");
  }

  // PostgreSQL JSONB does not preserve object-key order. Rebuild the evidence
  // in the exact insertion order used by createMachineTokenCertificationEvidence
  // before checking its recorded digest.
  const canonicalEvidence = {
    schemaVersion: evidence.schemaVersion,
    certificationOutcome: evidence.certificationOutcome,
    runtimeRegistryOutcome: evidence.runtimeRegistryOutcome,
    clientKey: evidence.clientKey,
    machineClientId: evidence.machineClientId,
    credentialId: evidence.credentialId,
    environment: evidence.environment,
    provider: evidence.provider,
    issuer: evidence.issuer,
    audience: evidence.audience,
    allowedAlgorithm: evidence.allowedAlgorithm,
    tokenProfile: evidence.tokenProfile,
    tokenLifetimeSeconds: evidence.tokenLifetimeSeconds,
    scopes: evidence.scopes,
    clientStatus: evidence.clientStatus,
    clientVersion: evidence.clientVersion,
    credentialStatus: evidence.credentialStatus,
    grantStatus: evidence.grantStatus,
    grantVersions: expectedGrantVersions,
    previousCredentialVersion: evidence.previousCredentialVersion,
    certifiedCredentialVersion: evidence.certifiedCredentialVersion,
    sourceCommitSha: evidence.sourceCommitSha,
    sourceTreeSha: evidence.sourceTreeSha,
    verifierDigestSha256: evidence.verifierDigestSha256,
    certifiedAt: evidence.certifiedAt,
    correlationId: evidence.correlationId,
  };
  const calculatedDigest = createHash("sha256")
    .update(JSON.stringify(canonicalEvidence), "utf8")
    .digest("hex");
  if (
    calculatedDigest !== evidence.evidenceDigestSha256 ||
    calculatedDigest !== input.evidenceDigestSha256
  ) {
    throw new ApprovalError("CERTIFICATION_EVIDENCE_MISMATCH");
  }

  return { ...evidence, grantVersions: expectedGrantVersions };
}

function exactPendingSnapshot(client, actor, evidence, config) {
  if (
    !actor ||
    actor.id === undefined ||
    actor.active !== true ||
    !Array.isArray(actor.roles) ||
    !actor.roles.some(({ role }) => role === "OWNER") ||
    !client ||
    client.id !== evidence.machineClientId ||
    client.key !== clientKey ||
    client.displayName !== expectedDisplayName ||
    client.environment !== environment ||
    client.status !== pendingStatus ||
    client.ownerUserId !== null ||
    client.version !== evidence.clientVersion ||
    client.activatedAt !== null ||
    client.suspendedAt !== null ||
    client.revokedAt !== null ||
    client.credentials.length !== 1 ||
    client.grants.length !== scopes.length
  ) {
    return false;
  }

  const credential = client.credentials[0];
  if (
    credential.id !== evidence.credentialId ||
    credential.environment !== environment ||
    credential.provider !== "AUTH0" ||
    credential.issuer !== config.issuer ||
    !externalClientId.test(credential.externalClientId) ||
    credential.status !== pendingStatus ||
    credential.version !== evidence.certifiedCredentialVersion ||
    !(credential.verifiedAt instanceof Date) ||
    credential.verifiedAt.toISOString() !== evidence.certifiedAt ||
    credential.activatedAt !== null ||
    credential.suspendedAt !== null ||
    credential.revokedAt !== null
  ) {
    return false;
  }

  return scopes.every((scope, index) => {
    const grant = client.grants[index];
    const evidenceGrant = evidence.grantVersions[index];
    return (
      grant.scope === scope &&
      grant.environment === environment &&
      grant.status === pendingStatus &&
      grant.version === evidenceGrant.version &&
      grant.activatedAt === null &&
      grant.suspendedAt === null &&
      grant.revokedAt === null
    );
  });
}

function exactApprovalResult(row, approvalAuditEventId, approvalCorrelationId) {
  return (
    row &&
    row.approvalId === approvalAuditEventId &&
    row.clientKey === clientKey &&
    row.environment === environment &&
    row.decision === "APPROVED_PENDING_ACTIVATION" &&
    row.authorizationStatus === pendingStatus &&
    row.approvalAuditEventId === approvalAuditEventId &&
    row.approvalCorrelationId === approvalCorrelationId &&
    sha256.test(row.approvalDigestSha256)
  );
}

function activationBlockersAreIntact(rows) {
  const expectedTables = new Map([
    ["machine_client_no_activation", "MachineClient"],
    ["machine_credential_no_activation", "MachineCredential"],
    ["machine_grant_no_activation", "MachineClientGrant"],
  ]);
  return (
    Array.isArray(rows) &&
    rows.length === expectedTables.size &&
    rows.every((row) =>
      expectedTables.get(row.triggerName) === row.tableName &&
      row.schemaName === "public" &&
      row.enabledMode === "O" &&
      row.functionName === "reject_machine_authorization_activation" &&
      row.triggerType === 23,
    )
  );
}

function activationBlockerQuery(transaction) {
  return transaction.$queryRaw`
    SELECT
      trigger_row.tgname AS "triggerName",
      table_row.relname AS "tableName",
      schema_row.nspname AS "schemaName",
      trigger_row.tgenabled::TEXT AS "enabledMode",
      function_row.proname AS "functionName",
      trigger_row.tgtype::INTEGER AS "triggerType"
    FROM pg_trigger trigger_row
    JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
    JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgname IN (
        'machine_client_no_activation',
        'machine_credential_no_activation',
        'machine_grant_no_activation'
      )
    ORDER BY trigger_row.tgname
  `;
}

async function runApproval(input, config, initialWorkspace, initialDigest) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    return await prisma.$transaction(async (transaction) => {
      const procedureRows = await transaction.$queryRaw`
        SELECT to_regprocedure(${approvalProcedureSignature})::TEXT AS "procedure"
      `;
      if (procedureRows.length !== 1 || procedureRows[0]?.procedure !== approvalProcedureSignature) {
        throw new ApprovalError("APPROVAL_MIGRATION_NOT_READY");
      }

      const blockerRows = await activationBlockerQuery(transaction);
      if (!activationBlockersAreIntact(blockerRows)) {
        throw new ApprovalError("APPROVAL_MIGRATION_NOT_READY");
      }

      const [actor, client, certificationAudit] = await Promise.all([
        transaction.user.findUnique({
          where: { id: input.actorUserId },
          select: { id: true, active: true, roles: { select: { role: true } } },
        }),
        transaction.machineClient.findUnique({
          where: { key: clientKey },
          select: {
            id: true,
            key: true,
            displayName: true,
            environment: true,
            status: true,
            ownerUserId: true,
            version: true,
            activatedAt: true,
            suspendedAt: true,
            revokedAt: true,
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
                activatedAt: true,
                suspendedAt: true,
                revokedAt: true,
              },
            },
            grants: {
              orderBy: { scope: "asc" },
              select: {
                environment: true,
                scope: true,
                status: true,
                version: true,
                activatedAt: true,
                suspendedAt: true,
                revokedAt: true,
              },
            },
          },
        }),
        transaction.auditEvent.findUnique({
          where: { id: input.certificationAuditEventId },
          select: {
            id: true,
            actorId: true,
            action: true,
            entityType: true,
            entityId: true,
            correlationId: true,
            before: true,
            after: true,
          },
        }),
      ]);

      const evidence = certificationEvidence(certificationAudit, input, config);
      const certificationCount = await transaction.auditEvent.count({
        where: {
          action: "m2m.client.token_certified",
          entityType: "MachineClient",
          entityId: evidence.machineClientId,
        },
      });
      if (
        certificationCount !== 1 ||
        certificationAudit.entityId !== evidence.machineClientId ||
        !exactPendingSnapshot(client, actor, evidence, config) ||
        evidence.verifierDigestSha256 !== initialDigest ||
        (await gitOutput(["rev-parse", `${evidence.sourceCommitSha}^{tree}`])) !==
          evidence.sourceTreeSha ||
        !(await isAncestor(evidence.sourceCommitSha, initialWorkspace.sourceCommitSha))
      ) {
        throw new ApprovalError("PENDING_APPROVAL_NOT_READY");
      }

      const approvalAuditEventId = randomUUID();
      const approvalCorrelationId = randomUUID();
      const rows = await transaction.$queryRaw`
        SELECT *
        FROM record_staging_machine_authorization_approval(
          ${clientKey}::TEXT,
          ${input.actorUserId}::UUID,
          ${input.reason}::TEXT,
          ${input.certificationAuditEventId}::UUID,
          ${input.evidenceDigestSha256}::TEXT,
          ${initialWorkspace.sourceCommitSha}::TEXT,
          ${initialWorkspace.sourceTreeSha}::TEXT,
          ${certificationAudit.correlationId}::UUID,
          ${approvalAuditEventId}::UUID,
          ${approvalCorrelationId}::UUID
        )
      `;
      if (rows.length !== 1 || !exactApprovalResult(
        rows[0],
        approvalAuditEventId,
        approvalCorrelationId,
      )) {
        throw new ApprovalError("APPROVAL_WRITE_FAILED");
      }

      const [
        postClient,
        approvalAudit,
        approvalRows,
        postBlockerRows,
        finalWorkspace,
        finalDigest,
      ] =
        await Promise.all([
          transaction.machineClient.findUnique({
            where: { key: clientKey },
            select: {
              status: true,
              ownerUserId: true,
              version: true,
              credentials: {
                select: { status: true, version: true, verifiedAt: true },
              },
              grants: {
                orderBy: { scope: "asc" },
                select: { scope: true, status: true, version: true },
              },
            },
          }),
          transaction.auditEvent.findUnique({
            where: { id: approvalAuditEventId },
            select: {
              actorId: true,
              action: true,
              entityType: true,
              entityId: true,
              correlationId: true,
              reason: true,
            },
          }),
          transaction.$queryRaw`
            SELECT
              "id", "machineClientId", "environment", "credentialId",
              "approvedByUserId", "certificationAuditEventId",
              "approvalAuditEventId", "certificationCorrelationId",
              "approvalCorrelationId", "certificationEvidenceDigestSha256",
              "clientVersion", "credentialVersion", "grantVersions",
              "reason", "decision", "approvalSourceCommitSha",
              "approvalSourceTreeSha", "approvalDigestSha256", "approvedAt"
            FROM "MachineAuthorizationApproval"
            WHERE "id" = ${approvalAuditEventId}::UUID
          `,
          activationBlockerQuery(transaction),
          workspaceAttestation(),
          verifierDigest(),
        ]);

      const approval = approvalRows.length === 1 ? approvalRows[0] : null;
      if (
        !postClient ||
        postClient.status !== pendingStatus ||
        postClient.ownerUserId !== null ||
        postClient.version !== evidence.clientVersion ||
        postClient.credentials.length !== 1 ||
        postClient.credentials[0].status !== pendingStatus ||
        postClient.credentials[0].version !== evidence.certifiedCredentialVersion ||
        postClient.credentials[0].verifiedAt?.toISOString() !== evidence.certifiedAt ||
        !exactJson(
          postClient.grants,
          evidence.grantVersions.map(({ scope, version }) => ({
            scope,
            status: pendingStatus,
            version,
          })),
        ) ||
        !approvalAudit ||
        approvalAudit.actorId !== input.actorUserId ||
        approvalAudit.action !== "m2m.client.authorization_approved" ||
        approvalAudit.entityType !== "MachineClient" ||
        approvalAudit.entityId !== evidence.machineClientId ||
        approvalAudit.correlationId !== approvalCorrelationId ||
        approvalAudit.reason !== input.reason ||
        !approval ||
        approval.id !== approvalAuditEventId ||
        approval.machineClientId !== evidence.machineClientId ||
        approval.environment !== environment ||
        approval.credentialId !== evidence.credentialId ||
        approval.approvedByUserId !== input.actorUserId ||
        approval.certificationAuditEventId !== input.certificationAuditEventId ||
        approval.approvalAuditEventId !== approvalAuditEventId ||
        approval.certificationCorrelationId !== certificationAudit.correlationId ||
        approval.approvalCorrelationId !== approvalCorrelationId ||
        approval.clientVersion !== evidence.clientVersion ||
        approval.credentialVersion !== evidence.certifiedCredentialVersion ||
        !exactGrantVersions(approval.grantVersions, evidence.grantVersions) ||
        approval.reason !== input.reason ||
        approval.decision !== "APPROVED_PENDING_ACTIVATION" ||
        approval.approvalSourceCommitSha !== initialWorkspace.sourceCommitSha ||
        approval.approvalSourceTreeSha !== initialWorkspace.sourceTreeSha ||
        approval.certificationEvidenceDigestSha256 !== input.evidenceDigestSha256 ||
        approval.approvalDigestSha256 !== rows[0].approvalDigestSha256 ||
        !(approval.approvedAt instanceof Date) ||
        containsSensitiveEvidence(approval.grantVersions) ||
        !activationBlockersAreIntact(postBlockerRows) ||
        !exactJson(finalWorkspace, initialWorkspace) ||
        finalDigest !== initialDigest
      ) {
        throw new ApprovalError("APPROVAL_WRITE_FAILED");
      }

      return {
        result: "APPROVED_PENDING_ACTIVATION",
        approvalId: rows[0].approvalId,
        clientKey,
        environment,
        authorizationStatus: pendingStatus,
        clientStatus: pendingStatus,
        credentialStatus: pendingStatus,
        grantStatus: pendingStatus,
        m2mAuthMode: "DISABLED",
        localDeliveryV4ApiEnabled: false,
        activationBlockerCount: 3,
        certificationAuditEventId: input.certificationAuditEventId,
        approvalAuditEventId: rows[0].approvalAuditEventId,
        approvalCorrelationId: rows[0].approvalCorrelationId,
        approvalDigestSha256: rows[0].approvalDigestSha256,
        approvalSourceCommitSha: initialWorkspace.sourceCommitSha,
        approvalSourceTreeSha: initialWorkspace.sourceTreeSha,
      };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 60_000 });
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    throw new ApprovalError("APPROVAL_WRITE_FAILED");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const input = sanitizedInput();
  const config = publicConfiguration();
  const [initialWorkspace, initialDigest] = await Promise.all([
    workspaceAttestation(),
    verifierDigest(),
  ]);
  return runApproval(input, config, initialWorkspace, initialDigest);
}

async function executeEntryPoint() {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof ApprovalError
      ? error.code
      : "APPROVAL_WRITE_FAILED";
    process.stderr.write(`${JSON.stringify({ result: "FAILED_CLOSED", code })}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void executeEntryPoint();
}
