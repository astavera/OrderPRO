import { checkDatabaseReadiness } from "@/application/health/check-database-readiness";
import { supabaseDatabaseProbe } from "@/infrastructure/database/supabase-probe";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await checkDatabaseReadiness(supabaseDatabaseProbe);

  return Response.json(
    { service: "orderpro", dependency: "supabase-postgres", ...readiness },
    {
      status: readiness.ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
