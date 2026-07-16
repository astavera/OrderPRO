import { describe, expect, it } from "vitest";
import {
  authenticationFailureMessage,
  classifyAuthenticationError,
  parseLoginCredentials,
} from "./password-login";

describe("password login", () => {
  it("normalizes email without changing the password", () => {
    expect(parseLoginCredentials({ email: "  OWNER@Example.com ", password: " pass phrase " })).toEqual({
      success: true,
      credentials: { email: "owner@example.com", password: " pass phrase " },
    });
  });

  it("accepts any non-empty existing password", () => {
    expect(parseLoginCredentials({ email: "owner@example.com", password: "short" }).success).toBe(true);
  });

  it("rejects malformed credentials", () => {
    expect(parseLoginCredentials({ email: "not-an-email", password: "" })).toEqual({ success: false });
    expect(parseLoginCredentials({ email: "owner@example.com", password: "x".repeat(129) })).toEqual({ success: false });
  });

  it("separates credential, configuration and transient failures", () => {
    expect(classifyAuthenticationError({ code: "invalid_credentials", status: 400 })).toBe("INVALID_CREDENTIALS");
    expect(classifyAuthenticationError({ status: 401 })).toBe("CONFIGURATION_ERROR");
    expect(classifyAuthenticationError({ name: "AuthRetryableFetchError", status: 503 })).toBe("SERVICE_UNAVAILABLE");
    expect(classifyAuthenticationError({ code: "over_request_rate_limit", status: 429 })).toBe("RATE_LIMITED");
  });

  it("returns stable public messages without provider details", () => {
    expect(authenticationFailureMessage("CONFIGURATION_ERROR")).toBe(
      "Sign-in is not configured correctly. Contact an administrator.",
    );
    expect(authenticationFailureMessage("UNKNOWN")).not.toContain("Supabase");
  });
});
