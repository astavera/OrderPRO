export function parseApplicationUrl(environment: Record<string, string | undefined>) {
  const configured = environment.ORDERPRO_APP_URL?.trim();
  const candidate = configured || (environment.NODE_ENV === "development" ? "http://localhost:3001" : "");
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getApplicationUrl() {
  return parseApplicationUrl(process.env);
}
