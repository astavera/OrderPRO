import { describe, expect, it } from "vitest";
import { parseSupabaseAdminSecret } from "./admin-config";

describe("Supabase admin config", () => {
  it("prefers the current secret key", () => {
    expect(
      parseSupabaseAdminSecret({
        SUPABASE_SECRET_KEY: `sb_secret_${"x".repeat(24)}`,
        SUPABASE_SERVICE_ROLE_KEY: "legacy-key-that-is-long-enough",
      }),
    ).toBe(`sb_secret_${"x".repeat(24)}`);
  });

  it("supports the legacy service-role key during migration", () => {
    expect(parseSupabaseAdminSecret({ SUPABASE_SERVICE_ROLE_KEY: "legacy-key-that-is-long-enough" })).toBe(
      "legacy-key-that-is-long-enough",
    );
  });

  it("rejects missing and placeholder secrets", () => {
    expect(parseSupabaseAdminSecret({})).toBeNull();
    expect(parseSupabaseAdminSecret({ SUPABASE_SECRET_KEY: "[YOUR-SECRET-KEY]" })).toBeNull();
  });
});
