import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdminConfig } from "./admin-config";

export function createSupabaseAdminClient() {
  const config = getSupabaseAdminConfig();
  if (!config) return null;

  return createClient(config.url, config.secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

export function isSupabaseAdminConfigured() {
  return getSupabaseAdminConfig() !== null;
}
