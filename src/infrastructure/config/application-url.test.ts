import { describe, expect, it } from "vitest";
import { parseApplicationUrl } from "./application-url";

describe("application URL", () => {
  it("normalizes a configured HTTPS origin", () => {
    expect(parseApplicationUrl({ ORDERPRO_APP_URL: "https://orderpro.example.com/path" })).toBe(
      "https://orderpro.example.com",
    );
  });

  it("uses localhost only in development", () => {
    expect(parseApplicationUrl({ NODE_ENV: "development" })).toBe("http://localhost:3001");
    expect(parseApplicationUrl({ NODE_ENV: "production" })).toBeNull();
  });

  it("rejects insecure non-local origins", () => {
    expect(parseApplicationUrl({ ORDERPRO_APP_URL: "http://example.com" })).toBeNull();
  });
});
