export type SupabasePublicConfig = { url: string; publishableKey: string };

export function parseSupabasePublicConfig(environment: Record<string, string | undefined>): SupabasePublicConfig | null {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey || publishableKey.includes("[YOUR-") || publishableKey.length < 20) return null;

  try {
    const parsedUrl = new URL(url);
    const localHttp = parsedUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !localHttp) return null;
  } catch {
    return null;
  }

  return { url, publishableKey };
}

export function getSupabasePublicConfig() {
  return parseSupabasePublicConfig(process.env);
}
