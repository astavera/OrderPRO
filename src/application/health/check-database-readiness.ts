export type DatabaseProbe = {
  execute(): Promise<void>;
};

export type DatabaseReadiness =
  | { ready: true; checkedAt: string }
  | { ready: false; checkedAt: string; code: "DATABASE_UNAVAILABLE" };

export async function checkDatabaseReadiness(probe: DatabaseProbe, now = () => new Date()): Promise<DatabaseReadiness> {
  const checkedAt = now().toISOString();

  try {
    await probe.execute();
    return { ready: true, checkedAt };
  } catch {
    return { ready: false, checkedAt, code: "DATABASE_UNAVAILABLE" };
  }
}
