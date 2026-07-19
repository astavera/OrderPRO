import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const execFile = promisify(execFileCallback);
const sourceRoot = join(workspace, "src");
const certifierPath = join(workspace, "scripts", "certify-auth0-m2m-token.ts");
const wrapperPath = join(workspace, "scripts", "prompt-auth0-m2m-token.ps1");

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

describe("offline M2M certification boundary", () => {
  it("keeps the pending-only verifier and persistence entry points private", async () => {
    const certifier = await readFile(certifierPath, "utf8");

    expect(certifier).not.toMatch(
      /export\s+(?:async\s+)?function\s+(?:runCertification|main|createPendingCertificationRegistry)\b/,
    );
  });

  it("has no Next.js runtime import of the scripts boundary", async () => {
    const violations: string[] = [];
    for (const path of await sourceFiles(sourceRoot)) {
      const source = await readFile(path, "utf8");
      if (
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'`][^"'`]*scripts[\\/]/.test(
          source,
        )
      ) {
        violations.push(path.slice(workspace.length));
      }
    }

    expect(violations).toEqual([]);
  });

  it("isolates the child environment and rejects command-line token input", async () => {
    const [wrapper, packageJson] = await Promise.all([
      readFile(wrapperPath, "utf8"),
      readFile(join(workspace, "package.json"), "utf8"),
    ]);

    expect(wrapper).toContain("$processInfo.EnvironmentVariables.Clear()");
    expect(wrapper).toContain("ORDERPRO_CERTIFICATION_GIT_EXECUTABLE");
    expect(wrapper).toContain("ORDERPRO_CERTIFICATION_EXPECTED_COMMIT");
    expect(wrapper).toContain("ORDERPRO_CERTIFICATION_EXPECTED_TREE");
    expect(wrapper).toContain("120000 - [int]$deadline.ElapsedMilliseconds");
    expect(wrapper).toContain("WriteAsync(");
    expect(wrapper).not.toContain("BaseStream.Write(");
    expect(wrapper).not.toContain("--env-file");
    expect(wrapper).not.toContain("PtrToStringBSTR");
    expect(wrapper).not.toContain("ReadAllLines");
    expect(wrapper).toContain(
      "Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop",
    );
    expect(wrapper).toContain("[System.Windows.Forms.Clipboard]::Clear()");
    expect(wrapper).not.toContain('Set-Clipboard -Value ""');
    expect(wrapper.indexOf("$args.Count")).toBeLessThan(wrapper.indexOf("Read-Host"));
    expect(wrapper.indexOf("$forbiddenInheritedEnvironment")).toBeLessThan(
      wrapper.indexOf("Read-Host"),
    );
    expect(wrapper.indexOf("ZeroFreeBSTR")).toBeLessThan(
      wrapper.indexOf("$process.Start()"),
    );
    expect(wrapper.indexOf("Read-Host")).toBeLessThan(
      wrapper.indexOf("$postPromptGitStatus"),
    );
    expect(packageJson).toContain(
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prompt-auth0-m2m-token.ps1",
    );

    const marker = "SHOULD_NOT_ECHO_ARGUMENT_MARKER";
    try {
      await execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          wrapperPath,
          marker,
        ],
        { cwd: workspace, timeout: 10_000, windowsHide: true },
      );
      throw new Error("Wrapper unexpectedly accepted a command-line argument.");
    } catch (error) {
      const result = error as Error & {
        readonly code?: number | string;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.code).not.toBe(0);
      expect(output).toContain("accepts no arguments");
      expect(output).not.toContain(marker);
    }
  }, 15_000);
});
