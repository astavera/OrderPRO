import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/infrastructure/database/prisma";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";
import { hasPermission, type Permission } from "./permissions";
import { getAccountAccessStatus } from "./principal-access";

export const getCurrentPrincipal = cache(async () => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const account = await prisma.user.findUnique({
    where: { subject: data.user.id },
    include: { roles: true, locations: { include: { location: true } } },
  });
  const accessStatus = getAccountAccessStatus(account);
  if (accessStatus !== "ACTIVE") return { authUser: data.user, account: null, accessStatus };
  return { authUser: data.user, account, accessStatus };
});

export async function requirePrincipal() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const account = principal.account;
  if (!account) redirect("/access-pending");
  return { ...principal, account };
}

export async function requirePermission(permission: Permission) {
  const principal = await requirePrincipal();
  const roles = principal.account.roles.map(({ role }) => role);
  if (!hasPermission(roles, permission)) redirect("/operations");
  return principal;
}
