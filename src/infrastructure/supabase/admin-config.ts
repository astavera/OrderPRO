import { getSupabasePublicConfig, type SupabasePublicConfig } from "./config";

export type SupabaseAdminConfig = SupabasePublicConfig & { secretKey: string };

export function parseSupabaseAdminSecret(environment: Record<string, string | undefined>) {
  const secretKey = (environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!secretKey || secretKey.includes("[YOUR-") || secretKey.length < 20) return null;
  return secretKey;
}

export function getSupabaseAdminConfig(): SupabaseAdminConfig | null {
  const publicConfig = getSupabasePublicConfig();
  const secretKey = parseSupabaseAdminSecret(process.env);
  return publicConfig && secretKey ? { ...publicConfig, secretKey } : null;
}
