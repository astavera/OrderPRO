import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getCurrentPrincipal, requirePermission } from "@/application/auth/current-principal";
import { prisma } from "@/infrastructure/database/prisma";
import {
  isExactPendingApprovalSnapshot,
  parseStagingCertificationEvidence,
  type CertificationAuditSnapshot,
  type MachineClientApprovalSnapshot,
} from "./staging-authorization-approval-evidence";
import {
  STAGING_M2M_APPROVAL_CONFIRMATION,
  STAGING_M2M_APPROVAL_PROCEDURE,
  STAGING_M2M_CLIENT_KEY,
  STAGING_M2M_ENVIRONMENT,
  STAGING_M2M_PENDING_STATUS,
  activationBlockersAreIntact,
  approvalGuardsAreIntact,
  containsSensitiveEvidence,
  getStagingApprovalEnvironmentReadiness,
  isRecord,
  isSafeStagingApprovalReason,
  isSha256,
  isUuid,
  type ActivationBlockerRow,
  type StagingApprovalDeploymentAttestation,
} from "./staging-authorization-approval-policy";

export type StagingAuthorizationApprovalError =
  | "AUTHENTICATION_REQUIRED"
  | "OWNER_REQUIRED"
  | "INVALID_APPROVAL_INPUT"
  | "APPROVAL_ENVIRONMENT_NOT_READY"
  | "APPROVAL_MIGRATION_NOT_READY"
  | "CERTIFICATION_STALE"
  | "PENDING_APPROVAL_NOT_READY"
  | "ALREADY_APPROVED"
  | "IDEMPOTENCY_CONFLICT"
  | "APPROVAL_WRITE_FAILED";

export type ApproveStagingMachineAuthorizationInput = {
  commandId: string;
  reason: string;
  confirmation: string;
  expectedCertificationAuditEventId: string;
  expectedEvidenceDigestSha256: string;
};

type ApprovalProcedureResult = {
  approvalId: string;
  clientKey: string;
  environment: string;
  decision: string;
  authorizationStatus: string;
  approvalAuditEventId: string;
  approvalCorrelationId: string;
  approvalDigestSha256: string;
};

type ApprovalRow = {
  id: string;
  machineClientId: string;
  environment: string;
  credentialId: string;
  approvedByUserId: string;
  certificationAuditEventId: string;
  approvalAuditEventId: string;
  certificationCorrelationId: string;
  approvalCorrelationId: string;
  certificationEvidenceDigestSha256: string;
  clientVersion: number;
  credentialVersion: number;
  grantVersions: unknown;
  reason: string;
  decision: string;
  approvalSourceCommitSha: string;
  approvalSourceTreeSha: string;
  approvalDigestSha256: string;
  approvedAt: Date;
  approvedByDisplayName: string;
  approvedByEmail: string;
};

type ApprovalContext = {
  actor: {
    id: string;
    active: boolean;
    displayName: string;
    email: string;
    roles: { role: string }[];
  } | null;
  client: MachineClientApprovalSnapshot | null;
  certifications: CertificationAuditSnapshot[];
  certificationCount: number;
  approvals: ApprovalRow[];
  procedure: {
    signature: string | null;
    canExecute: boolean;
    securityDefiner: boolean;
    safeSearchPath: boolean;
    untrustedExecuteRevoked: boolean;
  };
  approvalTablePresent: boolean;
  approvalRlsEnabled: boolean;
  untrustedTableAccessRevoked: boolean;
  activationBlockers: ActivationBlockerRow[];
  approvalGuards: ActivationBlockerRow[];
};

class ApprovalError extends Error {
  constructor(readonly code: StagingAuthorizationApprovalError) {
    super(code);
  }
}

const machineClientSelect = {
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
    orderBy: { createdAt: "asc" as const },
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
    orderBy: { scope: "asc" as const },
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
} satisfies Prisma.MachineClientSelect;

const certificationAuditSelect = {
  id: true,
  actorId: true,
  action: true,
  entityType: true,
  entityId: true,
  correlationId: true,
  before: true,
  after: true,
  occurredAt: true,
} satisfies Prisma.AuditEventSelect;

function fail(code: StagingAuthorizationApprovalError): never {
  throw new ApprovalError(code);
}

async function requireAuthenticatedOwner() {
  const principal = await getCurrentPrincipal();
  if (!principal || principal.accessStatus !== "ACTIVE" || !principal.account) {
    fail("AUTHENTICATION_REQUIRED");
  }
  if (
    !principal.account.active ||
    !principal.account.roles.some(({ role }) => role === "OWNER")
  ) {
    fail("OWNER_REQUIRED");
  }
  return principal.account;
}

async function loadActivationBlockers(transaction: Prisma.TransactionClient) {
  return transaction.$queryRaw<ActivationBlockerRow[]>`
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

async function loadApprovalGuards(transaction: Prisma.TransactionClient) {
  return transaction.$queryRaw<ActivationBlockerRow[]>`
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
        'machine_authorization_approval_no_update',
        'machine_authorization_approval_no_delete',
        'machine_authorization_approval_validate_insert'
      )
    ORDER BY trigger_row.tgname
  `;
}

async function loadApprovalBoundaryMetadata(
  transaction: Prisma.TransactionClient,
) {
  const [procedureRows, tableRows] = await Promise.all([
    transaction.$queryRaw<
      {
        signature: string | null;
        canExecute: boolean;
        securityDefiner: boolean;
        safeSearchPath: boolean;
        untrustedExecuteRevoked: boolean;
      }[]
    >`
      SELECT
        procedure_row.oid::regprocedure::TEXT AS "signature",
        COALESCE(
          has_function_privilege(current_user, procedure_row.oid, 'EXECUTE'),
          FALSE
        ) AS "canExecute",
        COALESCE(procedure_row.prosecdef, FALSE) AS "securityDefiner",
        COALESCE(
          procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::TEXT[],
          FALSE
        ) AS "safeSearchPath",
        COALESCE(NOT EXISTS (
          SELECT 1
          FROM aclexplode(
            COALESCE(
              procedure_row.proacl,
              acldefault('f', procedure_row.proowner)
            )
          ) privilege_row
          LEFT JOIN pg_roles grantee_role
            ON grantee_role.oid = privilege_row.grantee
          WHERE privilege_row.privilege_type = 'EXECUTE'
            AND (
              privilege_row.grantee = 0
              OR grantee_role.rolname IN ('anon', 'authenticated')
            )
        ), FALSE) AS "untrustedExecuteRevoked"
      FROM (SELECT to_regprocedure(${STAGING_M2M_APPROVAL_PROCEDURE}) AS oid) expected
      LEFT JOIN pg_proc procedure_row ON procedure_row.oid = expected.oid
    `,
    transaction.$queryRaw<
      {
        tablePresent: boolean;
        rlsEnabled: boolean;
        untrustedTableAccessRevoked: boolean;
      }[]
    >`
      SELECT
        to_regclass('public."MachineAuthorizationApproval"') IS NOT NULL
          AS "tablePresent",
        COALESCE((
          SELECT table_row.relrowsecurity
          FROM pg_class table_row
          JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          WHERE schema_row.nspname = 'public'
            AND table_row.relname = 'MachineAuthorizationApproval'
        ), FALSE) AS "rlsEnabled",
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM aclexplode(
              COALESCE(
                table_row.relacl,
                acldefault('r', table_row.relowner)
              )
            ) privilege_row
            LEFT JOIN pg_roles grantee_role
              ON grantee_role.oid = privilege_row.grantee
            WHERE privilege_row.grantee = 0
               OR grantee_role.rolname IN ('anon', 'authenticated')
          )
          FROM pg_class table_row
          JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          WHERE schema_row.nspname = 'public'
            AND table_row.relname = 'MachineAuthorizationApproval'
        ), FALSE) AS "untrustedTableAccessRevoked"
    `,
  ]);
  return {
    procedure: procedureRows[0] ?? {
      signature: null,
      canExecute: false,
      securityDefiner: false,
      safeSearchPath: false,
      untrustedExecuteRevoked: false,
    },
    tablePresent: tableRows[0]?.tablePresent === true,
    rlsEnabled: tableRows[0]?.rlsEnabled === true,
    untrustedTableAccessRevoked:
      tableRows[0]?.untrustedTableAccessRevoked === true,
  };
}

async function loadApprovals(
  transaction: Prisma.TransactionClient,
  machineClientId: string,
) {
  return transaction.$queryRaw<ApprovalRow[]>`
    SELECT
      approval."id",
      approval."machineClientId",
      approval."environment"::TEXT AS "environment",
      approval."credentialId",
      approval."approvedByUserId",
      approval."certificationAuditEventId",
      approval."approvalAuditEventId",
      approval."certificationCorrelationId",
      approval."approvalCorrelationId",
      approval."certificationEvidenceDigestSha256",
      approval."clientVersion",
      approval."credentialVersion",
      approval."grantVersions",
      approval."reason",
      approval."decision",
      approval."approvalSourceCommitSha",
      approval."approvalSourceTreeSha",
      approval."approvalDigestSha256",
      approval."approvedAt",
      actor."displayName" AS "approvedByDisplayName",
      actor."email" AS "approvedByEmail"
    FROM "MachineAuthorizationApproval" approval
    JOIN "User" actor ON actor."id" = approval."approvedByUserId"
    WHERE approval."machineClientId" = ${machineClientId}::UUID
      AND approval."environment" = 'STAGING'
    ORDER BY approval."approvedAt" DESC
  `;
}

async function loadApprovalContext(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
): Promise<ApprovalContext> {
  const [actor, client, boundary, activationBlockers, approvalGuards] = await Promise.all([
    transaction.user.findUnique({
      where: { id: actorUserId },
      select: {
        id: true,
        active: true,
        displayName: true,
        email: true,
        roles: { select: { role: true } },
      },
    }),
    transaction.machineClient.findUnique({
      where: { key: STAGING_M2M_CLIENT_KEY },
      select: machineClientSelect,
    }),
    loadApprovalBoundaryMetadata(transaction),
    loadActivationBlockers(transaction),
    loadApprovalGuards(transaction),
  ]);

  if (!client) {
    return {
      actor,
      client: null,
      certifications: [],
      certificationCount: 0,
      approvals: [],
      procedure: boundary.procedure,
      approvalTablePresent: boundary.tablePresent,
      approvalRlsEnabled: boundary.rlsEnabled,
      untrustedTableAccessRevoked: boundary.untrustedTableAccessRevoked,
      activationBlockers,
      approvalGuards,
    };
  }

  const [certifications, certificationCount, approvals] = await Promise.all([
    transaction.auditEvent.findMany({
      where: {
        action: "m2m.client.token_certified",
        entityType: "MachineClient",
        entityId: client.id,
      },
      orderBy: { occurredAt: "desc" },
      take: 2,
      select: certificationAuditSelect,
    }),
    transaction.auditEvent.count({
      where: {
        action: "m2m.client.token_certified",
        entityType: "MachineClient",
        entityId: client.id,
      },
    }),
    boundary.tablePresent ? loadApprovals(transaction, client.id) : Promise.resolve([]),
  ]);

  return {
    actor,
    client,
    certifications,
    certificationCount,
    approvals,
    procedure: boundary.procedure,
    approvalTablePresent: boundary.tablePresent,
    approvalRlsEnabled: boundary.rlsEnabled,
    untrustedTableAccessRevoked: boundary.untrustedTableAccessRevoked,
    activationBlockers,
    approvalGuards,
  };
}

function approvalBoundaryIsReady(context: ApprovalContext) {
  return (
    context.procedure.signature === STAGING_M2M_APPROVAL_PROCEDURE &&
    context.procedure.canExecute &&
    context.procedure.securityDefiner &&
    context.procedure.safeSearchPath &&
    context.procedure.untrustedExecuteRevoked &&
    context.approvalTablePresent &&
    context.approvalRlsEnabled &&
    context.untrustedTableAccessRevoked &&
    activationBlockersAreIntact(context.activationBlockers) &&
    approvalGuardsAreIntact(context.approvalGuards)
  );
}

function safeCertificationSummary(audit: CertificationAuditSnapshot | undefined) {
  if (!audit || !isRecord(audit.after)) return null;
  const digest = audit.after.evidenceDigestSha256;
  const certifiedAt = audit.after.certifiedAt;
  const verifierDigest = audit.after.verifierDigestSha256;
  return {
    auditEventId: audit.id,
    evidenceDigestSha256: isSha256(digest) ? digest : null,
    verifierDigestSha256: isSha256(verifierDigest) ? verifierDigest : null,
    certifiedAt:
      typeof certifiedAt === "string" && !Number.isNaN(Date.parse(certifiedAt))
        ? certifiedAt
        : audit.occurredAt.toISOString(),
  };
}

const readinessMessages: Record<string, string> = {
  UI_GATE_DISABLED:
    "The dedicated STAGING approval UI gate is disabled.",
  NOT_STAGING_RELEASE:
    "Approval is allowed only from a production build deployed as STAGING.",
  RUNTIME_NOT_CLOSED:
    "M2M authentication and the Local Delivery V4 API must both remain disabled.",
  M2M_CONFIGURATION_INVALID:
    "The public Auth0 issuer, audience, JWKS or RS256 configuration is incomplete.",
  RELEASE_PROVENANCE_MISSING:
    "The release commit, tree and certified verifier digest were not attested by deployment.",
  FORBIDDEN_SECRET_PRESENT:
    "A token or Auth0 secret is present in the approval process environment.",
  APPROVAL_MIGRATION_NOT_READY:
    "The executable audited function, RLS, append-only guards or no-activation triggers are incomplete.",
  CLIENT_NOT_READY:
    "The storefront STAGING client is not in the exact pending state.",
  CERTIFICATION_NOT_READY:
    "Exactly one current, intact token certification is required.",
  BUILD_PROVENANCE_MISMATCH:
    "The release verifier digest does not match the certified evidence.",
};

export async function getStagingMachineAuthorizationApprovalPageData() {
  const { account } = await requirePermission("m2m.approve");
  const environment = getStagingApprovalEnvironmentReadiness(process.env);
  const context = await prisma.$transaction(
    (transaction) => loadApprovalContext(transaction, account.id),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const certification = safeCertificationSummary(context.certifications[0]);
  const evidence =
    environment.attestation &&
    certification?.evidenceDigestSha256 &&
    context.certificationCount === 1
      ? parseStagingCertificationEvidence({
          audit: context.certifications[0] ?? null,
          expectedAuditEventId: certification.auditEventId,
          expectedEvidenceDigestSha256: certification.evidenceDigestSha256,
          attestation: environment.attestation,
        })
      : null;
  const pendingSnapshot =
    evidence !== null &&
    isExactPendingApprovalSnapshot({
      actor: context.actor,
      client: context.client,
      evidence,
      issuer: environment.attestation!.issuer,
    });
  const migrationReady = approvalBoundaryIsReady(context);
  const blockerCodes: string[] = [...environment.blockers];
  if (!migrationReady) blockerCodes.push("APPROVAL_MIGRATION_NOT_READY");
  if (!context.client) blockerCodes.push("CLIENT_NOT_READY");
  if (context.certificationCount !== 1 || !certification?.evidenceDigestSha256) {
    blockerCodes.push("CERTIFICATION_NOT_READY");
  } else if (environment.attestation && !evidence) {
    blockerCodes.push("BUILD_PROVENANCE_MISMATCH");
  }
  if (context.client && evidence && !pendingSnapshot) {
    blockerCodes.push("CLIENT_NOT_READY");
  }

  const uniqueBlockerCodes = [...new Set(blockerCodes)];
  const approval = context.approvals[0] ?? null;
  return {
    actor: { displayName: account.displayName, email: account.email },
    client: context.client
      ? {
          key: context.client.key,
          displayName: context.client.displayName,
          environment: context.client.environment,
          status: context.client.status,
          ownerAssigned: context.client.ownerUserId !== null,
          version: context.client.version,
          credential:
            context.client.credentials.length === 1
              ? {
                  provider: context.client.credentials[0].provider,
                  status: context.client.credentials[0].status,
                  version: context.client.credentials[0].version,
                  verifiedAt: context.client.credentials[0].verifiedAt?.toISOString() ?? null,
                }
              : null,
          grants: context.client.grants.map((grant) => ({
            scope: grant.scope,
            status: grant.status,
            version: grant.version,
          })),
        }
      : null,
    certification,
    approval: approval
      ? {
          id: approval.id,
          decision: approval.decision,
          authorizationStatus: context.client?.status ?? STAGING_M2M_PENDING_STATUS,
          approvedAt: approval.approvedAt.toISOString(),
          approvedBy: approval.approvedByDisplayName,
          approvedByEmail: approval.approvedByEmail,
          reason: approval.reason,
          approvalDigestSha256: approval.approvalDigestSha256,
        }
      : null,
    gates: environment.gates,
    activationBlockersIntact: activationBlockersAreIntact(
      context.activationBlockers,
    ),
    approvalBoundaryIntact: migrationReady,
    blockers: uniqueBlockerCodes.map((code) => ({
      code,
      message: readinessMessages[code] ?? "Approval is not ready.",
    })),
    confirmation: STAGING_M2M_APPROVAL_CONFIRMATION,
    canApprove:
      !approval &&
      uniqueBlockerCodes.length === 0 &&
      environment.attestation !== null &&
      pendingSnapshot,
  };
}

function exactProcedureResult(
  row: ApprovalProcedureResult | undefined,
  approvalAuditEventId: string,
  approvalCorrelationId: string,
) {
  return (
    row?.approvalId === approvalAuditEventId &&
    row.clientKey === STAGING_M2M_CLIENT_KEY &&
    row.environment === STAGING_M2M_ENVIRONMENT &&
    row.decision === "APPROVED_PENDING_ACTIVATION" &&
    row.authorizationStatus === STAGING_M2M_PENDING_STATUS &&
    row.approvalAuditEventId === approvalAuditEventId &&
    row.approvalCorrelationId === approvalCorrelationId &&
    isSha256(row.approvalDigestSha256)
  );
}

function exactGrantVersions(
  value: unknown,
  expected: readonly { scope: string; version: number }[],
) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every(
      ({ scope, version }, index) =>
        isRecord(value[index]) &&
        value[index].scope === scope &&
        value[index].version === version,
    )
  );
}

function findExactReplayApproval(input: {
  context: ApprovalContext;
  actorUserId: string;
  request: ApproveStagingMachineAuthorizationInput;
  attestation: StagingApprovalDeploymentAttestation;
}) {
  const { context, actorUserId, request, attestation } = input;
  const approval = context.approvals[0];
  const certification = context.certifications[0];
  if (
    !approval ||
    approval.approvalCorrelationId !== request.commandId ||
    context.certificationCount !== 1 ||
    certification?.id !== request.expectedCertificationAuditEventId
  ) {
    return null;
  }
  const evidence = parseStagingCertificationEvidence({
    audit: certification,
    expectedAuditEventId: request.expectedCertificationAuditEventId,
    expectedEvidenceDigestSha256: request.expectedEvidenceDigestSha256,
    attestation,
  });
  if (
    !evidence ||
    certification.entityId !== evidence.machineClientId ||
    approval.certificationAuditEventId !==
      request.expectedCertificationAuditEventId ||
    approval.certificationEvidenceDigestSha256 !==
      request.expectedEvidenceDigestSha256 ||
    approval.approvedByUserId !== actorUserId ||
    approval.reason !== request.reason ||
    approval.environment !== STAGING_M2M_ENVIRONMENT ||
    approval.decision !== "APPROVED_PENDING_ACTIVATION" ||
    approval.machineClientId !== evidence.machineClientId ||
    approval.credentialId !== evidence.credentialId ||
    approval.clientVersion !== evidence.clientVersion ||
    approval.credentialVersion !== evidence.certifiedCredentialVersion ||
    !exactGrantVersions(approval.grantVersions, evidence.grantVersions) ||
    approval.approvalSourceCommitSha !== attestation.sourceCommitSha ||
    approval.approvalSourceTreeSha !== attestation.sourceTreeSha ||
    !isSha256(approval.approvalDigestSha256) ||
    containsSensitiveEvidence(approval.grantVersions) ||
    !isExactPendingApprovalSnapshot({
      actor: context.actor,
      client: context.client,
      evidence,
      issuer: attestation.issuer,
    })
  ) {
    return null;
  }
  return approval;
}

export async function approveStagingMachineAuthorization(
  input: ApproveStagingMachineAuthorizationInput,
) {
  if (
    !isUuid(input.commandId) ||
    !isUuid(input.expectedCertificationAuditEventId) ||
    !isSha256(input.expectedEvidenceDigestSha256) ||
    input.confirmation !== STAGING_M2M_APPROVAL_CONFIRMATION ||
    !isSafeStagingApprovalReason(input.reason)
  ) {
    fail("INVALID_APPROVAL_INPUT");
  }

  const account = await requireAuthenticatedOwner();
  const environment = getStagingApprovalEnvironmentReadiness(process.env);
  if (!environment.attestation) fail("APPROVAL_ENVIRONMENT_NOT_READY");
  const attestation = environment.attestation;
  const approvalAuditEventId = randomUUID();

  try {
    return await prisma.$transaction(
      async (transaction) => {
        const context = await loadApprovalContext(transaction, account.id);
        if (
          !approvalBoundaryIsReady(context)
        ) {
          fail("APPROVAL_MIGRATION_NOT_READY");
        }
        if (
          !context.actor ||
          !context.actor.active ||
          !context.actor.roles.some(({ role }) => role === "OWNER")
        ) {
          fail("OWNER_REQUIRED");
        }

        const existingApproval = context.approvals[0];
        if (existingApproval) {
          if (existingApproval.approvalCorrelationId !== input.commandId) {
            fail("ALREADY_APPROVED");
          }
          const replay = findExactReplayApproval({
            context,
            actorUserId: account.id,
            request: input,
            attestation,
          });
          if (!replay) fail("IDEMPOTENCY_CONFLICT");
          return {
            result: "APPROVED_PENDING_ACTIVATION" as const,
            replayed: true,
            approvalId: replay.id,
            approvalDigestSha256: replay.approvalDigestSha256,
          };
        }

        if (
          context.certificationCount !== 1 ||
          context.certifications[0]?.id !== input.expectedCertificationAuditEventId
        ) {
          fail("CERTIFICATION_STALE");
        }
        const certificationAudit = context.certifications[0];
        if (certificationAudit.correlationId === input.commandId) {
          fail("INVALID_APPROVAL_INPUT");
        }
        const evidence = parseStagingCertificationEvidence({
          audit: certificationAudit,
          expectedAuditEventId: input.expectedCertificationAuditEventId,
          expectedEvidenceDigestSha256: input.expectedEvidenceDigestSha256,
          attestation,
        });
        if (
          !evidence ||
          certificationAudit.entityId !== evidence.machineClientId ||
          !isExactPendingApprovalSnapshot({
            actor: context.actor,
            client: context.client,
            evidence,
            issuer: attestation.issuer,
          })
        ) {
          fail("PENDING_APPROVAL_NOT_READY");
        }

        const rows = await transaction.$queryRaw<ApprovalProcedureResult[]>`
          SELECT *
          FROM record_staging_machine_authorization_approval(
            ${STAGING_M2M_CLIENT_KEY}::TEXT,
            ${account.id}::UUID,
            ${input.reason}::TEXT,
            ${input.expectedCertificationAuditEventId}::UUID,
            ${input.expectedEvidenceDigestSha256}::TEXT,
            ${attestation.sourceCommitSha}::TEXT,
            ${attestation.sourceTreeSha}::TEXT,
            ${certificationAudit.correlationId}::UUID,
            ${approvalAuditEventId}::UUID,
            ${input.commandId}::UUID
          )
        `;
        if (
          rows.length !== 1 ||
          !exactProcedureResult(rows[0], approvalAuditEventId, input.commandId)
        ) {
          fail("APPROVAL_WRITE_FAILED");
        }

        const [postContext, approvalAudit] = await Promise.all([
          loadApprovalContext(transaction, account.id),
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
        ]);
        const approval = postContext.approvals.find(
          (candidate) => candidate.id === approvalAuditEventId,
        );
        if (
          !approvalAudit ||
          approvalAudit.actorId !== account.id ||
          approvalAudit.action !== "m2m.client.authorization_approved" ||
          approvalAudit.entityType !== "MachineClient" ||
          approvalAudit.entityId !== evidence.machineClientId ||
          approvalAudit.correlationId !== input.commandId ||
          approvalAudit.reason !== input.reason ||
          !approval ||
          approval.machineClientId !== evidence.machineClientId ||
          approval.environment !== STAGING_M2M_ENVIRONMENT ||
          approval.credentialId !== evidence.credentialId ||
          approval.approvedByUserId !== account.id ||
          approval.certificationAuditEventId !== input.expectedCertificationAuditEventId ||
          approval.approvalAuditEventId !== approvalAuditEventId ||
          approval.certificationCorrelationId !== certificationAudit.correlationId ||
          approval.approvalCorrelationId !== input.commandId ||
          approval.clientVersion !== evidence.clientVersion ||
          approval.credentialVersion !== evidence.certifiedCredentialVersion ||
          !exactGrantVersions(approval.grantVersions, evidence.grantVersions) ||
          approval.reason !== input.reason ||
          approval.decision !== "APPROVED_PENDING_ACTIVATION" ||
          approval.approvalSourceCommitSha !== attestation.sourceCommitSha ||
          approval.approvalSourceTreeSha !== attestation.sourceTreeSha ||
          approval.certificationEvidenceDigestSha256 !==
            input.expectedEvidenceDigestSha256 ||
          approval.approvalDigestSha256 !== rows[0].approvalDigestSha256 ||
          !(approval.approvedAt instanceof Date) ||
          containsSensitiveEvidence(approval.grantVersions) ||
          !activationBlockersAreIntact(postContext.activationBlockers) ||
          !approvalBoundaryIsReady(postContext) ||
          !isExactPendingApprovalSnapshot({
            actor: postContext.actor,
            client: postContext.client,
            evidence,
            issuer: attestation.issuer,
          })
        ) {
          fail("APPROVAL_WRITE_FAILED");
        }

        return {
          result: "APPROVED_PENDING_ACTIVATION" as const,
          replayed: false,
          approvalId: approval.id,
          approvalDigestSha256: approval.approvalDigestSha256,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      },
    );
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    try {
      const recovered = await prisma.$transaction(
        async (transaction) => {
          const context = await loadApprovalContext(transaction, account.id);
          if (!approvalBoundaryIsReady(context)) return null;
          return findExactReplayApproval({
            context,
            actorUserId: account.id,
            request: input,
            attestation,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      if (recovered) {
        return {
          result: "APPROVED_PENDING_ACTIVATION" as const,
          replayed: true,
          approvalId: recovered.id,
          approvalDigestSha256: recovered.approvalDigestSha256,
        };
      }
    } catch {
      // Preserve the original fail-closed result when recovery is unavailable.
    }
    fail("APPROVAL_WRITE_FAILED");
  }
}

export function stagingAuthorizationApprovalErrorCode(error: unknown) {
  return error instanceof ApprovalError ? error.code : null;
}
