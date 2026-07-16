import { checkAuthReadiness } from "@/application/health/check-auth-readiness";
import { checkDatabaseReadiness } from "@/application/health/check-database-readiness";
import { supabaseDatabaseProbe } from "@/infrastructure/database/supabase-probe";
import { supabaseAuthProbe } from "@/infrastructure/supabase/auth-probe";

export const dynamic = "force-dynamic";

export async function GET() {
  const [database, auth] = await Promise.all([
    checkDatabaseReadiness(supabaseDatabaseProbe),
    checkAuthReadiness(supabaseAuthProbe),
  ]);
  const ready = database.ready && auth.ready;

  return Response.json(
    {
      service: "orderpro",
      ready,
      checkedAt: database.checkedAt,
      dependencies: {
        "supabase-postgres": database.ready ? { ready: true } : { ready: false, code: database.code },
        "supabase-auth": auth.ready ? { ready: true } : { ready: false, code: auth.code },
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
