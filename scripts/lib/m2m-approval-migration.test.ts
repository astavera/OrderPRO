import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMachineTokenCertificationEvidence,
  evidenceDigest,
} from "./m2m-token-certification";
import type { Auth0M2mConfiguration } from "../../src/infrastructure/m2m/auth0-config";

const migrationsRoot = new URL("../../prisma/migrations/", import.meta.url);
const db = new PGlite();

const ids = {
  owner: "9a000000-0000-4000-8000-000000000001",
  ownerSubject: "9a000000-0000-4000-8000-000000000002",
  nonOwner: "9a000000-0000-4000-8000-000000000003",
  nonOwnerSubject: "9a000000-0000-4000-8000-000000000004",
  client: "9a000000-0000-4000-8000-000000000005",
  credential: "9a000000-0000-4000-8000-000000000006",
  certificationAudit: "9a000000-0000-4000-8000-000000000007",
  certificationCorrelation: "9a000000-0000-4000-8000-000000000008",
  approvalAudit: "9a000000-0000-4000-8000-000000000009",
  approvalCorrelation: "9a000000-0000-4000-8000-00000000000a",
  duplicateAudit: "9a000000-0000-4000-8000-00000000000b",
  duplicateCorrelation: "9a000000-0000-4000-8000-00000000000c",
  unrelated: "9a000000-0000-4000-8000-00000000000d",
  occupiedAudit: "9a000000-0000-4000-8000-00000000000e",
  occupiedCorrelation: "9a000000-0000-4000-8000-00000000000f",
  directAudit: "9b000000-0000-4000-8000-000000000001",
  directCorrelation: "9b000000-0000-4000-8000-000000000002",
} as const;

const issuer = "https://dev-rfzzpvgkfg1mwf3m.us.auth0.com/";
const audience = "https://api.orderpro.internal/local-delivery/staging";
const certifiedAt = new Date("2026-07-19T12:00:00.000Z");
const certificationCommit = "c".repeat(40);
const certificationTree = "d".repeat(40);
const verifierDigest = "e".repeat(64);
const approvalCommit = "f".repeat(40);
const approvalTree = "a".repeat(40);
const reason = "Owner reviewed the certified STAGING identity and exact grants.";
const scopes = ["local-delivery:holds", "local-delivery:quote"] as const;

const config: Auth0M2mConfiguration = {
  mode: "AUTH0",
  environment: "STAGING",
  issuer,
  audience,
  jwksUri: `${issuer}.well-known/jwks.json`,
  allowedAlgorithm: "RS256",
  tokenProfile: "RFC9068",
};

const pendingSnapshot = {
  machineClientId: ids.client,
  clientKey: "storefront-staging",
  clientVersion: 1,
  clientStatus: "PENDING_VERIFICATION" as const,
  credentialId: ids.credential,
  credentialVersion: 1,
  credentialStatus: "PENDING_VERIFICATION" as const,
  credentialVerifiedAt: null,
  provider: "AUTH0" as const,
  issuer,
  externalClientId: "PGliteClientId1234567890",
  environment: "STAGING" as const,
  grants: scopes.map((scope) => ({
    scope,
    status: "PENDING_VERIFICATION" as const,
    version: 1,
  })),
};

const evidenceWithoutDigest = createMachineTokenCertificationEvidence({
  snapshot: pendingSnapshot,
  config,
  tokenLifetimeSeconds: 3_600,
  sourceCommitSha: certificationCommit,
  sourceTreeSha: certificationTree,
  verifierDigestSha256: verifierDigest,
  certifiedAt,
  correlationId: ids.certificationCorrelation,
});
const certificationEvidenceDigest = evidenceDigest(evidenceWithoutDigest);
const evidence = {
  ...evidenceWithoutDigest,
  evidenceDigestSha256: certificationEvidenceDigest,
};
const certificationBefore = {
  clientStatus: "PENDING_VERIFICATION",
  clientVersion: 1,
  credentialStatus: "PENDING_VERIFICATION",
  grantStatus: "PENDING_VERIFICATION",
  grantVersions: scopes.map((scope) => ({ scope, version: 1 })),
  credentialVersion: 1,
  verifiedAt: null,
};

function json(value: unknown) {
  return JSON.stringify(value).replaceAll("'", "''");
}

async function applyMigrations() {
  const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    const path = join(fileURLToPath(migrationsRoot), migration, "migration.sql");
    await db.exec(await readFile(path, "utf8"));
  }
}

function approvalCall(overrides: {
  actorId?: string;
  certificationAuditId?: string;
  evidenceDigestSha256?: string;
  certificationCorrelationId?: string;
  approvalAuditId?: string;
  approvalCorrelationId?: string;
} = {}) {
  return `
    SELECT *
    FROM record_staging_machine_authorization_approval(
      'storefront-staging'::TEXT,
      '${overrides.actorId ?? ids.owner}'::UUID,
      '${reason}'::TEXT,
      '${overrides.certificationAuditId ?? ids.certificationAudit}'::UUID,
      '${overrides.evidenceDigestSha256 ?? certificationEvidenceDigest}'::TEXT,
      '${approvalCommit}'::TEXT,
      '${approvalTree}'::TEXT,
      '${overrides.certificationCorrelationId ?? ids.certificationCorrelation}'::UUID,
      '${overrides.approvalAuditId ?? ids.approvalAudit}'::UUID,
      '${overrides.approvalCorrelationId ?? ids.approvalCorrelation}'::UUID
    )
  `;
}

async function expectTransactionReject(statements: string) {
  await db.exec("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await expect(db.exec(statements)).rejects.toThrow();
  } finally {
    await db.exec("ROLLBACK");
  }
}

async function executeApproval<T>(statement: string) {
  await db.exec("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await db.query<T>(statement);
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  await db.waitReady;
  await applyMigrations();
  await db.exec(`
    INSERT INTO "User" (
      "id", "subject", "email", "displayName", "active", "version", "updatedAt"
    ) VALUES
      (
        '${ids.owner}', '${ids.ownerSubject}', 'm2m-owner@example.test',
        'M2M Owner', true, 1, CURRENT_TIMESTAMP
      ),
      (
        '${ids.nonOwner}', '${ids.nonOwnerSubject}', 'm2m-auditor@example.test',
        'M2M Auditor', true, 1, CURRENT_TIMESTAMP
      );
    INSERT INTO "UserRole" ("userId", "role") VALUES
      ('${ids.owner}', 'OWNER'),
      ('${ids.nonOwner}', 'AUDITOR');

    INSERT INTO "MachineClient" (
      "id", "key", "displayName", "environment", "status", "version", "updatedAt"
    ) VALUES (
      '${ids.client}', 'storefront-staging', 'OrderPro Storefront STAGING',
      'STAGING', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP
    );
    INSERT INTO "MachineCredential" (
      "id", "machineClientId", "environment", "provider", "issuer",
      "externalClientId", "status", "version", "verifiedAt", "updatedAt"
    ) VALUES (
      '${ids.credential}', '${ids.client}', 'STAGING', 'AUTH0', '${issuer}',
      '${pendingSnapshot.externalClientId}', 'PENDING_VERIFICATION', 2,
      '${certifiedAt.toISOString()}', CURRENT_TIMESTAMP
    );
    INSERT INTO "MachineClientGrant" (
      "machineClientId", "environment", "scope", "status", "version", "updatedAt"
    ) VALUES
      ('${ids.client}', 'STAGING', '${scopes[0]}', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP),
      ('${ids.client}', 'STAGING', '${scopes[1]}', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP);

    INSERT INTO "AuditEvent" (
      "id", "action", "entityType", "entityId", "correlationId", "reason", "before", "after"
    ) VALUES (
      '${ids.certificationAudit}', 'm2m.client.token_certified', 'MachineClient',
      '${ids.client}', '${ids.certificationCorrelation}',
      'PGlite certification evidence; authorization remains pending.',
      '${json(certificationBefore)}'::JSONB, '${json(evidence)}'::JSONB
    );
  `);
});

afterAll(async () => {
  await db.close();
});

describe.sequential("M2M STAGING approval migration", () => {
  it("installs an approval-only RPC and preserves all activation blockers", async () => {
    const result = await executeApproval<{
      procedure: string | null;
      blockerCount: number;
      approvalCount: number;
    }>(`
      SELECT
        to_regprocedure(
          'record_staging_machine_authorization_approval(text,uuid,text,uuid,text,text,text,uuid,uuid,uuid)'
        )::TEXT AS "procedure",
        (
          SELECT COUNT(*)::INTEGER
          FROM pg_trigger trigger_row
          JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
          JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
          WHERE NOT trigger_row.tgisinternal
            AND schema_row.nspname = 'public'
            AND trigger_row.tgenabled = 'O'
            AND trigger_row.tgtype = 23
            AND function_row.proname = 'reject_machine_authorization_activation'
            AND (
              (trigger_row.tgname = 'machine_client_no_activation'
                AND table_row.relname = 'MachineClient')
              OR (trigger_row.tgname = 'machine_credential_no_activation'
                AND table_row.relname = 'MachineCredential')
              OR (trigger_row.tgname = 'machine_grant_no_activation'
                AND table_row.relname = 'MachineClientGrant')
            )
        ) AS "blockerCount",
        (SELECT COUNT(*)::INTEGER FROM "MachineAuthorizationApproval") AS "approvalCount"
    `);

    expect(result.rows[0]).toEqual({
      procedure:
        "record_staging_machine_authorization_approval(text,uuid,text,uuid,text,text,text,uuid,uuid,uuid)",
      blockerCount: 3,
      approvalCount: 0,
    });
  });

  it("fails closed for a non-Owner, inactive Owner, stale snapshot and extra grant", async () => {
    await expectTransactionReject(approvalCall({ actorId: ids.nonOwner }));
    await expectTransactionReject(`
      UPDATE "User" SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${ids.owner}';
      ${approvalCall()};
    `);
    await expectTransactionReject(`
      UPDATE "MachineClient" SET "version" = 2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${ids.client}';
      ${approvalCall()};
    `);
    await expectTransactionReject(`
      INSERT INTO "MachineClientGrant" (
        "machineClientId", "environment", "scope", "status", "version", "updatedAt"
      ) VALUES (
        '${ids.client}', 'STAGING', 'local-delivery:extra',
        'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP
      );
      ${approvalCall()};
    `);
    await expectTransactionReject(`
      UPDATE "MachineClientGrant"
      SET "status" = 'REVOKED', "revokedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "machineClientId" = '${ids.client}'
        AND "scope" = '${scopes[0]}';
      ${approvalCall()};
    `);
  });

  it("fails closed for mismatched certification IDs, correlation and evidence digest", async () => {
    await expectTransactionReject(approvalCall({
      certificationAuditId: ids.unrelated,
    }));
    await expectTransactionReject(approvalCall({
      certificationCorrelationId: ids.unrelated,
    }));
    await expectTransactionReject(approvalCall({
      evidenceDigestSha256: "b".repeat(64),
    }));

    const counts = await db.query<{ approvalCount: number; approvalAuditCount: number }>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM "MachineAuthorizationApproval") AS "approvalCount",
        (
          SELECT COUNT(*)::INTEGER FROM "AuditEvent"
          WHERE "action" = 'm2m.client.authorization_approved'
        ) AS "approvalAuditCount"
    `);
    expect(counts.rows[0]).toEqual({ approvalCount: 0, approvalAuditCount: 0 });
  });

  it("rejects a direct insert whose audit and digest were not produced canonically", async () => {
    await expectTransactionReject(`
      INSERT INTO "AuditEvent" (
        "id", "actorId", "action", "entityType", "entityId",
        "correlationId", "reason", "before", "after"
      ) VALUES (
        '${ids.directAudit}', '${ids.owner}',
        'm2m.client.authorization_approved', 'MachineClient', '${ids.client}',
        '${ids.directCorrelation}', '${reason}', '{}'::JSONB,
        '{"decision":"APPROVED_PENDING_ACTIVATION","approvalDigestSha256":"${"1".repeat(64)}"}'::JSONB
      );
      INSERT INTO "MachineAuthorizationApproval" (
        "id", "machineClientId", "environment", "credentialId", "approvedByUserId",
        "certificationAuditEventId", "approvalAuditEventId",
        "certificationCorrelationId", "approvalCorrelationId",
        "certificationEvidenceDigestSha256", "clientVersion", "credentialVersion",
        "grantVersions", "reason", "decision", "approvalSourceCommitSha",
        "approvalSourceTreeSha", "approvalDigestSha256", "approvedAt"
      ) VALUES (
        '${ids.directAudit}', '${ids.client}', 'STAGING', '${ids.credential}', '${ids.owner}',
        '${ids.certificationAudit}', '${ids.directAudit}',
        '${ids.certificationCorrelation}', '${ids.directCorrelation}',
        '${certificationEvidenceDigest}', 1, 2,
        '${json(scopes.map((scope) => ({ scope, version: 1 })))}'::JSONB,
        '${reason}', 'APPROVED_PENDING_ACTIVATION', '${approvalCommit}',
        '${approvalTree}', '${"1".repeat(64)}', CURRENT_TIMESTAMP
      );
    `);

    const counts = await db.query<{ approvalCount: number; directAuditCount: number }>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM "MachineAuthorizationApproval") AS "approvalCount",
        (SELECT COUNT(*)::INTEGER FROM "AuditEvent" WHERE "id" = '${ids.directAudit}')
          AS "directAuditCount"
    `);
    expect(counts.rows[0]).toEqual({ approvalCount: 0, directAuditCount: 0 });
  });

  it("rolls back the approval row when its audit event cannot be inserted", async () => {
    await db.exec(`
      INSERT INTO "AuditEvent" (
        "id", "action", "entityType", "entityId", "correlationId", "reason"
      ) VALUES (
        '${ids.occupiedAudit}', 'test.fixture', 'TestFixture', '${ids.unrelated}',
        '${ids.occupiedCorrelation}', 'Occupy the audit primary key for rollback testing.'
      )
    `);
    await expectTransactionReject(approvalCall({
      approvalAuditId: ids.occupiedAudit,
      approvalCorrelationId: ids.occupiedCorrelation,
    }));

    const approvals = await db.query<{ count: number }>(`
      SELECT COUNT(*)::INTEGER AS count FROM "MachineAuthorizationApproval"
    `);
    expect(approvals.rows[0]?.count).toBe(0);
  });

  it("records one audited approval atomically without activating any authorization", async () => {
    const result = await db.query<{
      approvalId: string;
      clientKey: string;
      environment: string;
      decision: string;
      authorizationStatus: string;
      approvalAuditEventId: string;
      approvalCorrelationId: string;
      approvalDigestSha256: string;
    }>(approvalCall());

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      approvalId: ids.approvalAudit,
      clientKey: "storefront-staging",
      environment: "STAGING",
      decision: "APPROVED_PENDING_ACTIVATION",
      authorizationStatus: "PENDING_VERIFICATION",
      approvalAuditEventId: ids.approvalAudit,
      approvalCorrelationId: ids.approvalCorrelation,
    });
    expect(result.rows[0]?.approvalDigestSha256).toMatch(/^[a-f0-9]{64}$/);

    const persisted = await db.query<{
      approvalCount: number;
      approvalAuditCount: number;
      clientStatus: string;
      clientOwnerUserId: string | null;
      credentialStatus: string;
      activeGrantCount: number;
      pendingGrantCount: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM "MachineAuthorizationApproval") AS "approvalCount",
        (
          SELECT COUNT(*)::INTEGER FROM "AuditEvent"
          WHERE "id" = '${ids.approvalAudit}'
            AND "action" = 'm2m.client.authorization_approved'
            AND "actorId" = '${ids.owner}'
            AND "entityType" = 'MachineClient'
            AND "entityId" = '${ids.client}'
            AND "correlationId" = '${ids.approvalCorrelation}'
            AND "reason" = '${reason}'
        ) AS "approvalAuditCount",
        client."status"::TEXT AS "clientStatus",
        client."ownerUserId" AS "clientOwnerUserId",
        credential."status"::TEXT AS "credentialStatus",
        COUNT(*) FILTER (WHERE grant_row."status" = 'ACTIVE')::INTEGER AS "activeGrantCount",
        COUNT(*) FILTER (
          WHERE grant_row."status" = 'PENDING_VERIFICATION'
        )::INTEGER AS "pendingGrantCount"
      FROM "MachineClient" client
      JOIN "MachineCredential" credential
        ON credential."machineClientId" = client."id"
      JOIN "MachineClientGrant" grant_row
        ON grant_row."machineClientId" = client."id"
      WHERE client."id" = '${ids.client}'
      GROUP BY client."status", client."ownerUserId", credential."status"
    `);
    expect(persisted.rows[0]).toEqual({
      approvalCount: 1,
      approvalAuditCount: 1,
      clientStatus: "PENDING_VERIFICATION",
      clientOwnerUserId: null,
      credentialStatus: "PENDING_VERIFICATION",
      activeGrantCount: 0,
      pendingGrantCount: 2,
    });
  });

  it("keeps approval history append-only and rejects duplicate approval or activation", async () => {
    await expectTransactionReject(approvalCall({
      approvalAuditId: ids.duplicateAudit,
      approvalCorrelationId: ids.duplicateCorrelation,
    }));
    await expect(db.exec(`
      UPDATE "MachineAuthorizationApproval"
      SET "reason" = 'Rewritten approval reason is forbidden.'
      WHERE "id" = '${ids.approvalAudit}'
    `)).rejects.toThrow("MachineAuthorizationApproval is append-only");
    await expect(db.exec(`
      DELETE FROM "MachineAuthorizationApproval"
      WHERE "id" = '${ids.approvalAudit}'
    `)).rejects.toThrow("MachineAuthorizationApproval is append-only");
    await expect(db.exec(`
      UPDATE "MachineClient"
      SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${ids.client}'
    `)).rejects.toThrow("Machine authorization activation requires a reviewed migration");
    await expect(db.exec(`
      UPDATE "MachineCredential"
      SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${ids.credential}'
    `)).rejects.toThrow("Machine authorization activation requires a reviewed migration");
    await expect(db.exec(`
      UPDATE "MachineClientGrant"
      SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "machineClientId" = '${ids.client}'
    `)).rejects.toThrow("Machine authorization activation requires a reviewed migration");

    const counts = await db.query<{ approvalCount: number; approvalAuditCount: number }>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM "MachineAuthorizationApproval") AS "approvalCount",
        (
          SELECT COUNT(*)::INTEGER FROM "AuditEvent"
          WHERE "action" = 'm2m.client.authorization_approved'
        ) AS "approvalAuditCount"
    `);
    expect(counts.rows[0]).toEqual({ approvalCount: 1, approvalAuditCount: 1 });
  });
});
