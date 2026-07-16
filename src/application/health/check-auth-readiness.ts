export type AuthProbe = {
  execute(): Promise<void>;
};

export type AuthReadiness =
  | { ready: true; checkedAt: string }
  | { ready: false; checkedAt: string; code: "AUTH_UNAVAILABLE" };

export async function checkAuthReadiness(probe: AuthProbe, now = () => new Date()): Promise<AuthReadiness> {
  const checkedAt = now().toISOString();

  try {
    await probe.execute();
    return { ready: true, checkedAt };
  } catch {
    return { ready: false, checkedAt, code: "AUTH_UNAVAILABLE" };
  }
}
