import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const commandPath = join(workspace, "scripts", "approve-auth0-m2m-staging.mjs");
const wrapperPath = join(workspace, "scripts", "approve-auth0-m2m-staging.ps1");
const certifierPath = join(workspace, "scripts", "certify-auth0-m2m-token.ts");

describe("offline M2M approval boundary", () => {
  it("records approval without exposing an activation or runtime bypass", async () => {
    const [command, wrapper, packageJson] = await Promise.all([
      readFile(commandPath, "utf8"),
      readFile(wrapperPath, "utf8"),
      readFile(join(workspace, "package.json"), "utf8"),
    ]);

    expect(command).toContain("record_staging_machine_authorization_approval(");
    expect(command).toContain('result: "APPROVED_PENDING_ACTIVATION"');
    expect(command).toContain('clientStatus: pendingStatus');
    expect(command).toContain('credentialStatus: pendingStatus');
    expect(command).toContain('grantStatus: pendingStatus');
    expect(command).toContain('m2mAuthMode: "DISABLED"');
    expect(command).toContain("localDeliveryV4ApiEnabled: false");
    expect(command).toContain("activationBlockerCount: 3");
    expect(command.match(/machine_client_no_activation/g)?.length).toBe(2);
    expect(command).not.toMatch(/\.machine(?:Client|Credential|ClientGrant)\.(?:update|upsert|create|delete)/);
    expect(command).not.toMatch(/\bUPDATE\s+"?Machine(?:Client|Credential|ClientGrant)/i);
    expect(command).toContain('approvalAudit.action !== "m2m.client.authorization_approved"');
    expect(command).toContain('FROM "MachineAuthorizationApproval"');
    expect(command).toContain("containsSensitiveEvidence(approval.grantVersions)");

    expect(wrapper).toContain("$processInfo.EnvironmentVariables.Clear()");
    expect(wrapper).toContain('ORDERPRO_M2M_AUTH_MODE"] -ne "DISABLED"');
    expect(wrapper).toContain('ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED"] -ne "false"');
    expect(wrapper).not.toMatch(/ClientSecret|AccessToken|ManagementApiToken/);
    expect(packageJson).not.toContain("m2m:approve");
  });

  it("keeps the approval verifier digest aligned with the certified verifier set", async () => {
    const [command, certifier] = await Promise.all([
      readFile(commandPath, "utf8"),
      readFile(certifierPath, "utf8"),
    ]);
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

    for (const path of verifierFiles) {
      expect(command).toContain(`"${path}"`);
      expect(certifier).toContain(`"${path}"`);
    }
    expect(certifier).not.toContain("approve-auth0-m2m-staging");
    expect(command).toContain("evidence.verifierDigestSha256 !== initialDigest");
    expect(command).toContain("isAncestor(evidence.sourceCommitSha");
    expect(command).toContain("const canonicalEvidence = {");
    expect(command).toContain("calculatedDigest !== evidence.evidenceDigestSha256");
    expect(command).toContain("entityId: evidence.machineClientId");
  });

  it("attests the clean commit in both wrapper and child around the DB transaction", async () => {
    const [command, wrapper] = await Promise.all([
      readFile(commandPath, "utf8"),
      readFile(wrapperPath, "utf8"),
    ]);

    expect(wrapper).toContain("status --porcelain=v1 --untracked-files=all");
    expect(wrapper).toContain("ORDERPRO_APPROVAL_EXPECTED_COMMIT");
    expect(wrapper).toContain("ORDERPRO_APPROVAL_EXPECTED_TREE");
    expect(command).toContain('["status", "--porcelain=v1", "--untracked-files=all"]');
    expect(command.match(/workspaceAttestation\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(command).toContain("finalDigest !== initialDigest");
    expect(command).toContain('isolationLevel: "Serializable"');
  });

  it("rejects every command-line argument before reading configuration or DB state", async () => {
    const marker = "SHOULD_NOT_ECHO_APPROVAL_ARGUMENT_MARKER";
    try {
      await execFile(process.execPath, [commandPath, marker], {
        cwd: workspace,
        timeout: 10_000,
        windowsHide: true,
      });
      throw new Error("Approval command unexpectedly accepted an argument.");
    } catch (error) {
      const result = error as Error & {
        readonly code?: number | string;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("APPROVAL_INPUT_INVALID");
      expect(output).not.toContain(marker);
    }
  });

  it("does not expose a PowerShell parameter for a token or secret", async () => {
    const marker = "SHOULD_NOT_ECHO_SECRET_PARAMETER_MARKER";
    try {
      await execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          wrapperPath,
          "-AccessToken",
          marker,
        ],
        { cwd: workspace, timeout: 10_000, windowsHide: true },
      );
      throw new Error("Approval wrapper unexpectedly accepted an access token.");
    } catch (error) {
      const result = error as Error & {
        readonly code?: number | string;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("parameter cannot be found");
      expect(output).not.toContain(marker);
    }
  }, 15_000);

  it("rejects an inherited token without echoing it or reaching the database", async () => {
    const marker = "INHERITED_AUTH0_TOKEN_MUST_NOT_ESCAPE";
    try {
      await execFile(process.execPath, [commandPath], {
        cwd: workspace,
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://unreachable.invalid/orderpro",
          ORDERPRO_M2M_AUTH_MODE: "DISABLED",
          ORDERPRO_RUNTIME_ENVIRONMENT: "STAGING",
          ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED: "false",
          ORDERPRO_M2M_ISSUER: "https://example.us.auth0.com/",
          ORDERPRO_M2M_AUDIENCE:
            "https://api.orderpro.internal/local-delivery/staging",
          ORDERPRO_M2M_JWKS_URI:
            "https://example.us.auth0.com/.well-known/jwks.json",
          ORDERPRO_M2M_ALLOWED_ALGORITHM: "RS256",
          ORDERPRO_APPROVAL_ACTOR_USER_ID:
            "10000000-0000-4000-8000-000000000001",
          ORDERPRO_APPROVAL_REASON:
            "Owner reviewed the certified STAGING authorization evidence.",
          ORDERPRO_APPROVAL_CERTIFICATION_AUDIT_EVENT_ID:
            "10000000-0000-4000-8000-000000000002",
          ORDERPRO_APPROVAL_EVIDENCE_DIGEST_SHA256: "a".repeat(64),
          AUTH0_ACCESS_TOKEN: marker,
        },
      });
      throw new Error("Approval command unexpectedly accepted an inherited token.");
    } catch (error) {
      const result = error as Error & {
        readonly code?: number | string;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("UNSAFE_APPROVAL_ENVIRONMENT");
      expect(output).not.toContain(marker);
      expect(output).not.toContain("unreachable.invalid");
    }
  });
});
