import { describe, expect, it } from "vitest";
import { parseSupabasePublicConfig } from "./config";

describe("Supabase public config", () => {
  it("normalizes a valid hosted configuration", () => {
    expect(
      parseSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_URL: " https://project.supabase.co ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ` ${"k".repeat(24)} `,
      }),
    ).toEqual({ url: "https://project.supabase.co", publishableKey: "k".repeat(24) });
  });

  it("allows local Supabase over HTTP", () => {
    expect(
      parseSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k".repeat(24),
      }),
    ).not.toBeNull();
  });

  it("rejects placeholders, malformed URLs and short keys", () => {
    expect(parseSupabasePublicConfig({})).toBeNull();
    expect(
      parseSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k".repeat(24),
      }),
    ).toBeNull();
    expect(
      parseSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "[YOUR-PUBLISHABLE-KEY]",
      }),
    ).toBeNull();
  });
});
