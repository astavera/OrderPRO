import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/infrastructure/database/prisma";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";

export async function getCurrentPrincipal() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const account = await prisma.user.findUnique({
    where: { subject: data.user.id },
    include: { roles: true, locations: { include: { location: true } } },
  });
  if (!account?.active) return { authUser: data.user, account: null };
  return { authUser: data.user, account };
}

export async function requirePrincipal() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (!principal.account) redirect("/access-pending");
  return principal;
}
