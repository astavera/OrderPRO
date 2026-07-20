import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getCurrentPrincipal, requirePermission } from "@/application/auth/current-principal";
import { prisma } from "@/infrastructure/database/prisma";
import {
  isExactPendingApprovalSnapshot,
  parseStagingCertificationEvidence,
  type MachineClientApprovalSnapshot,
} from "./staging-authorization-approval-evidence";
import {
  STAGING_M2M_CLIENT_KEY,
  STAGING_M2M_ENVIRONMENT,
  STAGING_M2M_SCOPES,
  containsSensitiveEvidence,
  isRecord,
  isSafeStagingApprovalReason,
  isSha256,
  isUuid,
  type ActivationBlockerRow,
} from "./staging-authorization-approval-policy";
import {
  STAGING_M2M_ACTIVATION_CONFIRMATION,
  STAGING_M2M_ACTIVATION_PROCEDURE,
  STAGING_M2M_ACTIVATION_RESULT,
  STAGING_M2M_ACTIVE_STATUS,
  activationRecordGuardsAreIntact,
  activationTransitionGuardsAreIntact,
  getStagingActivationEnvironmentReadiness,
  type StagingActivationDeploymentAttestation,
} from "./staging-authorization-activation-policy";

export type StagingAuthorizationActivationError =
  | "AUTHENTICATION_REQUIRED"
  | "OWNER_REQUIRED"
  | "INVALID_ACTIVATION_INPUT"
  | "ACTIVATION_ENVIRONMENT_NOT_READY"
  | "ACTIVATION_MIGRATION_NOT_READY"
  | "APPROVAL_STALE"
  | "PENDING_ACTIVATION_NOT_READY"
  | "ALREADY_ACTIVATED"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTIVATION_WRITE_FAILED";

export type ActivateStagingMachineAuthorizationInput = {
  commandId: string;
  reason: string;
  confirmation: string;
  expectedApprovalId: string;
  expectedApprovalDigestSha256: string;
};

type ActivationProcedureResult = {
  activationId: string;
  approvalId: string;
  clientKey: string;
  environment: string;
  result: string;
  authorizationStatus: string;
  activationAuditEventId: string;
  activationCorrelationId: string;
  activationDigestSha256: string;
  activatedAt: Date;
};

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

const approvalSelect = {
  id: true,
  machineClientId: true,
  environment: true,
  credentialId: true,
  approvedByUserId: true,
  certificationAuditEventId: true,
  certificationCorrelationId: true,
  certificationEvidenceDigestSha256: true,
  clientVersion: true,
  credentialVersion: true,
  grantVersions: true,
  decision: true,
  approvalSourceCommitSha: true,
  approvalSourceTreeSha: true,
  approvalDigestSha256: true,
  approvedAt: true,
  approvedBy: { select: { displayName: true, email: true } },
  certificationAudit: { select: certificationAuditSelect },
} satisfies Prisma.MachineAuthorizationApprovalSelect;

const activationSelect = {
  id: true,
  approvalId: true,
  machineClientId: true,
  environment: true,
  credentialId: true,
  activatedByUserId: true,
  activationAuditEventId: true,
  activationCorrelationId: true,
  approvalDigestSha256: true,
  clientVersionBefore: true,
  credentialVersionBefore: true,
  grantVersionsBefore: true,
  clientVersionAfter: true,
  credentialVersionAfter: true,
  grantVersionsAfter: true,
  reason: true,
  activationSourceCommitSha: true,
  activationSourceTreeSha: true,
  activationDigestSha256: true,
  activatedAt: true,
  activatedBy: { select: { displayName: true, email: true } },
} satisfies Prisma.MachineAuthorizationActivationSelect;

type ApprovalRow = Prisma.MachineAuthorizationApprovalGetPayload<{
  select: typeof approvalSelect;
}>;
type ActivationRow = Prisma.MachineAuthorizationActivationGetPayload<{
  select: typeof activationSelect;
}>;

type ActivationContext = {
  actor: {
    id: string;
    active: boolean;
    displayName: string;
    email: string;
    roles: { role: string }[];
  } | null;
  client: MachineClientApprovalSnapshot | null;
  approvals: ApprovalRow[];
  activations: ActivationRow[];
  boundary: {
    signature: string | null;
    canExecute: boolean;
    securityDefiner: boolean;
    safeSearchPath: boolean;
    untrustedExecuteRevoked: boolean;
    tablePresent: boolean;
    rlsEnabled: boolean;
    untrustedTableAccessRevoked: boolean;
  };
  transitionGuards: ActivationBlockerRow[];
  activationRecordGuards: ActivationBlockerRow[];
};

class ActivationError extends Error {
  constructor(readonly code: StagingAuthorizationActivationError) {
    super(code);
  }
}

function fail(code: StagingAuthorizationActivationError): never {
  throw new ActivationError(code);
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

async function loadTransitionGuards(transaction: Prisma.TransactionClient) {
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

async function loadActivationRecordGuards(transaction: Prisma.TransactionClient) {
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
        'machine_authorization_activation_no_update',
        'machine_authorization_activation_no_delete',
        'machine_authorization_activation_validate_insert'
      )
    ORDER BY trigger_row.tgname
  `;
}

async function loadBoundary(transaction: Prisma.TransactionClient) {
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
        COALESCE(has_function_privilege(current_user, procedure_row.oid, 'EXECUTE'), FALSE)
          AS "canExecute",
        COALESCE(procedure_row.prosecdef, FALSE) AS "securityDefiner",
        COALESCE(
          procedure_row.proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[],
          FALSE
        ) AS "safeSearchPath",
        COALESCE(NOT EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(procedure_row.proacl, acldefault('f', procedure_row.proowner))) privilege_row
          LEFT JOIN pg_roles grantee_role ON grantee_role.oid = privilege_row.grantee
          WHERE privilege_row.privilege_type = 'EXECUTE'
            AND (
              privilege_row.grantee = 0
              OR grantee_role.rolname IN ('anon', 'authenticated')
            )
        ), FALSE) AS "untrustedExecuteRevoked"
      FROM (SELECT to_regprocedure(${STAGING_M2M_ACTIVATION_PROCEDURE}) AS oid) expected
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
        to_regclass('public."MachineAuthorizationActivation"') IS NOT NULL
          AS "tablePresent",
        COALESCE((
          SELECT table_row.relrowsecurity
          FROM pg_class table_row
          JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          WHERE schema_row.nspname = 'public'
            AND table_row.relname = 'MachineAuthorizationActivation'
        ), FALSE) AS "rlsEnabled",
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(table_row.relacl, acldefault('r', table_row.relowner))) privilege_row
            LEFT JOIN pg_roles grantee_role ON grantee_role.oid = privilege_row.grantee
            WHERE privilege_row.grantee = 0
               OR grantee_role.rolname IN ('anon', 'authenticated')
          )
          FROM pg_class table_row
          JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          WHERE schema_row.nspname = 'public'
            AND table_row.relname = 'MachineAuthorizationActivation'
        ), FALSE) AS "untrustedTableAccessRevoked"
    `,
  ]);

  return {
    ...(procedureRows[0] ?? {
      signature: null,
      canExecute: false,
      securityDefiner: false,
      safeSearchPath: false,
      untrustedExecuteRevoked: false,
    }),
    tablePresent: tableRows[0]?.tablePresent === true,
    rlsEnabled: tableRows[0]?.rlsEnabled === true,
    untrustedTableAccessRevoked:
      tableRows[0]?.untrustedTableAccessRevoked === true,
  };
}

async function loadContext(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
): Promise<ActivationContext> {
  const [actor, client, boundary, transitionGuards, activationRecordGuards] = await Promise.all([
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
    loadBoundary(transaction),
    loadTransitionGuards(transaction),
    loadActivationRecordGuards(transaction),
  ]);

  if (!client) {
    return {
      actor,
      client: null,
      approvals: [],
      activations: [],
      boundary,
      transitionGuards,
      activationRecordGuards,
    };
  }

  const [approvals, activations] = await Promise.all([
    transaction.machineAuthorizationApproval.findMany({
      where: { machineClientId: client.id, environment: "STAGING" },
      orderBy: { approvedAt: "desc" },
      select: approvalSelect,
    }),
    boundary.tablePresent
      ? transaction.machineAuthorizationActivation.findMany({
          where: { machineClientId: client.id, environment: "STAGING" },
          orderBy: { activatedAt: "desc" },
          select: activationSelect,
        })
      : Promise.resolve([]),
  ]);

  return {
    actor,
    client,
    approvals,
    activations,
    boundary,
    transitionGuards,
    activationRecordGuards,
  };
}

function boundaryIsReady(context: ActivationContext) {
  return (
    context.boundary.signature === STAGING_M2M_ACTIVATION_PROCEDURE &&
    context.boundary.canExecute &&
    context.boundary.securityDefiner &&
    context.boundary.safeSearchPath &&
    context.boundary.untrustedExecuteRevoked &&
    context.boundary.tablePresent &&
    context.boundary.rlsEnabled &&
    context.boundary.untrustedTableAccessRevoked &&
    activationTransitionGuardsAreIntact(context.transitionGuards) &&
    activationRecordGuardsAreIntact(context.activationRecordGuards)
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

function approvalMatchesCertifiedPendingSnapshot(input: {
  context: ActivationContext;
  approval: ApprovalRow;
  attestation: StagingActivationDeploymentAttestation;
}) {
  const { context, approval, attestation } = input;
  const evidence = parseStagingCertificationEvidence({
    audit: approval.certificationAudit,
    expectedAuditEventId: approval.certificationAuditEventId,
    expectedEvidenceDigestSha256: approval.certificationEvidenceDigestSha256,
    attestation,
  });
  if (!evidence) return false;

  return (
    approval.decision === "APPROVED_PENDING_ACTIVATION" &&
    approval.environment === STAGING_M2M_ENVIRONMENT &&
    approval.machineClientId === evidence.machineClientId &&
    approval.credentialId === evidence.credentialId &&
    approval.clientVersion === evidence.clientVersion &&
    approval.credentialVersion === evidence.certifiedCredentialVersion &&
    approval.certificationCorrelationId === evidence.correlationId &&
    exactGrantVersions(approval.grantVersions, evidence.grantVersions) &&
    isSha256(approval.approvalDigestSha256) &&
    !containsSensitiveEvidence(approval.grantVersions) &&
    isExactPendingApprovalSnapshot({
      actor: context.actor,
      client: context.client,
      evidence,
      issuer: attestation.issuer,
    })
  );
}

function activeSnapshotIsExact(
  context: ActivationContext,
  activation: ActivationRow,
) {
  const client = context.client;
  if (
    !client ||
    client.status !== STAGING_M2M_ACTIVE_STATUS ||
    client.ownerUserId !== null ||
    !client.activatedAt ||
    client.activatedAt.getTime() !== activation.activatedAt.getTime() ||
    client.version !== activation.clientVersionAfter ||
    client.credentials.length !== 1 ||
    client.grants.length !== STAGING_M2M_SCOPES.length
  ) {
    return false;
  }

  const credential = client.credentials[0];
  const grantVersions = activation.grantVersionsAfter;
  if (!Array.isArray(grantVersions)) return false;
  return (
    credential.id === activation.credentialId &&
    credential.status === STAGING_M2M_ACTIVE_STATUS &&
    credential.activatedAt?.getTime() === activation.activatedAt.getTime() &&
    credential.version === activation.credentialVersionAfter &&
    client.grants.every((grant, index) => {
      const recordedGrant = grantVersions[index];
      return (
        grant.scope === STAGING_M2M_SCOPES[index] &&
        grant.status === STAGING_M2M_ACTIVE_STATUS &&
        grant.activatedAt?.getTime() === activation.activatedAt.getTime() &&
        isRecord(recordedGrant) &&
        recordedGrant.scope === grant.scope &&
        recordedGrant.version === grant.version
      );
    })
  );
}

const readinessMessages: Record<string, string> = {
  ACTIVATION_UI_GATE_DISABLED:
    "The dedicated STAGING activation UI gate is disabled.",
  APPROVAL_UI_STILL_ENABLED:
    "Close the approval-only UI before opening the separate activation window.",
  NOT_STAGING_RELEASE:
    "Activation is allowed only from a production build deployed as STAGING.",
  RUNTIME_NOT_CLOSED:
    "Auth0 runtime verification and Local Delivery V4 must remain disabled during registry activation.",
  M2M_CONFIGURATION_INVALID:
    "The canonical Auth0 issuer, audience, JWKS or RS256 configuration is incomplete.",
  RELEASE_PROVENANCE_MISSING:
    "The activation release provenance is incomplete.",
  FORBIDDEN_SECRET_PRESENT:
    "A token or Auth0 secret is present in the activation process environment.",
  ACTIVATION_MIGRATION_NOT_READY:
    "The audited activation RPC, RLS boundary or transition guards are incomplete.",
  APPROVAL_NOT_READY:
    "The immutable approval no longer matches the exact certified pending snapshot.",
};

export async function getStagingMachineAuthorizationActivationPageData() {
  const { account } = await requirePermission("m2m.activate");
  const environment = getStagingActivationEnvironmentReadiness(process.env);
  const context = await prisma.$transaction(
    (transaction) => loadContext(transaction, account.id),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const approval = context.approvals[0] ?? null;
  const activation = context.activations[0] ?? null;
  const exactPendingApproval =
    environment.attestation !== null &&
    context.approvals.length === 1 &&
    approval !== null &&
    approvalMatchesCertifiedPendingSnapshot({
      context,
      approval,
      attestation: environment.attestation,
    });
  const exactActive =
    context.activations.length === 1 &&
    activation !== null &&
    activeSnapshotIsExact(context, activation);
  const migrationReady = boundaryIsReady(context);
  const blockerCodes: string[] = [...environment.blockers];
  if (!migrationReady) blockerCodes.push("ACTIVATION_MIGRATION_NOT_READY");
  if (!activation && !exactPendingApproval) blockerCodes.push("APPROVAL_NOT_READY");

  return {
    actor: { displayName: account.displayName, email: account.email },
    client: context.client
      ? {
          key: context.client.key,
          environment: context.client.environment,
          status: context.client.status,
          version: context.client.version,
          activatedAt: context.client.activatedAt?.toISOString() ?? null,
          credential: context.client.credentials[0]
            ? {
                status: context.client.credentials[0].status,
                version: context.client.credentials[0].version,
                activatedAt:
                  context.client.credentials[0].activatedAt?.toISOString() ?? null,
              }
            : null,
          grants: context.client.grants.map((grant) => ({
            scope: grant.scope,
            status: grant.status,
            version: grant.version,
            activatedAt: grant.activatedAt?.toISOString() ?? null,
          })),
        }
      : null,
    approval: approval
      ? {
          id: approval.id,
          digestSha256: approval.approvalDigestSha256,
          decision: approval.decision,
          approvedAt: approval.approvedAt.toISOString(),
          approvedBy: approval.approvedBy.displayName,
          approvedByEmail: approval.approvedBy.email,
        }
      : null,
    activation: activation
      ? {
          id: activation.id,
          result: exactActive ? STAGING_M2M_ACTIVATION_RESULT : "STATE_MISMATCH",
          activatedAt: activation.activatedAt.toISOString(),
          activatedBy: activation.activatedBy.displayName,
          activatedByEmail: activation.activatedBy.email,
          reason: activation.reason,
          digestSha256: activation.activationDigestSha256,
        }
      : null,
    gates: environment.gates,
    transitionGuardsIntact: activationTransitionGuardsAreIntact(
      context.transitionGuards,
    ),
    activationBoundaryIntact: migrationReady,
    blockers: [...new Set(blockerCodes)].map((code) => ({
      code,
      message: readinessMessages[code] ?? "Activation is not ready.",
    })),
    confirmation: STAGING_M2M_ACTIVATION_CONFIRMATION,
    canActivate:
      !activation &&
      environment.blockers.length === 0 &&
      migrationReady &&
      exactPendingApproval,
  };
}

function exactProcedureResult(
  row: ActivationProcedureResult | undefined,
  request: ActivateStagingMachineAuthorizationInput,
  activationAuditEventId: string,
) {
  return (
    row?.activationId === activationAuditEventId &&
    row.activationAuditEventId === activationAuditEventId &&
    row.approvalId === request.expectedApprovalId &&
    row.clientKey === STAGING_M2M_CLIENT_KEY &&
    row.environment === STAGING_M2M_ENVIRONMENT &&
    row.result === STAGING_M2M_ACTIVATION_RESULT &&
    row.authorizationStatus === STAGING_M2M_ACTIVE_STATUS &&
    row.activationCorrelationId === request.commandId &&
    isSha256(row.activationDigestSha256) &&
    row.activatedAt instanceof Date
  );
}

function exactReplay(input: {
  activation: ActivationRow | undefined;
  actorUserId: string;
  request: ActivateStagingMachineAuthorizationInput;
  attestation: StagingActivationDeploymentAttestation;
}) {
  const { activation, actorUserId, request, attestation } = input;
  return Boolean(
    activation &&
      activation.activationCorrelationId === request.commandId &&
      activation.activationAuditEventId === activation.id &&
      activation.approvalId === request.expectedApprovalId &&
      activation.approvalDigestSha256 === request.expectedApprovalDigestSha256 &&
      activation.activatedByUserId === actorUserId &&
      activation.reason === request.reason &&
      activation.activationSourceCommitSha === attestation.sourceCommitSha &&
      activation.activationSourceTreeSha === attestation.sourceTreeSha &&
      isSha256(activation.activationDigestSha256) &&
      !containsSensitiveEvidence(activation.grantVersionsBefore) &&
      !containsSensitiveEvidence(activation.grantVersionsAfter),
  );
}

export async function activateStagingMachineAuthorization(
  request: ActivateStagingMachineAuthorizationInput,
) {
  const actor = await requireAuthenticatedOwner();
  if (
    !isUuid(request.commandId) ||
    request.confirmation !== STAGING_M2M_ACTIVATION_CONFIRMATION ||
    !isUuid(request.expectedApprovalId) ||
    !isSha256(request.expectedApprovalDigestSha256) ||
    !isSafeStagingApprovalReason(request.reason) ||
    containsSensitiveEvidence(request)
  ) {
    fail("INVALID_ACTIVATION_INPUT");
  }

  const environment = getStagingActivationEnvironmentReadiness(process.env);
  if (environment.blockers.length > 0 || !environment.attestation) {
    fail("ACTIVATION_ENVIRONMENT_NOT_READY");
  }
  const activationAuditEventId = randomUUID();

  try {
    return await prisma.$transaction(
      async (transaction) => {
        const context = await loadContext(transaction, actor.id);
        const existing = context.activations[0];
        if (existing) {
          if (
            context.activations.length === 1 &&
            exactReplay({
              activation: existing,
              actorUserId: actor.id,
              request,
              attestation: environment.attestation!,
            }) &&
            activeSnapshotIsExact(context, existing)
          ) {
            return { replayed: true, activationId: existing.id };
          }
          if (existing.activationCorrelationId === request.commandId) {
            fail("IDEMPOTENCY_CONFLICT");
          }
          fail("ALREADY_ACTIVATED");
        }

        if (!boundaryIsReady(context)) fail("ACTIVATION_MIGRATION_NOT_READY");
        const approval = context.approvals[0];
        if (
          context.approvals.length !== 1 ||
          !approval ||
          approval.id !== request.expectedApprovalId ||
          approval.approvalDigestSha256 !== request.expectedApprovalDigestSha256
        ) {
          fail("APPROVAL_STALE");
        }
        if (
          !approvalMatchesCertifiedPendingSnapshot({
            context,
            approval,
            attestation: environment.attestation!,
          })
        ) {
          fail("PENDING_ACTIVATION_NOT_READY");
        }

        const rows = await transaction.$queryRaw<ActivationProcedureResult[]>`
          SELECT *
          FROM record_staging_machine_authorization_activation(
            ${STAGING_M2M_CLIENT_KEY},
            ${actor.id}::UUID,
            ${request.reason},
            ${request.expectedApprovalId}::UUID,
            ${request.expectedApprovalDigestSha256},
            ${environment.attestation!.sourceCommitSha},
            ${environment.attestation!.sourceTreeSha},
            ${activationAuditEventId}::UUID,
            ${request.commandId}::UUID
          )
        `;
        if (
          rows.length !== 1 ||
          !exactProcedureResult(rows[0], request, activationAuditEventId)
        ) {
          fail("ACTIVATION_WRITE_FAILED");
        }

        const reloaded = await loadContext(transaction, actor.id);
        const stored = reloaded.activations[0];
        if (
          reloaded.activations.length !== 1 ||
          !stored ||
          stored.id !== rows[0].activationId ||
          !activeSnapshotIsExact(reloaded, stored) ||
          !exactReplay({
            activation: stored,
            actorUserId: actor.id,
            request,
            attestation: environment.attestation!,
          })
        ) {
          fail("ACTIVATION_WRITE_FAILED");
        }

        return { replayed: false, activationId: stored.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail("ACTIVATION_WRITE_FAILED");
  }
}

export function stagingAuthorizationActivationErrorCode(error: unknown) {
  return error instanceof ActivationError ? error.code : null;
}
