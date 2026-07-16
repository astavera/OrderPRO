import { z } from "zod";

const loginCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export type LoginCredentials = z.infer<typeof loginCredentialsSchema>;

export type AuthenticationFailure =
  | "INVALID_CREDENTIALS"
  | "EMAIL_NOT_CONFIRMED"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "UNKNOWN";

export type AuthenticationProviderError = {
  code?: string;
  name?: string;
  status?: number;
};

export function parseLoginCredentials(input: unknown) {
  const result = loginCredentialsSchema.safeParse(input);

  return result.success
    ? ({ success: true, credentials: result.data } as const)
    : ({ success: false } as const);
}

export function classifyAuthenticationError(error: AuthenticationProviderError): AuthenticationFailure {
  if (error.code === "invalid_credentials" || error.code === "user_not_found") return "INVALID_CREDENTIALS";
  if (error.code === "email_not_confirmed") return "EMAIL_NOT_CONFIRMED";
  if (error.code === "over_request_rate_limit" || error.status === 429) return "RATE_LIMITED";
  if (error.code === "no_authorization" || error.code === "bad_jwt" || error.status === 401) return "CONFIGURATION_ERROR";
  if (
    error.name === "AuthRetryableFetchError" ||
    error.code === "request_timeout" ||
    error.code === "hook_timeout" ||
    error.code === "hook_timeout_after_retry" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "SERVICE_UNAVAILABLE";
  }
  return "UNKNOWN";
}

export function authenticationFailureMessage(failure: AuthenticationFailure) {
  switch (failure) {
    case "INVALID_CREDENTIALS":
      return "The email or password is incorrect.";
    case "EMAIL_NOT_CONFIRMED":
      return "Confirm your email address before signing in.";
    case "RATE_LIMITED":
      return "Too many sign-in attempts. Wait a moment and try again.";
    case "CONFIGURATION_ERROR":
      return "Sign-in is not configured correctly. Contact an administrator.";
    case "SERVICE_UNAVAILABLE":
      return "The authentication service is temporarily unavailable. Try again.";
    default:
      return "Sign-in could not be completed. Try again.";
  }
}
