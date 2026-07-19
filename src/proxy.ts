import { NextResponse, type NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/infrastructure/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Versioned machine APIs authenticate independently. Human Supabase cookies
  // are deliberately not refreshed or accepted as machine credentials.
  if (
    request.nextUrl.pathname.startsWith("/v1/") ||
    request.nextUrl.pathname.startsWith("/api/v1/")
  ) {
    return NextResponse.next({ request });
  }
  return refreshSupabaseSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
