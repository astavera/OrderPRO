import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const migrationSqlByName = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(label, operation, expectedMessage) {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(
        `${label}: expected rejection containing ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(message)}`,
        { cause: error },
      );
    }
    console.log(`PASS ${label}: ${expectedMessage}`);
    return;
  }
  throw new Error(`${label}: expected the operation to be rejected`);
}

async function expectTransactionReject(label, statements, expectedMessage) {
  try {
    await db.exec(`BEGIN;\n${statements}\nCOMMIT;`);
  } catch (error) {
    await db.exec("ROLLBACK;");
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(
        `${label}: expected rejection containing ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(message)}`,
        { cause: error },
      );
    }
    console.log(`PASS ${label}: ${expectedMessage}`);
    return;
  }
  throw new Error(`${label}: expected the transaction to be rejected`);
}

const db = new PGlite();
await db.waitReady;

for (const migration of migrations) {
  const path = join(fileURLToPath(migrationsRoot), migration, "migration.sql");
  let sql;
  try {
    sql = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Migration ${migration} is incomplete: ${path} is unreadable`, {
      cause: error,
    });
  }
  assert(sql.trim().length > 0, `Migration ${migration} is incomplete: migration.sql is empty`);
  migrationSqlByName.set(migration, sql);
  try {
    await db.exec(sql);
    console.log(`PASS ${migration}`);
  } catch (error) {
    console.error(`FAIL ${migration}`);
    throw error;
  }
}

const applied = await db.query(`
  SELECT COUNT(*)::INTEGER AS count
  FROM pg_proc
  WHERE proname IN (
    'validate_walking_quote_v4_capacity_slots',
    'validate_walking_capacity_hold',
    'validate_inventory_node_balance',
    'assert_walking_quote_inventory_availability',
    'protect_walking_inventory_reservation_decision'
  )
`);

if (applied.rows[0]?.count !== 5) {
  throw new Error(`Expected 5 corrective functions, found ${applied.rows[0]?.count ?? 0}`);
}

assert(
  migrations.includes("20260717002500_walking_delivery_v4_polymorphic_trigger_fix"),
  "Expected the 00:25 polymorphic trigger correction migration",
);
assert(
  migrations.includes("20260717003000_walking_delivery_v4_policy_publication_hardening"),
  "Expected the 00:30 policy/publication hardening migration",
);
assert(
  migrations.includes("20260717110000_walking_delivery_v4_outcome_lifecycle_compatibility"),
  "Expected the v4 outcome/lifecycle compatibility migration",
);
assert(
  migrations.includes("20260717113000_walking_delivery_v4_physical_reservation_parity"),
  "Expected the v4 physical reservation parity migration",
);
assert(
  migrations.includes("20260717120000_walking_delivery_v4_inventory_quote_evidence"),
  "Expected the v4 inventory quote evidence migration",
);
assert(
  migrations.includes("20260717123000_walking_delivery_v4_inventory_validation_restore"),
  "Expected the forward-only v4 inventory validation restoration migration",
);
assert(
  migrations.includes("20260717124500_walking_delivery_v4_concurrency_clock_hardening"),
  "Expected the forward-only v4 concurrency/clock hardening migration",
);
assert(
  migrations.includes("20260719223000_auth0_m2m_client_registry"),
  "Expected the Auth0 M2M client registry migration",
);

const m2mMigrationSql = migrationSqlByName.get(
  "20260719223000_auth0_m2m_client_registry",
);
assert(m2mMigrationSql, "Expected the M2M registry migration SQL to be readable");
assert(
  !m2mMigrationSql.includes('INSERT INTO "MachineClient"') &&
    !m2mMigrationSql.toLowerCase().includes("clientsecret"),
  "M2M schema migrations must not embed deployment Client IDs or secrets",
);

const m2mClientId = "89000000-0000-4000-8000-000000000001";
const m2mCredentialId = "89000000-0000-4000-8000-000000000002";
await db.exec(`
  INSERT INTO "MachineClient" (
    "id", "key", "displayName", "environment", "status", "version", "updatedAt"
  ) VALUES (
    '${m2mClientId}', 'pglite-storefront-staging', 'PGlite Storefront STAGING',
    'STAGING', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP
  );
  INSERT INTO "MachineCredential" (
    "id", "machineClientId", "environment", "provider", "issuer",
    "externalClientId", "status", "version", "updatedAt"
  ) VALUES (
    '${m2mCredentialId}', '${m2mClientId}', 'STAGING', 'AUTH0',
    'https://pglite-orderpro.us.auth0.com/', 'PGliteClientId1234567890',
    'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP
  );
  INSERT INTO "MachineClientGrant" (
    "machineClientId", "environment", "scope", "status", "version", "updatedAt"
  ) VALUES
    ('${m2mClientId}', 'STAGING', 'local-delivery:quote', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP),
    ('${m2mClientId}', 'STAGING', 'local-delivery:holds', 'PENDING_VERIFICATION', 1, CURRENT_TIMESTAMP);
`);

const pendingM2mResult = await db.query(`
  SELECT client."status"::TEXT AS "clientStatus",
         credential."status"::TEXT AS "credentialStatus",
         COUNT(grant_row."scope")::INTEGER AS "grantCount",
         COUNT(*) FILTER (WHERE grant_row."status" = 'ACTIVE')::INTEGER AS "activeGrantCount"
  FROM "MachineClient" client
  JOIN "MachineCredential" credential ON credential."machineClientId" = client."id"
    AND credential."environment" = client."environment"
  JOIN "MachineClientGrant" grant_row ON grant_row."machineClientId" = client."id"
    AND grant_row."environment" = client."environment"
  WHERE client."id" = '${m2mClientId}'
  GROUP BY client."status", credential."status"
`);
const pendingM2m = pendingM2mResult.rows[0];
assert(
  pendingM2m?.clientStatus === "PENDING_VERIFICATION" &&
    pendingM2m.credentialStatus === "PENDING_VERIFICATION" &&
    pendingM2m.grantCount === 2 &&
    pendingM2m.activeGrantCount === 0,
  `Unexpected pending M2M registry state: ${JSON.stringify(pendingM2mResult.rows)}`,
);
console.log("PASS M2M client, credential and exact grants onboard only as pending");

const failedM2mCertificationAuditId = "89000000-0000-4000-8000-000000000005";
await expectTransactionReject(
  "M2M certification rolls back credential evidence when its audit insert fails",
  `
    UPDATE "MachineCredential"
    SET "verifiedAt" = CURRENT_TIMESTAMP,
        "version" = "version" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${m2mCredentialId}'
      AND "status" = 'PENDING_VERIFICATION'
      AND "version" = 1
      AND "verifiedAt" IS NULL;

    INSERT INTO "AuditEvent" (
      "id", "action", "entityType", "entityId", "correlationId"
    ) VALUES (
      '${failedM2mCertificationAuditId}', 'm2m.client.token_certified',
      'MachineClient', '${m2mClientId}', NULL
    );
  `,
  "correlationId",
);
const rolledBackM2mResult = await db.query(`
  SELECT credential."version", credential."verifiedAt",
         COUNT(audit."id")::INTEGER AS "auditCount"
  FROM "MachineCredential" credential
  LEFT JOIN "AuditEvent" audit ON audit."id" = '${failedM2mCertificationAuditId}'
  WHERE credential."id" = '${m2mCredentialId}'
  GROUP BY credential."version", credential."verifiedAt"
`);
assert(
  rolledBackM2mResult.rows[0]?.version === 1 &&
    rolledBackM2mResult.rows[0]?.verifiedAt === null &&
    rolledBackM2mResult.rows[0]?.auditCount === 0,
  `M2M certification rollback left partial evidence: ${JSON.stringify(rolledBackM2mResult.rows)}`,
);
console.log("PASS M2M certification update and audit are atomic");

const m2mCertificationAuditId = "89000000-0000-4000-8000-000000000003";
const m2mCertificationCorrelationId = "89000000-0000-4000-8000-000000000004";
const m2mCertifiedAt = "2026-07-19T12:00:00.000Z";
const m2mVerifierDigest = "a".repeat(64);
const m2mEvidenceDigest = "b".repeat(64);
const m2mCertificationBefore = {
  clientStatus: "PENDING_VERIFICATION",
  clientVersion: 1,
  credentialStatus: "PENDING_VERIFICATION",
  grantStatus: "PENDING_VERIFICATION",
  grantVersions: [
    { scope: "local-delivery:holds", version: 1 },
    { scope: "local-delivery:quote", version: 1 },
  ],
  credentialVersion: 1,
  verifiedAt: null,
};
const m2mCertificationAfter = {
  schemaVersion: "orderpro.m2m-token-certification.v1",
  certificationOutcome: "VERIFIED_PENDING_APPROVAL",
  runtimeRegistryOutcome: "UNAUTHORIZED_PENDING",
  clientKey: "pglite-storefront-staging",
  machineClientId: m2mClientId,
  credentialId: m2mCredentialId,
  environment: "STAGING",
  provider: "AUTH0",
  issuer: "https://pglite-orderpro.us.auth0.com/",
  audience: "https://api.orderpro.internal/local-delivery/staging",
  allowedAlgorithm: "RS256",
  tokenProfile: "RFC9068",
  tokenLifetimeSeconds: 3_600,
  scopes: ["local-delivery:holds", "local-delivery:quote"],
  clientStatus: "PENDING_VERIFICATION",
  clientVersion: 1,
  credentialStatus: "PENDING_VERIFICATION",
  grantStatus: "PENDING_VERIFICATION",
  grantVersions: [
    { scope: "local-delivery:holds", version: 1 },
    { scope: "local-delivery:quote", version: 1 },
  ],
  previousCredentialVersion: 1,
  certifiedCredentialVersion: 2,
  sourceCommitSha: "c".repeat(40),
  sourceTreeSha: "d".repeat(40),
  verifierDigestSha256: m2mVerifierDigest,
  certifiedAt: m2mCertifiedAt,
  correlationId: m2mCertificationCorrelationId,
  evidenceDigestSha256: m2mEvidenceDigest,
};
await db.exec(`
  BEGIN;
  DO $$
  DECLARE
    affected_rows INTEGER;
  BEGIN
    UPDATE "MachineCredential"
    SET "verifiedAt" = '${m2mCertifiedAt}',
        "version" = "version" + 1,
        "updatedAt" = '${m2mCertifiedAt}'
    WHERE "id" = '${m2mCredentialId}'
      AND "status" = 'PENDING_VERIFICATION'
      AND "version" = 1
      AND "verifiedAt" IS NULL;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION 'M2M certification compare-and-swap failed';
    END IF;
  END;
  $$;

  INSERT INTO "AuditEvent" (
    "id", "action", "entityType", "entityId", "correlationId", "reason", "before", "after"
  ) VALUES (
    '${m2mCertificationAuditId}',
    'm2m.client.token_certified',
    'MachineClient',
    '${m2mClientId}',
    '${m2mCertificationCorrelationId}',
    'PGlite certification evidence; authorization remains pending.',
    '${JSON.stringify(m2mCertificationBefore)}'::jsonb,
    '${JSON.stringify(m2mCertificationAfter)}'::jsonb
  );
  COMMIT;
`);
const certifiedPendingResult = await db.query(`
  SELECT client."key" AS "clientKey",
         client."environment"::TEXT AS "clientEnvironment",
         client."status"::TEXT AS "clientStatus",
         client."version" AS "clientVersion",
         credential."environment"::TEXT AS "credentialEnvironment",
         credential."provider"::TEXT AS "credentialProvider",
         credential."issuer" AS "credentialIssuer",
         credential."externalClientId" AS "externalClientId",
         credential."status"::TEXT AS "credentialStatus",
         credential."verifiedAt" IS NOT NULL AS "credentialVerified",
         credential."version" AS "credentialVersion",
         COUNT(grant_row."scope")::INTEGER AS "grantCount",
         COUNT(*) FILTER (
           WHERE grant_row."status" = 'PENDING_VERIFICATION'
             AND grant_row."version" = 1
         )::INTEGER AS "unchangedPendingGrantCount",
         COUNT(*) FILTER (
           WHERE grant_row."scope" IN ('local-delivery:holds', 'local-delivery:quote')
         )::INTEGER AS "expectedScopeCount",
         COUNT(*) FILTER (WHERE grant_row."status" = 'ACTIVE')::INTEGER AS "activeGrantCount",
         audit."correlationId" AS "auditCorrelationId",
         audit."before"::TEXT AS "auditBefore",
         audit."after"::TEXT AS "auditAfter"
  FROM "MachineClient" client
  JOIN "MachineCredential" credential ON credential."machineClientId" = client."id"
  JOIN "MachineClientGrant" grant_row ON grant_row."machineClientId" = client."id"
  JOIN "AuditEvent" audit ON audit."entityId" = client."id"::TEXT
    AND audit."action" = 'm2m.client.token_certified'
  WHERE client."id" = '${m2mClientId}'
  GROUP BY client."key", client."environment", client."status", client."version",
           credential."environment", credential."provider", credential."issuer",
           credential."externalClientId", credential."status", credential."verifiedAt",
           credential."version", audit."correlationId", audit."before", audit."after"
`);
const certifiedPending = certifiedPendingResult.rows[0];
const persistedM2mBefore = JSON.parse(certifiedPending?.auditBefore ?? "null");
const persistedM2mAfter = JSON.parse(certifiedPending?.auditAfter ?? "null");
const serializedM2mAudit = JSON.stringify({
  before: persistedM2mBefore,
  after: persistedM2mAfter,
});
assert(
  certifiedPending?.clientKey === "pglite-storefront-staging" &&
    certifiedPending.clientEnvironment === "STAGING" &&
    certifiedPending.clientStatus === "PENDING_VERIFICATION" &&
    certifiedPending.clientVersion === 1 &&
    certifiedPending.credentialEnvironment === "STAGING" &&
    certifiedPending.credentialProvider === "AUTH0" &&
    certifiedPending.credentialIssuer === "https://pglite-orderpro.us.auth0.com/" &&
    certifiedPending.externalClientId === "PGliteClientId1234567890" &&
    certifiedPending.credentialStatus === "PENDING_VERIFICATION" &&
    certifiedPending.credentialVerified === true &&
    certifiedPending.credentialVersion === 2 &&
    certifiedPending.grantCount === 2 &&
    certifiedPending.unchangedPendingGrantCount === 2 &&
    certifiedPending.expectedScopeCount === 2 &&
    certifiedPending.activeGrantCount === 0 &&
    certifiedPending.auditCorrelationId === m2mCertificationCorrelationId &&
    persistedM2mBefore.clientStatus === "PENDING_VERIFICATION" &&
    persistedM2mBefore.clientVersion === 1 &&
    persistedM2mBefore.credentialStatus === "PENDING_VERIFICATION" &&
    persistedM2mBefore.credentialVersion === 1 &&
    persistedM2mBefore.grantStatus === "PENDING_VERIFICATION" &&
    JSON.stringify(persistedM2mBefore.grantVersions) ===
      JSON.stringify(m2mCertificationBefore.grantVersions) &&
    persistedM2mBefore.verifiedAt === null &&
    persistedM2mAfter.schemaVersion === "orderpro.m2m-token-certification.v1" &&
    persistedM2mAfter.certificationOutcome === "VERIFIED_PENDING_APPROVAL" &&
    persistedM2mAfter.runtimeRegistryOutcome === "UNAUTHORIZED_PENDING" &&
    persistedM2mAfter.tokenLifetimeSeconds === 3_600 &&
    /^[a-f0-9]{40,64}$/.test(persistedM2mAfter.sourceCommitSha) &&
    /^[a-f0-9]{40,64}$/.test(persistedM2mAfter.sourceTreeSha) &&
    JSON.stringify(persistedM2mAfter.scopes) ===
      JSON.stringify(["local-delivery:holds", "local-delivery:quote"]) &&
    /^[a-f0-9]{64}$/.test(persistedM2mAfter.verifierDigestSha256) &&
    /^[a-f0-9]{64}$/.test(persistedM2mAfter.evidenceDigestSha256) &&
    !serializedM2mAudit.includes("Bearer") &&
    !serializedM2mAudit.toLowerCase().includes("secret") &&
    !serializedM2mAudit.includes("PGliteClientId1234567890") &&
    !serializedM2mAudit.includes("access_token") &&
    !serializedM2mAudit.includes("authorization") &&
    !serializedM2mAudit.includes("jti"),
  `Unexpected certified-pending M2M state: ${JSON.stringify(certifiedPendingResult.rows)}`,
);
console.log("PASS M2M token certification records sanitized evidence without activation");

const activationTriggerResult = await db.query(`
  SELECT COUNT(*)::INTEGER AS count
  FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgname IN (
      'machine_client_no_activation',
      'machine_credential_no_activation',
      'machine_grant_no_activation'
    )
`);
assert(
  activationTriggerResult.rows[0]?.count === 3,
  `Expected all three M2M activation triggers, got ${JSON.stringify(activationTriggerResult.rows)}`,
);

await expectReject(
  "M2M client cannot activate before reviewed approval migration",
  () => db.exec(`
    UPDATE "MachineClient"
    SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${m2mClientId}'
  `),
  "Machine authorization activation requires a reviewed migration",
);
await expectReject(
  "M2M credential cannot activate after token certification",
  () => db.exec(`
    UPDATE "MachineCredential"
    SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${m2mCredentialId}'
  `),
  "Machine authorization activation requires a reviewed migration",
);
await expectReject(
  "M2M grants cannot activate after token certification",
  () => db.exec(`
    UPDATE "MachineClientGrant"
    SET "status" = 'ACTIVE', "activatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "machineClientId" = '${m2mClientId}'
  `),
  "Machine authorization activation requires a reviewed migration",
);
await expectReject(
  "M2M external credential identity is immutable",
  () => db.exec(`
    UPDATE "MachineCredential"
    SET "externalClientId" = 'ReplacementClientId123456', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${m2mCredentialId}'
  `),
  "Machine credential identity is immutable",
);
await expectReject(
  "M2M authorization history cannot be hard-deleted",
  () => db.exec(`DELETE FROM "MachineClientGrant" WHERE "machineClientId" = '${m2mClientId}'`),
  "Machine authorization records are retained; revoke instead of deleting",
);

const concurrencyMigrationSql = migrationSqlByName.get(
  "20260717124500_walking_delivery_v4_concurrency_clock_hardening",
);
assert(concurrencyMigrationSql, "Expected concurrency/clock migration SQL to be readable");
const concurrencyMigrationTrimmed = concurrencyMigrationSql.trim();
assert(
  concurrencyMigrationTrimmed.startsWith("BEGIN;") &&
    concurrencyMigrationTrimmed.endsWith("COMMIT;") &&
    (concurrencyMigrationTrimmed.match(/\bCOMMIT;/g) ?? []).length === 1,
  "Concurrency/clock hardening must be one atomic BEGIN/COMMIT migration",
);
const manualAuditIndex = concurrencyMigrationSql.indexOf(
  "V4_INVENTORY_VALIDATION_MANUAL_AUDIT_REQUIRED",
);
const firstReplacementIndex = concurrencyMigrationSql.indexOf("CREATE OR REPLACE FUNCTION");
assert(
  manualAuditIndex > 0 && manualAuditIndex < firstReplacementIndex &&
    concurrencyMigrationSql.includes("quote.\"schemaVersion\" = 'orderpro.walking-delivery-quote.v2'") &&
    !concurrencyMigrationSql.includes('UPDATE "FeatureFlag"') &&
    !concurrencyMigrationSql.includes('INSERT INTO "FeatureFlag"'),
  "Concurrency hardening must fail closed for pre-existing v2 evidence before changes and leave flags untouched",
);

const hardeningFunctionDefinitionsResult = await db.query(`
  SELECT proname, pg_get_functiondef(oid) AS definition
  FROM pg_proc
  WHERE proname IN (
    'assert_walking_quote_inventory_availability',
    'validate_walking_capacity_hold',
    'validate_walking_inventory_reservation',
    'validate_walking_inventory_reservation_line',
    'apply_walking_inventory_reservation_line_balance'
  )
`);
const hardeningFunctionDefinitions = new Map(
  hardeningFunctionDefinitionsResult.rows.map((row) => [row.proname, row.definition]),
);
const availabilityDefinition = hardeningFunctionDefinitions.get(
  "assert_walking_quote_inventory_availability",
);
assert(
  typeof availabilityDefinition === "string" &&
    (availabilityDefinition.match(/FOR SHARE OF balance/gi) ?? []).length === 1 &&
    availabilityDefinition.indexOf('ORDER BY balance."id"') <
      availabilityDefinition.indexOf("FOR SHARE OF balance") &&
    availabilityDefinition.indexOf("FOR SHARE OF balance") <
      availabilityDefinition.indexOf("FOR requirement IN") &&
    availabilityDefinition.includes("balance.\"available\" >= requirement.required_quantity"),
  "Availability definition must globally lock all balances by UUID before deterministic no-split group validation",
);
for (const functionName of [
  "validate_walking_capacity_hold",
  "validate_walking_inventory_reservation",
  "validate_walking_inventory_reservation_line",
  "apply_walking_inventory_reservation_line_balance",
]) {
  const definition = hardeningFunctionDefinitions.get(functionName);
  assert(
    typeof definition === "string" &&
      definition.includes("clock_timestamp()") &&
      !definition.includes("CURRENT_TIMESTAMP") &&
      definition.indexOf("FOR UPDATE") < definition.indexOf("clock_timestamp()"),
    `${functionName} must capture wall-clock time only after its blocking parent lock`,
  );
}
const capacityHoldDefinition = hardeningFunctionDefinitions.get(
  "validate_walking_capacity_hold",
);
assert(
  capacityHoldDefinition.indexOf('WHERE slot."id" = NEW."capacitySlotId"') <
    capacityHoldDefinition.indexOf("clock_timestamp()") &&
    capacityHoldDefinition.includes('hold."expiresAt" > validation_now') &&
    capacityHoldDefinition.includes("slot_starts_at <= validation_now"),
  "Capacity hold definition must lock its slot before one shared real-time expiry/capacity decision",
);
console.log("PASS forward-only precondition, global lock order, and post-lock wall-clock definitions inspected");
console.log(`PASS all ${migrations.length} complete migrations and corrective functions`);

// Match the UTC database/session convention used by Prisma and production.
await db.exec(`SET TIME ZONE 'UTC'`);

const hash = `sha256:${"a".repeat(64)}`;
const normalizedManhattanAddress = JSON.stringify({
  line1: "500 Madison Ave",
  line2: null,
  city: "New York",
  borough: "Manhattan",
  state: "NY",
  postalCode: "10022",
  country: "US",
});

await db.exec(`
  UPDATE "FeatureFlag"
  SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" = 'walking_delivery.quote_writes'
`);

await expectReject(
  "schema v1 rejects CONTACT_STORE even with its own write gate enabled",
  () => db.exec(`
    INSERT INTO "WalkingDeliveryQuote" (
      "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
      "reasonCode", "calculatedAt", "correlationId"
    ) VALUES (
      '91000000-0000-4000-8000-000000000001',
      'orderpro.walking-delivery-quote.v1',
      'pglite-v1-client', 'pglite-v1-contact-store', '${hash}',
      'CONTACT_STORE', CURRENT_TIMESTAMP, 'pglite-v1-contact-store'
    )
  `),
  "A v4 reason code cannot use the historical quote schema or write gate",
);

await db.exec(`
  UPDATE "FeatureFlag"
  SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" = 'walking_delivery.quote_writes'
`);

const insertV2ContactStore = (id, idempotencyKey) => db.exec(`
  INSERT INTO "WalkingDeliveryQuote" (
    "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
    "normalizedAddressStructured", "customerCoordinates", "postalCode",
    "reasonCode", "bookable", "calculatedAt", "expiresAt", "correlationId"
  ) VALUES (
    '${id}', 'orderpro.walking-delivery-quote.v2', 'pglite-v2-client',
    '${idempotencyKey}', '${hash}', '${normalizedManhattanAddress}'::JSONB,
    '[-73.9700,40.7580]'::JSONB, '10022', 'CONTACT_STORE', false,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '5 minutes',
    'pglite-v2-contact-store'
  )
`);

await expectReject(
  "schema v2 CONTACT_STORE fails closed while the v4 write gate is disabled",
  () => insertV2ContactStore(
    "92000000-0000-4000-8000-000000000001",
    "pglite-v2-contact-disabled",
  ),
  "Walking-delivery quote writes are disabled by feature flag local_delivery_v4.quote_writes",
);

await db.exec(`
  UPDATE "FeatureFlag"
  SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" = 'local_delivery_v4.quote_writes'
`);

await insertV2ContactStore(
  "92000000-0000-4000-8000-000000000002",
  "pglite-v2-contact-enabled",
);

const contactStoreResult = await db.query(`
  SELECT
    "schemaVersion", "reasonCode"::TEXT AS "reasonCode", "bookable",
    "postalCode", "normalizedAddressStructured" ->> 'borough' AS "borough",
    "selectedOperationalLocationId", "feePolicyVersionId", "routingProvider",
    "distanceFeet", "feeCents", "slotPolicyId", "slotSnapshot"
  FROM "WalkingDeliveryQuote"
  WHERE "id" = '92000000-0000-4000-8000-000000000002'
`);
const contactStore = contactStoreResult.rows[0];
assert(contactStore, "Expected the v2 CONTACT_STORE row to persist");
assert(
  contactStore.schemaVersion === "orderpro.walking-delivery-quote.v2" &&
    contactStore.reasonCode === "CONTACT_STORE" &&
    contactStore.bookable === false &&
    contactStore.postalCode === "10022" &&
    contactStore.borough === "Manhattan",
  `Unexpected v2 CONTACT_STORE result: ${JSON.stringify(contactStore)}`,
);
for (const field of [
  "selectedOperationalLocationId",
  "feePolicyVersionId",
  "routingProvider",
  "distanceFeet",
  "feeCents",
  "slotPolicyId",
  "slotSnapshot",
]) {
  assert(contactStore[field] === null, `CONTACT_STORE unexpectedly persisted ${field}`);
}
console.log("PASS schema v2 CONTACT_STORE with exact v4 gate and no priced-route evidence");

const contactAudit = await db.query(`
  SELECT "after" ->> 'reasonCode' AS "reasonCode",
         "after" ->> 'bookable' AS "bookable"
  FROM "AuditEvent"
  WHERE "entityType" = 'WalkingDeliveryQuote'
    AND "entityId" = '92000000-0000-4000-8000-000000000002'
`);
assert(
  contactAudit.rows[0]?.reasonCode === "CONTACT_STORE" &&
    contactAudit.rows[0]?.bookable === "false",
  `Expected CONTACT_STORE audit evidence, got ${JSON.stringify(contactAudit.rows)}`,
);
console.log("PASS schema v2 CONTACT_STORE audit evidence");

const thirdAvenueLocationId = "00000000-0000-4000-8000-000000000072";
const warehouseLocationId = "00000000-0000-4000-8000-000000000101";
const thirdAvenueIdentityId = "00000000-0000-4000-8610-000000000072";
const feeVersionId = "00000000-0000-4000-8510-000000000001";
const feeTierId = "00000000-0000-4000-8520-000000000002";
const feeShellId = "00000000-0000-4000-8100-000000000172";
const slotPolicyId = "00000000-0000-4000-8200-000000000072";
const zoneSetVersionId = "00000000-0000-4000-8600-000000000001";
const zoneVersionId = "20021000-0000-4000-8000-000000000101";
const walkingPublicationId = "93000000-0000-4000-8000-000000000001";
const capacitySlotId = "94000000-0000-4000-8000-000000000001";
const capacitySlotKey = "pglite-slot-third-20990720";
const productId = "95000000-0000-4000-8000-000000000001";
const storageLocationId = "95000000-0000-4000-8000-000000000002";
const containerId = "95000000-0000-4000-8000-000000000003";
const inventoryLotId = "95000000-0000-4000-8000-000000000004";
const openingLedgerId = "95000000-0000-4000-8000-000000000005";
const inventoryBalanceId = "95000000-0000-4000-8000-000000000006";
const warehouseStorageLocationId = "95000000-0000-4000-8000-000000000007";
const warehouseContainerId = "95000000-0000-4000-8000-000000000008";
const alternateContainerId = "95000000-0000-4000-8000-000000000020";
const alternateInventoryLotId = "95000000-0000-4000-8000-000000000021";
const alternateOpeningLedgerId = "95000000-0000-4000-8000-000000000022";
const alternateInventoryBalanceId = "95000000-0000-4000-8000-000000000023";
const warehouseOpeningLedgerId = "95000000-0000-4000-8000-000000000024";
const warehouseInventoryBalanceId = "95000000-0000-4000-8000-000000000025";
const inactiveProductId = "95000000-0000-4000-8000-000000000026";
const sharedPhysicalInventoryLotId = "95000000-0000-4000-8000-000000000027";
const sharedPhysicalOpeningLedgerId = "95000000-0000-4000-8000-000000000028";
const sharedPhysicalInventoryBalanceId = "95000000-0000-4000-8000-000000000029";
const quoteId = "96000000-0000-4000-8000-000000000001";
const routeId = "96000000-0000-4000-8000-000000000002";
const quoteInventoryLineId = "96000000-0000-4000-8000-000000000003";
const transferNoSlotsQuoteId = "96000000-0000-4000-8000-000000000010";
const transferNoSlotsRouteId = "96000000-0000-4000-8000-000000000011";
const transferNoSlotsLineId = "96000000-0000-4000-8000-000000000012";
const noBalanceQuoteId = "96000000-0000-4000-8000-000000000020";
const noBalanceRouteId = "96000000-0000-4000-8000-000000000021";
const noBalanceLineId = "96000000-0000-4000-8000-000000000022";
const aggregateQuoteId = "96000000-0000-4000-8000-000000000030";
const aggregateRouteId = "96000000-0000-4000-8000-000000000031";
const aggregateLineOneId = "96000000-0000-4000-8000-000000000032";
const aggregateLineTwoId = "96000000-0000-4000-8000-000000000033";
const calculatedAt = "2099-07-20T10:00:00.000Z";
const quoteExpiresAt = "2099-07-20T10:15:00.000Z";
const slotStartsAt = "2099-07-20T14:00:00.000Z";
const slotEndsAt = "2099-07-20T15:00:00.000Z";
const fixtureDigest = `sha256:${"c".repeat(64)}`;
const allWalkingDays = `ARRAY[
  'SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'
]::"WalkingWeekday"[]`;

// Publication workflow itself is independently guarded and audited. For this
// integration fixture, build already-published prerequisites with user triggers
// disabled, then exercise every runtime trigger with the normal role restored.
await db.exec(`
  BEGIN;
  SET LOCAL session_replication_role = replica;

  UPDATE "OperationalLocation"
  SET
    "publicId" = 'store-3rd-avenue', "addressLine1" = '1243 3rd Ave',
    "city" = 'New York', "regionCode" = 'NY', "postalCode" = '10021',
    "countryCode" = 'US', "timeZone" = 'America/New_York',
    "latitude" = 40.769474, "longitude" = -73.960716,
    "active" = true, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${thirdAvenueLocationId}';

  UPDATE "LocalDeliveryLocationIdentity"
  SET "locationPriority" = 1, "active" = true, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${thirdAvenueIdentityId}';

  UPDATE "FeeCalculationPolicyVersion"
  SET
    "status" = 'PUBLISHED', "environment" = 'STAGING',
    "quoteTtlSeconds" = 900, "holdTtlSeconds" = 600,
    "preparationBufferSeconds" = 300, "handoffBufferSeconds" = 0,
    "snapshot" = '{"fixture":"pglite-v4-runtime"}'::JSONB,
    "digest" = '${fixtureDigest}', "effectiveFrom" = '2000-01-01T00:00:00Z',
    "validatedAt" = '2000-01-01T00:00:00Z',
    "publishedAt" = '2000-01-01T00:00:00Z', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${feeVersionId}';

  UPDATE "FeePolicy"
  SET
    "status" = 'PUBLISHED', "baseFeeCents" = NULL,
    "rateRules" = NULL, "exceptions" = NULL, "activeDays" = ${allWalkingDays},
    "effectiveFrom" = '2000-01-01T00:00:00Z', "digest" = '${fixtureDigest}',
    "publishedAt" = '2000-01-01T00:00:00Z', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${feeShellId}';

  UPDATE "SlotPolicy"
  SET
    "status" = 'PUBLISHED', "activeDays" = ${allWalkingDays},
    "leadTimeMinutes" = 0, "cutoffMinuteOfDay" = 1439,
    "capacityPolicyRef" = 'pglite-capacity-seconds-v1',
    "effectiveFrom" = '2000-01-01T00:00:00Z', "digest" = '${fixtureDigest}',
    "publishedAt" = '2000-01-01T00:00:00Z', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${slotPolicyId}';

  UPDATE "WalkingZoneSetVersion"
  SET
    "status" = 'PUBLISHED', "environment" = 'STAGING',
    "snapshot" = '{"fixture":"pglite-v4-zone-set"}'::JSONB,
    "digest" = '${fixtureDigest}', "effectiveFrom" = '2000-01-01T00:00:00Z',
    "validatedAt" = '2000-01-01T00:00:00Z',
    "publishedAt" = '2000-01-01T00:00:00Z', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${zoneSetVersionId}';

  UPDATE "WalkingZoneVersion"
  SET
    "status" = 'PUBLISHED', "priority" = 1,
    "geometry" = '{"type":"Polygon","coordinates":[[[-74.0,40.7],[-73.9,40.7],[-73.9,40.8],[-74.0,40.8],[-74.0,40.7]]]}'::JSONB,
    "activeDays" = ${allWalkingDays},
    "snapshot" = '{"fixture":"pglite-v4-zone-10021"}'::JSONB,
    "digest" = '${fixtureDigest}', "effectiveFrom" = '2000-01-01T00:00:00Z',
    "validatedAt" = '2000-01-01T00:00:00Z',
    "publishedAt" = '2000-01-01T00:00:00Z', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${zoneVersionId}';

  INSERT INTO "WalkingPublication" (
    "id", "versionNumber", "schemaVersion", "status", "snapshot", "digest",
    "effectiveFrom", "zoneSetVersionId", "publishedAt", "createdAt"
  ) VALUES (
    '${walkingPublicationId}', 999, 'orderpro.walking-zones.v1', 'PUBLISHED',
    '{"zones":[{"zoneVersionId":"${zoneVersionId}"}]}'::JSONB,
    '${fixtureDigest}', '2000-01-01T00:00:00Z', '${zoneSetVersionId}',
    '2000-01-01T00:00:00Z', CURRENT_TIMESTAMP
  );

  INSERT INTO "Product" (
    "id", "squareVariationId", "displayName", "active", "createdAt", "updatedAt"
  ) VALUES (
    '${productId}', 'pglite-variant-001', 'PGlite walking fixture item', true,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "Product" (
    "id", "squareVariationId", "displayName", "active", "createdAt", "updatedAt"
  ) VALUES (
    '${inactiveProductId}', 'pglite-inactive-variant',
    'PGlite inactive walking fixture item', false,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "StorageLocation" (
    "id", "operationalLocationId", "code", "name", "active", "createdAt", "updatedAt"
  ) VALUES (
    '${storageLocationId}', '${thirdAvenueLocationId}', 'PGLITE-BIN',
    'PGlite certified bin', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "Container" (
    "id", "code", "type", "status", "ownerLocationId", "currentLocationId",
    "storageLocationId", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${containerId}', 'PGLITEBOX1', 'BOX', 'ACTIVE', '${thirdAvenueLocationId}',
    '${thirdAvenueLocationId}', '${storageLocationId}', 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "Container" (
    "id", "code", "type", "status", "ownerLocationId", "currentLocationId",
    "storageLocationId", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${alternateContainerId}', 'PGLITEBOX2', 'BOX', 'ACTIVE', '${thirdAvenueLocationId}',
    '${thirdAvenueLocationId}', '${storageLocationId}', 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "StorageLocation" (
    "id", "operationalLocationId", "code", "name", "active", "createdAt", "updatedAt"
  ) VALUES (
    '${warehouseStorageLocationId}', '${warehouseLocationId}', 'PGLITE-WH-BIN',
    'PGlite warehouse transfer bin', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "Container" (
    "id", "code", "type", "status", "ownerLocationId", "currentLocationId",
    "storageLocationId", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${warehouseContainerId}', 'PGLITEWHBOX1', 'BOX', 'ACTIVE', '${thirdAvenueLocationId}',
    '${warehouseLocationId}', '${warehouseStorageLocationId}', 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "InventoryLot" (
    "id", "productId", "ownerLocationId", "sourceReference", "createdAt"
  ) VALUES (
    '${inventoryLotId}', '${productId}', '${thirdAvenueLocationId}',
    'pglite-opening-lot', CURRENT_TIMESTAMP
  );
  INSERT INTO "InventoryLot" (
    "id", "productId", "ownerLocationId", "sourceReference", "createdAt"
  ) VALUES (
    '${alternateInventoryLotId}', '${productId}', '${thirdAvenueLocationId}',
    'pglite-alternate-lot', CURRENT_TIMESTAMP
  );
  INSERT INTO "InventoryLot" (
    "id", "productId", "ownerLocationId", "sourceReference", "createdAt"
  ) VALUES (
    '${sharedPhysicalInventoryLotId}', '${productId}', '${thirdAvenueLocationId}',
    'pglite-shared-physical-lot', CURRENT_TIMESTAMP
  );
  COMMIT;
`);
console.log("PASS published runtime prerequisites prepared without bypassing runtime triggers");

await db.exec(`
  INSERT INTO "WalkingCapacitySlot" (
    "id", "slotPolicyId", "operationalLocationId", "slotKey", "startsAt", "endsAt",
    "capacitySeconds", "status", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${capacitySlotId}', '${slotPolicyId}', '${thirdAvenueLocationId}', '${capacitySlotKey}',
    '${slotStartsAt}', '${slotEndsAt}', 7200, 'OPEN', 1,
    '${calculatedAt}', '${calculatedAt}'
  )
`);
console.log("PASS future capacity slot accepted by published temporal policy");

const openingLedger = await db.query(`
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId", "containerId",
    "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId", "toStorageLocationId",
    "businessReferenceType", "businessReferenceId", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    '${openingLedgerId}', 'OPENING_BALANCE', 'pglite-opening-balance-v4',
    '${productId}', '${inventoryLotId}', '${containerId}', 10,
    NULL, 'AVAILABLE_ONLINE', NULL, '${thirdAvenueLocationId}', NULL, '${storageLocationId}',
    'InventoryNodeBalance', '${inventoryBalanceId}', 'pglite-v4-inventory',
    '{"inventoryNodeBalanceId":"${inventoryBalanceId}"}'::JSONB, '${calculatedAt}'
  ) RETURNING "sequence"::TEXT AS "sequence"
`);
const openingLedgerSequence = openingLedger.rows[0]?.sequence;
assert(
  typeof openingLedgerSequence === "string" && /^\d+$/.test(openingLedgerSequence),
  `Expected opening ledger sequence, got ${JSON.stringify(openingLedger.rows)}`,
);

await db.exec(`
  INSERT INTO "InventoryNodeBalance" (
    "id", "productId", "inventoryLotId", "inventoryOwnerLocationId", "inventoryNodeId",
    "containerId", "storageLocationId", "onHand", "available", "reserved", "damaged",
    "ledgerSequence", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${inventoryBalanceId}', '${productId}', '${inventoryLotId}', '${thirdAvenueLocationId}',
    '${thirdAvenueLocationId}', '${containerId}', '${storageLocationId}',
    10, 10, 0, 0, ${openingLedgerSequence}, 1, '${calculatedAt}', '${calculatedAt}'
  )
`);
console.log("PASS initial inventory balance requires its exact physical opening ledger event");

const alternateOpeningLedger = await db.query(`
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId", "containerId",
    "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId", "toStorageLocationId",
    "businessReferenceType", "businessReferenceId", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    '${alternateOpeningLedgerId}', 'OPENING_BALANCE', 'pglite-opening-balance-v4-alternate',
    '${productId}', '${alternateInventoryLotId}', '${alternateContainerId}', 5,
    NULL, 'AVAILABLE_ONLINE', NULL, '${thirdAvenueLocationId}', NULL, '${storageLocationId}',
    'InventoryNodeBalance', '${alternateInventoryBalanceId}', 'pglite-v4-inventory-alternate',
    '{"inventoryNodeBalanceId":"${alternateInventoryBalanceId}"}'::JSONB, '${calculatedAt}'
  ) RETURNING "sequence"::TEXT AS "sequence"
`);
const alternateOpeningLedgerSequence = alternateOpeningLedger.rows[0]?.sequence;
assert(
  typeof alternateOpeningLedgerSequence === "string" && /^\d+$/.test(alternateOpeningLedgerSequence),
  `Expected alternate opening ledger sequence, got ${JSON.stringify(alternateOpeningLedger.rows)}`,
);
await db.exec(`
  INSERT INTO "InventoryNodeBalance" (
    "id", "productId", "inventoryLotId", "inventoryOwnerLocationId", "inventoryNodeId",
    "containerId", "storageLocationId", "onHand", "available", "reserved", "damaged",
    "ledgerSequence", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${alternateInventoryBalanceId}', '${productId}', '${alternateInventoryLotId}',
    '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${alternateContainerId}',
    '${storageLocationId}', 5, 5, 0, 0, ${alternateOpeningLedgerSequence}, 1,
    '${calculatedAt}', '${calculatedAt}'
  )
`);
console.log("PASS alternate certified balance prepared for physical-substitution rejection");

const sharedPhysicalOpeningLedger = await db.query(`
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId", "containerId",
    "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId", "toStorageLocationId",
    "businessReferenceType", "businessReferenceId", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    '${sharedPhysicalOpeningLedgerId}', 'OPENING_BALANCE',
    'pglite-opening-balance-v4-shared-physical', '${productId}',
    '${sharedPhysicalInventoryLotId}', '${containerId}', 5,
    NULL, 'AVAILABLE_ONLINE', NULL, '${thirdAvenueLocationId}', NULL,
    '${storageLocationId}', 'InventoryNodeBalance',
    '${sharedPhysicalInventoryBalanceId}', 'pglite-v4-shared-physical-inventory',
    '{"inventoryNodeBalanceId":"${sharedPhysicalInventoryBalanceId}"}'::JSONB,
    '${calculatedAt}'
  ) RETURNING "sequence"::TEXT AS "sequence"
`);
const sharedPhysicalOpeningLedgerSequence = sharedPhysicalOpeningLedger.rows[0]?.sequence;
assert(
  typeof sharedPhysicalOpeningLedgerSequence === "string" &&
    /^\d+$/.test(sharedPhysicalOpeningLedgerSequence),
  `Expected shared-physical opening ledger sequence, got ${JSON.stringify(sharedPhysicalOpeningLedger.rows)}`,
);
await db.exec(`
  INSERT INTO "InventoryNodeBalance" (
    "id", "productId", "inventoryLotId", "inventoryOwnerLocationId", "inventoryNodeId",
    "containerId", "storageLocationId", "onHand", "available", "reserved", "damaged",
    "ledgerSequence", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${sharedPhysicalInventoryBalanceId}', '${productId}',
    '${sharedPhysicalInventoryLotId}', '${thirdAvenueLocationId}',
    '${thirdAvenueLocationId}', '${containerId}', '${storageLocationId}',
    5, 5, 0, 0, ${sharedPhysicalOpeningLedgerSequence}, 1,
    '${calculatedAt}', '${calculatedAt}'
  )
`);
console.log("PASS second partial balance shares the quoted physical tuple without merging lots");

const fabricatedLedger = await db.query(`
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId", "containerId",
    "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId", "toStorageLocationId",
    "businessReferenceType", "businessReferenceId", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    '95000000-0000-4000-8000-000000000099', 'RESERVED',
    'pglite-fabricated-reservation-ledger', '${productId}', '${inventoryLotId}',
    '${containerId}', 4, 'UNAVAILABLE', 'SOLD', '${thirdAvenueLocationId}',
    '${thirdAvenueLocationId}', '${storageLocationId}', '${storageLocationId}',
    'WalkingInventoryReservationLine', 'does-not-exist', 'pglite-fabricated-ledger',
    '{
      "inventoryNodeBalanceId":"${inventoryBalanceId}",
      "availableBefore":10,
      "availableAfter":6,
      "reservedBefore":0,
      "reservedAfter":4
    }'::JSONB, '${calculatedAt}'
  ) RETURNING "sequence"::TEXT AS "sequence"
`);
const fabricatedLedgerSequence = fabricatedLedger.rows[0]?.sequence;
assert(
  typeof fabricatedLedgerSequence === "string" && /^\d+$/.test(fabricatedLedgerSequence),
  `Expected fabricated ledger sequence, got ${JSON.stringify(fabricatedLedger.rows)}`,
);
await expectReject(
  "inventory balance rejects a fabricated ledger event without a real reservation line",
  () => db.exec(`
    UPDATE "InventoryNodeBalance"
    SET "available" = 6, "reserved" = 4,
        "ledgerSequence" = ${fabricatedLedgerSequence}, "version" = 2,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${inventoryBalanceId}'
  `),
  "Reserved balance delta does not match its ledger entry",
);

const normalized10021Address = JSON.stringify({
  line1: "310 E 75th St",
  line2: null,
  city: "New York",
  borough: "Manhattan",
  state: "NY",
  postalCode: "10021",
  country: "US",
});
const requestedSlotSnapshot = JSON.stringify([
  {
    slotId: capacitySlotKey,
    locationId: "third_avenue",
    startsAt: slotStartsAt,
    endsAt: slotEndsAt,
    remainingCapacitySeconds: 7200,
  },
]);

await db.exec(`
  BEGIN;
  INSERT INTO "WalkingDeliveryQuote" (
    "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
    "normalizedAddressStructured", "customerCoordinates", "postalCode",
    "selectedLocationId", "zoneVersionId", "zoneSetVersionId",
    "feePolicyVersionId", "externalFeePolicyVersionId", "routingProvider",
    "distanceFeet", "durationSeconds", "roundTripDistanceFeet",
    "estimatedRoundTripDurationSeconds", "capacityRequiredSeconds",
    "feeCents", "tierId", "reasonCode", "calculatedAt", "routeCalculatedAt",
    "expiresAt", "inventoryReadinessStatus", "slotPolicyId", "slotSnapshot",
    "walkingPublicationId", "correlationId"
  ) VALUES (
    '${quoteId}', 'orderpro.walking-delivery-quote.v2', 'pglite-v4-client',
    'pglite-v4-priced-quote', '${hash}', '${normalized10021Address}'::JSONB,
    '[-73.9588,40.7710]'::JSONB, '10021', 'third_avenue',
    '${zoneVersionId}', '${zoneSetVersionId}', '${feeVersionId}',
    'walking-route-distance-v4-base-10-2026-07-16', 'pglite-walking-router',
    1760, 600, 3520, 1200, 1500, 1000, '${feeTierId}', 'ELIGIBLE',
    '${calculatedAt}', '${calculatedAt}', '${quoteExpiresAt}', 'READY',
    '${slotPolicyId}', '${requestedSlotSnapshot}'::JSONB,
    '${walkingPublicationId}', 'pglite-v4-priced-quote'
  );

  INSERT INTO "WalkingDeliveryQuoteCandidateRoute" (
    "id", "quoteId", "localDeliveryLocationId", "operationalLocationId",
    "externalLocationId", "sequence", "locationPriority", "walkingDistanceFeet",
    "walkingDurationSeconds", "routingProvider", "routingProfile",
    "routeCalculatedAt", "selected", "createdAt"
  ) VALUES (
    '${routeId}', '${quoteId}', '${thirdAvenueIdentityId}', '${thirdAvenueLocationId}',
    'third_avenue', 1, 1, 1760, 600, 'pglite-walking-router', 'walking',
    '${calculatedAt}', true, '${calculatedAt}'
  );

  INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
    "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
    "readinessStatus", "inventoryOwnerLocationId", "inventoryNodeId", "containerId",
    "storageLocationId", "transferStatus", "createdAt"
  ) VALUES (
    '${quoteInventoryLineId}', '${quoteId}', 1, 'pglite-variant-001', '${productId}', 1,
    'READY', '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${containerId}',
    '${storageLocationId}', 'NOT_REQUIRED', '${calculatedAt}'
  );
  COMMIT;
`);

const pricedQuoteResult = await db.query(`
  SELECT
    "bookable", "externalSelectedLocationId", "selectedOperationalLocationId"::TEXT,
    "capacityRequiredSeconds", "feeCents", "slotSnapshot" -> 'slots' -> 0 ->> 'slotId' AS "slotId",
    "slotSnapshot" -> 'slots' -> 0 ->> 'remainingCapacitySeconds' AS "remainingCapacity",
    "feePolicySnapshot" IS NOT NULL AS "hasFeeSnapshot",
    "tierSnapshot" ->> 'id' AS "tierKey"
  FROM "WalkingDeliveryQuote" WHERE "id" = '${quoteId}'
`);
const pricedQuote = pricedQuoteResult.rows[0];
assert(
  pricedQuote?.bookable === true &&
    pricedQuote.externalSelectedLocationId === "third_avenue" &&
    pricedQuote.selectedOperationalLocationId === thirdAvenueLocationId &&
    pricedQuote.capacityRequiredSeconds === 1500 &&
    pricedQuote.feeCents === 1000 &&
    pricedQuote.slotId === capacitySlotKey &&
    pricedQuote.remainingCapacity === "7200" &&
    pricedQuote.hasFeeSnapshot === true &&
    pricedQuote.tierKey === "base-delivery",
  `Unexpected canonical priced quote: ${JSON.stringify(pricedQuote)}`,
);
console.log("PASS priced v2 quote canonicalizes exact route, policy, inventory, and capacity-slot snapshot");

const inventoryIdentitySnapshotResult = await db.query(`
  SELECT
    "inventoryOwnerExternalLocationId" AS "ownerExternalId",
    "inventoryNodeExternalId" AS "nodeExternalId",
    "snapshot" ->> 'inventoryOwnerExternalLocationId' AS "snapshotOwnerExternalId",
    "snapshot" ->> 'inventoryNodeExternalId' AS "snapshotNodeExternalId"
  FROM "WalkingDeliveryQuoteInventoryLine"
  WHERE "id" = '${quoteInventoryLineId}'
`);
const inventoryIdentitySnapshot = inventoryIdentitySnapshotResult.rows[0];
assert(
  inventoryIdentitySnapshot?.ownerExternalId === "third_avenue" &&
    inventoryIdentitySnapshot.nodeExternalId === "third_avenue" &&
    inventoryIdentitySnapshot.snapshotOwnerExternalId === "third_avenue" &&
    inventoryIdentitySnapshot.snapshotNodeExternalId === "third_avenue",
  `Unexpected inventory identity snapshots: ${JSON.stringify(inventoryIdentitySnapshot)}`,
);
console.log("PASS quote inventory preserves canonical external owner/node snapshots");

await expectReject(
  "quote inventory rejects a caller-supplied owner identity that disagrees with canonical data",
  () => db.exec(`
    INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
      "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
      "readinessStatus", "inventoryOwnerLocationId",
      "inventoryOwnerExternalLocationId", "inventoryNodeId", "containerId",
      "storageLocationId", "transferStatus", "createdAt"
    ) VALUES (
      '96000000-0000-4000-8000-000000000004', '${quoteId}', 2,
      'pglite-variant-001', '${productId}', 1, 'READY',
      '${thirdAvenueLocationId}', 'east_86th_street', '${thirdAvenueLocationId}',
      '${containerId}', '${storageLocationId}', 'NOT_REQUIRED', '${calculatedAt}'
    )
  `),
  "Quote inventory owner external identity does not match its canonical location",
);

const insertInventoryValidationProbe = ({
  variantId = "pglite-variant-001",
  productIdSql = `'${productId}'`,
  readinessStatus = "READY",
  ownerIdSql = `'${thirdAvenueLocationId}'`,
  ownerExternalIdSql = "NULL",
  nodeIdSql = `'${thirdAvenueLocationId}'`,
  nodeExternalIdSql = "NULL",
  containerIdSql = `'${containerId}'`,
  storageLocationIdSql = `'${storageLocationId}'`,
  transferStatus = "NOT_REQUIRED",
  earliestReadyAtSql = "NULL",
} = {}) => db.exec(`
  INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
    "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
    "readinessStatus", "inventoryOwnerLocationId",
    "inventoryOwnerExternalLocationId", "inventoryNodeId",
    "inventoryNodeExternalId", "containerId", "storageLocationId",
    "transferStatus", "earliestReadyAt", "createdAt"
  ) VALUES (
    '96000000-0000-4000-8000-000000000005', '${quoteId}', 2,
    '${variantId}', ${productIdSql}, 1, '${readinessStatus}', ${ownerIdSql},
    ${ownerExternalIdSql}, ${nodeIdSql}, ${nodeExternalIdSql}, ${containerIdSql},
    ${storageLocationIdSql}, '${transferStatus}', ${earliestReadyAtSql},
    '${calculatedAt}'
  )
`);

await expectReject(
  "quote inventory rejects a variant that disagrees with its active product",
  () => insertInventoryValidationProbe({ variantId: "pglite-wrong-variant" }),
  "Quote variant must match its active product identity",
);

await expectReject(
  "quote inventory rejects an inactive product even when its variant matches",
  () => insertInventoryValidationProbe({
    variantId: "pglite-inactive-variant",
    productIdSql: `'${inactiveProductId}'`,
  }),
  "Quote variant must match its active product identity",
);

await expectReject(
  "resolved quote inventory requires complete product/owner/node/physical evidence",
  () => insertInventoryValidationProbe({
    productIdSql: "NULL",
    ownerIdSql: "NULL",
    nodeIdSql: "NULL",
    containerIdSql: "NULL",
    storageLocationIdSql: "NULL",
  }),
  "Resolved quote inventory requires product, owner, node, and physical evidence",
);

await expectReject(
  "quote inventory rejects a container whose node/bin disagrees with the evidence",
  () => insertInventoryValidationProbe({
    containerIdSql: `'${warehouseContainerId}'`,
    storageLocationIdSql: `'${warehouseStorageLocationId}'`,
  }),
  "Quote inventory physical node/container/bin references disagree",
);

await expectReject(
  "quote inventory rejects a storage bin outside its declared node",
  () => insertInventoryValidationProbe({
    containerIdSql: "NULL",
    storageLocationIdSql: `'${warehouseStorageLocationId}'`,
  }),
  "Quote inventory bin does not belong to its physical node",
);

await expectReject(
  "quote inventory outside the delivery store requires transfer evidence",
  () => insertInventoryValidationProbe({
    nodeIdSql: `'${warehouseLocationId}'`,
    containerIdSql: `'${warehouseContainerId}'`,
    storageLocationIdSql: `'${warehouseStorageLocationId}'`,
  }),
  "Quote inventory outside the delivery store requires transfer evidence",
);

await expectReject(
  "quote inventory already at the delivery store cannot require transfer",
  () => insertInventoryValidationProbe({ transferStatus: "TRANSFER_REQUIRED" }),
  "Quote inventory at the delivery store cannot require transfer",
);

await expectReject(
  "transfer-required quote inventory requires earliestReadyAt",
  () => insertInventoryValidationProbe({
    readinessStatus: "TRANSFER_REQUIRED",
    nodeIdSql: `'${warehouseLocationId}'`,
    containerIdSql: `'${warehouseContainerId}'`,
    storageLocationIdSql: `'${warehouseStorageLocationId}'`,
    transferStatus: "TRANSFER_REQUIRED",
  }),
  "Transfer-required quote inventory needs an earliest ready time",
);

await expectReject(
  "quote inventory rejects a caller-supplied node identity that disagrees with canonical data",
  () => insertInventoryValidationProbe({
    nodeExternalIdSql: "'east_86th_street'",
  }),
  "Quote inventory node external identity does not match its canonical location",
);

const transferReadyAt = "2099-07-20T13:00:00.000Z";

await db.exec(`BEGIN`);
try {
  await db.exec(`
    INSERT INTO "WalkingDeliveryQuote" (
      "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
      "normalizedAddressStructured", "customerCoordinates", "postalCode",
      "selectedLocationId", "zoneVersionId", "zoneSetVersionId",
      "feePolicyVersionId", "externalFeePolicyVersionId", "routingProvider",
      "distanceFeet", "durationSeconds", "roundTripDistanceFeet",
      "estimatedRoundTripDurationSeconds", "capacityRequiredSeconds",
      "feeCents", "tierId", "reasonCode", "calculatedAt", "routeCalculatedAt",
      "expiresAt", "inventoryReadinessStatus", "inventoryReadyAt",
      "slotPolicyId", "slotSnapshot", "walkingPublicationId", "correlationId"
    ) VALUES (
      '${noBalanceQuoteId}', 'orderpro.walking-delivery-quote.v2',
      'pglite-v4-client', 'pglite-v4-no-certified-balance', '${hash}',
      '${normalized10021Address}'::JSONB, '[-73.9588,40.7710]'::JSONB, '10021',
      'third_avenue', '${zoneVersionId}', '${zoneSetVersionId}', '${feeVersionId}',
      'walking-route-distance-v4-base-10-2026-07-16', 'pglite-walking-router',
      1760, 600, 3520, 1200, 1500, 1000, '${feeTierId}',
      'NO_SLOTS_FOR_SELECTED_LOCATION', '${calculatedAt}', '${calculatedAt}',
      '${quoteExpiresAt}', 'TRANSFER_REQUIRED', '${transferReadyAt}',
      '${slotPolicyId}', '[]'::JSONB, '${walkingPublicationId}',
      'pglite-v4-no-certified-balance'
    );

    INSERT INTO "WalkingDeliveryQuoteCandidateRoute" (
      "id", "quoteId", "localDeliveryLocationId", "operationalLocationId",
      "externalLocationId", "sequence", "locationPriority", "walkingDistanceFeet",
      "walkingDurationSeconds", "routingProvider", "routingProfile",
      "routeCalculatedAt", "selected", "createdAt"
    ) VALUES (
      '${noBalanceRouteId}', '${noBalanceQuoteId}', '${thirdAvenueIdentityId}',
      '${thirdAvenueLocationId}', 'third_avenue', 1, 1, 1760, 600,
      'pglite-walking-router', 'walking', '${calculatedAt}', true, '${calculatedAt}'
    );

    INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
      "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
      "readinessStatus", "inventoryOwnerLocationId", "inventoryNodeId", "containerId",
      "storageLocationId", "transferStatus", "earliestReadyAt", "createdAt"
    ) VALUES (
      '${noBalanceLineId}', '${noBalanceQuoteId}', 1,
      'pglite-variant-001', '${productId}', 1, 'TRANSFER_REQUIRED',
      '${thirdAvenueLocationId}', '${warehouseLocationId}', '${warehouseContainerId}',
      '${warehouseStorageLocationId}', 'TRANSFER_REQUIRED', '${transferReadyAt}',
      '${calculatedAt}'
    );
  `);
  await expectReject(
    "quote inventory rejects physical evidence without a certified compatible balance",
    () => db.exec(`SET CONSTRAINTS ALL IMMEDIATE`),
    "Quote READY/TRANSFER_REQUIRED inventory requires one sufficient certified compatible balance",
  );
} finally {
  await db.exec(`ROLLBACK`);
}

const warehouseOpeningLedger = await db.query(`
  INSERT INTO "InventoryLedgerEntry" (
    "id", "eventType", "idempotencyKey", "productId", "inventoryLotId", "containerId",
    "quantity", "fromAvailabilityState", "toAvailabilityState",
    "fromLocationId", "toLocationId", "fromStorageLocationId", "toStorageLocationId",
    "businessReferenceType", "businessReferenceId", "correlationId", "metadata", "occurredAt"
  ) VALUES (
    '${warehouseOpeningLedgerId}', 'OPENING_BALANCE', 'pglite-warehouse-opening-balance-v4',
    '${productId}', '${inventoryLotId}', '${warehouseContainerId}', 5,
    NULL, 'AVAILABLE_ONLINE', NULL, '${warehouseLocationId}', NULL,
    '${warehouseStorageLocationId}', 'InventoryNodeBalance',
    '${warehouseInventoryBalanceId}', 'pglite-v4-warehouse-inventory',
    '{"inventoryNodeBalanceId":"${warehouseInventoryBalanceId}"}'::JSONB,
    '${calculatedAt}'
  ) RETURNING "sequence"::TEXT AS "sequence"
`);
const warehouseOpeningLedgerSequence = warehouseOpeningLedger.rows[0]?.sequence;
assert(
  typeof warehouseOpeningLedgerSequence === "string" &&
    /^\d+$/.test(warehouseOpeningLedgerSequence),
  `Expected warehouse opening ledger sequence, got ${JSON.stringify(warehouseOpeningLedger.rows)}`,
);
await db.exec(`
  INSERT INTO "InventoryNodeBalance" (
    "id", "productId", "inventoryLotId", "inventoryOwnerLocationId", "inventoryNodeId",
    "containerId", "storageLocationId", "onHand", "available", "reserved", "damaged",
    "ledgerSequence", "version", "createdAt", "updatedAt"
  ) VALUES (
    '${warehouseInventoryBalanceId}', '${productId}', '${inventoryLotId}',
    '${thirdAvenueLocationId}', '${warehouseLocationId}', '${warehouseContainerId}',
    '${warehouseStorageLocationId}', 5, 5, 0, 0, ${warehouseOpeningLedgerSequence}, 1,
    '${calculatedAt}', '${calculatedAt}'
  )
`);
console.log("PASS warehouse transfer evidence has a certified compatible balance");

await db.exec(`BEGIN`);
try {
  await db.exec(`
    INSERT INTO "WalkingDeliveryQuote" (
      "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
      "normalizedAddressStructured", "customerCoordinates", "postalCode",
      "selectedLocationId", "zoneVersionId", "zoneSetVersionId",
      "feePolicyVersionId", "externalFeePolicyVersionId", "routingProvider",
      "distanceFeet", "durationSeconds", "roundTripDistanceFeet",
      "estimatedRoundTripDurationSeconds", "capacityRequiredSeconds",
      "feeCents", "tierId", "reasonCode", "calculatedAt", "routeCalculatedAt",
      "expiresAt", "inventoryReadinessStatus", "inventoryReadyAt",
      "slotPolicyId", "slotSnapshot", "walkingPublicationId", "correlationId"
    ) VALUES (
      '${aggregateQuoteId}', 'orderpro.walking-delivery-quote.v2',
      'pglite-v4-client', 'pglite-v4-aggregate-balance', '${hash}',
      '${normalized10021Address}'::JSONB, '[-73.9588,40.7710]'::JSONB, '10021',
      'third_avenue', '${zoneVersionId}', '${zoneSetVersionId}', '${feeVersionId}',
      'walking-route-distance-v4-base-10-2026-07-16', 'pglite-walking-router',
      1760, 600, 3520, 1200, 1500, 1000, '${feeTierId}',
      'ELIGIBLE', '${calculatedAt}', '${calculatedAt}',
      '${quoteExpiresAt}', 'READY', NULL,
      '${slotPolicyId}', '${requestedSlotSnapshot}'::JSONB, '${walkingPublicationId}',
      'pglite-v4-aggregate-balance'
    );

    INSERT INTO "WalkingDeliveryQuoteCandidateRoute" (
      "id", "quoteId", "localDeliveryLocationId", "operationalLocationId",
      "externalLocationId", "sequence", "locationPriority", "walkingDistanceFeet",
      "walkingDurationSeconds", "routingProvider", "routingProfile",
      "routeCalculatedAt", "selected", "createdAt"
    ) VALUES (
      '${aggregateRouteId}', '${aggregateQuoteId}', '${thirdAvenueIdentityId}',
      '${thirdAvenueLocationId}', 'third_avenue', 1, 1, 1760, 600,
      'pglite-walking-router', 'walking', '${calculatedAt}', true, '${calculatedAt}'
    );

    INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
      "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
      "readinessStatus", "inventoryOwnerLocationId", "inventoryNodeId", "containerId",
      "storageLocationId", "transferStatus", "earliestReadyAt", "createdAt"
    ) VALUES
      (
        '${aggregateLineOneId}', '${aggregateQuoteId}', 1,
        'pglite-variant-001', '${productId}', 6, 'READY',
        '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${containerId}',
        '${storageLocationId}', 'NOT_REQUIRED', NULL,
        '${calculatedAt}'
      ),
      (
        '${aggregateLineTwoId}', '${aggregateQuoteId}', 2,
        'pglite-variant-001', '${productId}', 6, 'READY',
        '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${containerId}',
        '${storageLocationId}', 'NOT_REQUIRED', NULL,
        '${calculatedAt}'
      );
  `);
  await expectReject(
    "quote inventory rejects stock that is sufficient only by summing two balances/lots",
    () => db.exec(`SET CONSTRAINTS ALL IMMEDIATE`),
    "Quote READY/TRANSFER_REQUIRED inventory requires one sufficient certified compatible balance",
  );
} finally {
  await db.exec(`ROLLBACK`);
}

await db.exec(`
  BEGIN;
  INSERT INTO "WalkingDeliveryQuote" (
    "id", "schemaVersion", "clientId", "idempotencyKey", "requestHash",
    "normalizedAddressStructured", "customerCoordinates", "postalCode",
    "selectedLocationId", "zoneVersionId", "zoneSetVersionId",
    "feePolicyVersionId", "externalFeePolicyVersionId", "routingProvider",
    "distanceFeet", "durationSeconds", "roundTripDistanceFeet",
    "estimatedRoundTripDurationSeconds", "capacityRequiredSeconds",
    "feeCents", "tierId", "reasonCode", "calculatedAt", "routeCalculatedAt",
    "expiresAt", "inventoryReadinessStatus", "inventoryReadyAt",
    "slotPolicyId", "slotSnapshot", "walkingPublicationId", "correlationId"
  ) VALUES (
    '${transferNoSlotsQuoteId}', 'orderpro.walking-delivery-quote.v2',
    'pglite-v4-client', 'pglite-v4-transfer-no-slots', '${hash}',
    '${normalized10021Address}'::JSONB, '[-73.9588,40.7710]'::JSONB, '10021',
    'third_avenue', '${zoneVersionId}', '${zoneSetVersionId}', '${feeVersionId}',
    'walking-route-distance-v4-base-10-2026-07-16', 'pglite-walking-router',
    1760, 600, 3520, 1200, 1500, 1000, '${feeTierId}',
    'NO_SLOTS_FOR_SELECTED_LOCATION', '${calculatedAt}', '${calculatedAt}',
    '${quoteExpiresAt}', 'TRANSFER_REQUIRED', '${transferReadyAt}',
    '${slotPolicyId}', '[]'::JSONB, '${walkingPublicationId}',
    'pglite-v4-transfer-no-slots'
  );

  INSERT INTO "WalkingDeliveryQuoteCandidateRoute" (
    "id", "quoteId", "localDeliveryLocationId", "operationalLocationId",
    "externalLocationId", "sequence", "locationPriority", "walkingDistanceFeet",
    "walkingDurationSeconds", "routingProvider", "routingProfile",
    "routeCalculatedAt", "selected", "createdAt"
  ) VALUES (
    '${transferNoSlotsRouteId}', '${transferNoSlotsQuoteId}', '${thirdAvenueIdentityId}',
    '${thirdAvenueLocationId}', 'third_avenue', 1, 1, 1760, 600,
    'pglite-walking-router', 'walking', '${calculatedAt}', true, '${calculatedAt}'
  );

  INSERT INTO "WalkingDeliveryQuoteInventoryLine" (
    "id", "quoteId", "lineNumber", "variantId", "productId", "quantity",
    "readinessStatus", "inventoryOwnerLocationId", "inventoryNodeId", "containerId",
    "storageLocationId", "transferStatus", "earliestReadyAt", "createdAt"
  ) VALUES (
    '${transferNoSlotsLineId}', '${transferNoSlotsQuoteId}', 1,
    'pglite-variant-001', '${productId}', 1, 'TRANSFER_REQUIRED',
    '${thirdAvenueLocationId}', '${warehouseLocationId}', '${warehouseContainerId}',
    '${warehouseStorageLocationId}', 'TRANSFER_REQUIRED', '${transferReadyAt}',
    '${calculatedAt}'
  );
  COMMIT;
`);

const transferNoSlotsResult = await db.query(`
  SELECT "reasonCode"::TEXT AS "reasonCode", "bookable",
         "inventoryReadinessStatus"::TEXT AS "inventoryStatus",
         "inventoryReadyAt"::TEXT AS "inventoryReadyAt",
         JSONB_ARRAY_LENGTH("slotSnapshot" -> 'slots') AS "slotCount"
  FROM "WalkingDeliveryQuote" WHERE "id" = '${transferNoSlotsQuoteId}'
`);
const transferNoSlots = transferNoSlotsResult.rows[0];
assert(
  transferNoSlots?.reasonCode === "NO_SLOTS_FOR_SELECTED_LOCATION" &&
    transferNoSlots.bookable === false &&
    transferNoSlots.inventoryStatus === "TRANSFER_REQUIRED" &&
    transferNoSlots.slotCount === 0,
  `Unexpected transfer/no-slots outcome: ${JSON.stringify(transferNoSlots)}`,
);
console.log("PASS transfer-ready inventory with no selected-store slots remains a non-bookable no-slots quote");

await db.exec(`
  UPDATE "OperationalLocation"
  SET "code" = 'WH02', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${warehouseLocationId}'
`);
const historicalNodeSnapshotResult = await db.query(`
  SELECT
    line."inventoryOwnerExternalLocationId" AS "ownerExternalId",
    line."inventoryNodeExternalId" AS "nodeExternalId",
    line."snapshot" ->> 'inventoryNodeExternalId' AS "snapshotNodeExternalId",
    location."code" AS "currentNodeExternalId"
  FROM "WalkingDeliveryQuoteInventoryLine" line
  JOIN "OperationalLocation" location ON location."id" = line."inventoryNodeId"
  WHERE line."id" = '${transferNoSlotsLineId}'
`);
const historicalNodeSnapshot = historicalNodeSnapshotResult.rows[0];
assert(
  historicalNodeSnapshot?.ownerExternalId === "third_avenue" &&
    historicalNodeSnapshot.nodeExternalId === "warehouse-englewood" &&
    historicalNodeSnapshot.snapshotNodeExternalId === "warehouse-englewood" &&
    historicalNodeSnapshot.currentNodeExternalId === "WH02",
  `Unexpected historical inventory node snapshot: ${JSON.stringify(historicalNodeSnapshot)}`,
);
console.log("PASS quote inventory external identities remain historical after canonical metadata changes");
await db.exec(`
  UPDATE "OperationalLocation"
  SET "code" = 'WH01', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${warehouseLocationId}'
`);

const capacityHoldId = "97000000-0000-4000-8000-000000000001";
const inventoryReservationId = "97000000-0000-4000-8000-000000000002";
const reservationLineId = "97000000-0000-4000-8000-000000000003";
const holdCreatedAt = "2099-07-20T10:01:00.000Z";
const holdExpiresAt = "2099-07-20T10:11:00.000Z";
const releasedAt = "2099-07-20T10:05:00.000Z";

await db.exec(`
  UPDATE "FeatureFlag"
  SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" IN (
    'local_delivery_v4.hold_writes',
    'local_delivery_v4.inventory_reservation_writes'
  )
`);

await db.exec(`BEGIN`);
try {
  const staleTransactionHoldExpiresAt = new Date(Date.now() + 750);
  const staleTransactionHoldCreatedAt = new Date(
    staleTransactionHoldExpiresAt.getTime() - 600_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await expectReject(
    "capacity hold uses post-slot-lock wall clock instead of transaction-start time",
    () => db.exec(`
      INSERT INTO "WalkingCapacityHold" (
        "id", "quoteId", "capacitySlotId", "clientId", "idempotencyKey", "requestHash",
        "correlationId", "status", "reservedCapacitySeconds", "expiresAt", "version",
        "createdAt", "updatedAt"
      ) VALUES (
        '97000000-0000-4000-8000-000000000020', '${quoteId}', '${capacitySlotId}',
        'pglite-v4-client', 'pglite-v4-stale-transaction-clock', '${hash}',
        'pglite-v4-stale-transaction-clock', 'HELD', 1500,
        '${staleTransactionHoldExpiresAt.toISOString()}', 1,
        '${staleTransactionHoldCreatedAt.toISOString()}',
        '${staleTransactionHoldCreatedAt.toISOString()}'
      )
    `),
    "Cannot hold or confirm expired quote capacity",
  );
} finally {
  await db.exec(`ROLLBACK`);
}

await expectReject(
  "capacity/inventory pair rejects substitution from another certified container",
  () => db.exec(`
    BEGIN;
    INSERT INTO "WalkingCapacityHold" (
      "id", "quoteId", "capacitySlotId", "clientId", "idempotencyKey", "requestHash",
      "correlationId", "status", "reservedCapacitySeconds", "expiresAt", "version",
      "createdAt", "updatedAt"
    ) VALUES (
      '97000000-0000-4000-8000-000000000010', '${quoteId}', '${capacitySlotId}',
      'pglite-v4-client', 'pglite-v4-physical-substitution', '${hash}',
      'pglite-v4-physical-substitution', 'HELD', 1500, '${holdExpiresAt}', 1,
      '${holdCreatedAt}', '${holdCreatedAt}'
    );
    INSERT INTO "WalkingInventoryReservation" (
      "id", "quoteId", "capacityHoldId", "clientId", "idempotencyKey", "requestHash",
      "correlationId", "status", "orderLocationId", "deliveryLocationId",
      "orderLocationExternalId", "deliveryLocationExternalId",
      "orderLocationDecisionCode", "orderLocationDecisionVersion",
      "inventoryAllocationStrategyId", "inventoryAllocationStrategyVersion",
      "expiresAt", "version",
      "createdAt", "updatedAt"
    ) VALUES (
      '97000000-0000-4000-8000-000000000011', '${quoteId}',
      '97000000-0000-4000-8000-000000000010', 'pglite-v4-client',
      'pglite-v4-physical-substitution', '${hash}', 'pglite-v4-physical-substitution',
      'HELD', '${thirdAvenueLocationId}', '${thirdAvenueLocationId}',
      'third_avenue', 'third_avenue', 'selected_delivery_location',
      'order-location-v1', 'exact_quoted_physical_tuple', 'allocation-v1',
      '${holdExpiresAt}', 1,
      '${holdCreatedAt}', '${holdCreatedAt}'
    );
    INSERT INTO "WalkingInventoryReservationLine" (
      "id", "reservationId", "inventoryNodeBalanceId", "lineNumber", "variantId",
      "productId", "inventoryLotId", "quantity", "inventoryOwnerLocationId",
      "inventoryNodeId", "containerId", "storageLocationId", "transferStatus", "createdAt"
    ) VALUES (
      '97000000-0000-4000-8000-000000000012',
      '97000000-0000-4000-8000-000000000011', '${alternateInventoryBalanceId}', 1,
      'pglite-variant-001', '${productId}', '${alternateInventoryLotId}', 1,
      '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${alternateContainerId}',
      '${storageLocationId}', 'NOT_REQUIRED', '${holdCreatedAt}'
    );
    COMMIT;
  `),
  "Reserved inventory must exactly match quoted physical and transfer evidence",
);

await expectReject(
  "capacity hold rejects a slot that was not offered by the exact quote snapshot",
  () => db.exec(`
    INSERT INTO "WalkingCapacityHold" (
      "id", "quoteId", "capacitySlotId", "clientId", "idempotencyKey", "requestHash",
      "correlationId", "status", "reservedCapacitySeconds", "expiresAt", "version",
      "createdAt", "updatedAt"
    ) VALUES (
      '97000000-0000-4000-8000-000000000004', '${quoteId}',
      '97000000-0000-4000-8000-000000000099', 'pglite-v4-client',
      'pglite-v4-wrong-slot', '${hash}', 'pglite-v4-wrong-slot', 'HELD', 1500,
      '${holdExpiresAt}', 1, '${holdCreatedAt}', '${holdCreatedAt}'
    )
  `),
  "Capacity hold must use the exact slot offered by its quote",
);

await db.exec(`
  BEGIN;
  INSERT INTO "WalkingCapacityHold" (
    "id", "quoteId", "capacitySlotId", "clientId", "idempotencyKey", "requestHash",
    "correlationId", "status", "reservedCapacitySeconds", "expiresAt", "version",
    "createdAt", "updatedAt"
  ) VALUES (
    '${capacityHoldId}', '${quoteId}', '${capacitySlotId}', 'pglite-v4-client',
    'pglite-v4-atomic-hold', '${hash}', 'pglite-v4-atomic-hold', 'HELD', 1500,
    '${holdExpiresAt}', 1, '${holdCreatedAt}', '${holdCreatedAt}'
  );

  INSERT INTO "WalkingInventoryReservation" (
    "id", "quoteId", "capacityHoldId", "clientId", "idempotencyKey", "requestHash",
    "correlationId", "status", "orderLocationId", "deliveryLocationId",
    "orderLocationExternalId", "deliveryLocationExternalId",
    "orderLocationDecisionCode", "orderLocationDecisionVersion",
    "inventoryAllocationStrategyId", "inventoryAllocationStrategyVersion",
    "expiresAt", "version",
    "createdAt", "updatedAt"
  ) VALUES (
    '${inventoryReservationId}', '${quoteId}', '${capacityHoldId}', 'pglite-v4-client',
    'pglite-v4-atomic-hold', '${hash}', 'pglite-v4-atomic-hold', 'HELD',
    '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', 'third_avenue', 'third_avenue',
    'selected_delivery_location', 'order-location-v1',
    'exact_quoted_physical_tuple', 'allocation-v1',
    '${holdExpiresAt}', 1, '${holdCreatedAt}', '${holdCreatedAt}'
  );

  INSERT INTO "WalkingInventoryReservationLine" (
    "id", "reservationId", "inventoryNodeBalanceId", "lineNumber", "variantId",
    "productId", "inventoryLotId", "quantity", "inventoryOwnerLocationId",
    "inventoryNodeId", "containerId", "storageLocationId", "transferStatus", "createdAt"
  ) VALUES (
    '${reservationLineId}', '${inventoryReservationId}', '${inventoryBalanceId}', 1,
    'pglite-variant-001', '${productId}', '${inventoryLotId}', 1,
    '${thirdAvenueLocationId}', '${thirdAvenueLocationId}', '${containerId}',
    '${storageLocationId}', 'NOT_REQUIRED', '${holdCreatedAt}'
  );
  COMMIT;
`);

const heldPairResult = await db.query(`
  SELECT
    hold."status"::TEXT AS "holdStatus",
    reservation."status"::TEXT AS "reservationStatus",
    hold."expiresAt" = reservation."expiresAt" AS "sameExpiry",
    reservation."orderLocationDecisionCode",
    reservation."orderLocationDecisionVersion",
    reservation."inventoryAllocationStrategyId",
    reservation."inventoryAllocationStrategyVersion",
    line."warehouseBoxId", line."binId",
    balance."available"::TEXT, balance."reserved"::TEXT,
    balance."version", balance."ledgerSequence"::TEXT AS "ledgerSequence",
    ledger."eventType"::TEXT AS "eventType",
    ledger."businessReferenceType", ledger."businessReferenceId",
    ledger."idempotencyKey",
    ledger."metadata" ->> 'inventoryNodeBalanceId' AS "ledgerBalanceId"
  FROM "WalkingCapacityHold" hold
  JOIN "WalkingInventoryReservation" reservation
    ON reservation."capacityHoldId" = hold."id"
  JOIN "WalkingInventoryReservationLine" line
    ON line."reservationId" = reservation."id"
  JOIN "InventoryNodeBalance" balance
    ON balance."id" = line."inventoryNodeBalanceId"
  JOIN "InventoryLedgerEntry" ledger
    ON ledger."sequence" = balance."ledgerSequence"
  WHERE hold."id" = '${capacityHoldId}'
`);
const heldPair = heldPairResult.rows[0];
assert(
  heldPair?.holdStatus === "HELD" &&
    heldPair.reservationStatus === "HELD" &&
    heldPair.sameExpiry === true &&
    heldPair.orderLocationDecisionCode === "selected_delivery_location" &&
    heldPair.orderLocationDecisionVersion === "order-location-v1" &&
    heldPair.inventoryAllocationStrategyId === "exact_quoted_physical_tuple" &&
    heldPair.inventoryAllocationStrategyVersion === "allocation-v1" &&
    heldPair.warehouseBoxId === "PGLITEBOX1" &&
    heldPair.binId === "PGLITE-BIN" &&
    heldPair.available === "9.000" &&
    heldPair.reserved === "1.000" &&
    heldPair.version === 2 &&
    heldPair.eventType === "RESERVED" &&
    heldPair.businessReferenceType === "WalkingInventoryReservationLine" &&
    heldPair.businessReferenceId === reservationLineId &&
    heldPair.idempotencyKey ===
      `walking-v4:reservation-line:${reservationLineId}:reserved` &&
    heldPair.ledgerBalanceId === inventoryBalanceId,
  `Unexpected held capacity/inventory pair: ${JSON.stringify(heldPair)}`,
);
console.log("PASS exact capacity hold and inventory reservation atomically reserve certified ledger stock");

const reservationDecisionAudit = await db.query(`
  SELECT
    "after" ->> 'orderLocationDecisionCode' AS "orderLocationDecisionCode",
    "after" ->> 'orderLocationDecisionVersion' AS "orderLocationDecisionVersion",
    "after" ->> 'inventoryAllocationStrategyId' AS "inventoryAllocationStrategyId",
    "after" ->> 'inventoryAllocationStrategyVersion' AS "inventoryAllocationStrategyVersion"
  FROM "AuditEvent"
  WHERE "entityType" = 'WalkingInventoryReservation'
    AND "entityId" = '${inventoryReservationId}'
    AND "action" = 'walking_delivery.inventory_reservation.created'
`);
assert(
  reservationDecisionAudit.rows[0]?.orderLocationDecisionCode ===
    "selected_delivery_location" &&
    reservationDecisionAudit.rows[0]?.orderLocationDecisionVersion ===
      "order-location-v1" &&
    reservationDecisionAudit.rows[0]?.inventoryAllocationStrategyId ===
      "exact_quoted_physical_tuple" &&
    reservationDecisionAudit.rows[0]?.inventoryAllocationStrategyVersion ===
      "allocation-v1",
  `Unexpected reservation decision audit: ${JSON.stringify(reservationDecisionAudit.rows)}`,
);
console.log("PASS order-location and inventory-allocation decisions are persisted and audited");

await expectReject(
  "inventory reservation location/allocation decisions are immutable",
  () => db.exec(`
    UPDATE "WalkingInventoryReservation"
    SET "inventoryAllocationStrategyVersion" = 'allocation-v2',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${inventoryReservationId}'
  `),
  "Inventory reservation location/allocation decisions are immutable",
);

await expectReject(
  "future capacity slot cannot close while its exact hold is active",
  () => db.exec(`
    UPDATE "WalkingCapacitySlot"
    SET "status" = 'CLOSED', "version" = 2, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = '${capacitySlotId}'
  `),
  "Cannot close or cancel a future capacity slot with active holds",
);

await db.exec(`
  BEGIN;
  UPDATE "WalkingCapacityHold"
  SET
    "status" = 'RELEASED', "releasedAt" = '${releasedAt}',
    "releaseReason" = 'ORDER_CANCELLED', "version" = 2,
    "updatedAt" = '${releasedAt}'
  WHERE "id" = '${capacityHoldId}';

  UPDATE "WalkingInventoryReservation"
  SET
    "status" = 'RELEASED', "releasedAt" = '${releasedAt}',
    "releaseReason" = 'ORDER_CANCELLED', "version" = 2,
    "updatedAt" = '${releasedAt}'
  WHERE "id" = '${inventoryReservationId}';
  COMMIT;
`);

const releasedPairResult = await db.query(`
  SELECT
    hold."status"::TEXT AS "holdStatus",
    reservation."status"::TEXT AS "reservationStatus",
    hold."releasedAt" = reservation."releasedAt" AS "sameReleaseTime",
    hold."releaseReason"::TEXT AS "holdReason",
    reservation."releaseReason"::TEXT AS "reservationReason",
    balance."available"::TEXT, balance."reserved"::TEXT, balance."version",
    ledger."eventType"::TEXT AS "eventType",
    ledger."businessReferenceType", ledger."businessReferenceId",
    ledger."idempotencyKey",
    ledger."metadata" ->> 'inventoryNodeBalanceId' AS "ledgerBalanceId"
  FROM "WalkingCapacityHold" hold
  JOIN "WalkingInventoryReservation" reservation
    ON reservation."capacityHoldId" = hold."id"
  JOIN "WalkingInventoryReservationLine" line
    ON line."reservationId" = reservation."id"
  JOIN "InventoryNodeBalance" balance
    ON balance."id" = line."inventoryNodeBalanceId"
  JOIN "InventoryLedgerEntry" ledger
    ON ledger."sequence" = balance."ledgerSequence"
  WHERE hold."id" = '${capacityHoldId}'
`);
const releasedPair = releasedPairResult.rows[0];
assert(
  releasedPair?.holdStatus === "RELEASED" &&
    releasedPair.reservationStatus === "RELEASED" &&
    releasedPair.sameReleaseTime === true &&
    releasedPair.holdReason === "ORDER_CANCELLED" &&
    releasedPair.reservationReason === "ORDER_CANCELLED" &&
    releasedPair.available === "10.000" &&
    releasedPair.reserved === "0.000" &&
    releasedPair.version === 3 &&
    releasedPair.eventType === "RESERVATION_RELEASED" &&
    releasedPair.businessReferenceType === "WalkingInventoryReservation" &&
    releasedPair.businessReferenceId === inventoryReservationId &&
    releasedPair.idempotencyKey ===
      `walking-v4:reservation:${inventoryReservationId}:balance:${inventoryBalanceId}:released` &&
    releasedPair.ledgerBalanceId === inventoryBalanceId,
  `Unexpected released capacity/inventory pair: ${JSON.stringify(releasedPair)}`,
);
console.log("PASS synchronized release restores inventory through exact RESERVATION_RELEASED ledger evidence");

await db.exec(`
  UPDATE "WalkingCapacitySlot"
  SET "status" = 'CLOSED', "version" = 2, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '${capacitySlotId}'
`);
const closedSlotResult = await db.query(`
  SELECT "status"::TEXT AS "status", "version"
  FROM "WalkingCapacitySlot" WHERE "id" = '${capacitySlotId}'
`);
assert(
  closedSlotResult.rows[0]?.status === "CLOSED" && closedSlotResult.rows[0]?.version === 2,
  `Expected released slot to close at version 2, got ${JSON.stringify(closedSlotResult.rows)}`,
);
console.log("PASS capacity slot closes only after synchronized capacity and inventory release");

await db.exec(`
  UPDATE "FeatureFlag"
  SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" IN (
    'local_delivery_v4.quote_writes',
    'local_delivery_v4.hold_writes',
    'local_delivery_v4.inventory_reservation_writes'
  )
`);

await db.close();
