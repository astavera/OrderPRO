import "server-only";
import type { AuthProbe } from "@/application/health/check-auth-readiness";
import { getSupabasePublicConfig } from "./config";

export const supabaseAuthProbe: AuthProbe = {
  async execute() {
    const config = getSupabasePublicConfig();
    if (!config) throw new Error("AUTH_NOT_CONFIGURED");

    const response = await fetch(`${config.url}/auth/v1/health`, {
      cache: "no-store",
      headers: { apikey: config.publishableKey },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) throw new Error("AUTH_HEALTH_CHECK_FAILED");
  },
};
