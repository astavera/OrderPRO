import Link from "next/link";
import type { ReactNode } from "react";
import { requirePrincipal } from "@/application/auth/current-principal";
import { hasPermission } from "@/application/auth/permissions";
import { logout } from "@/app/(auth)/login/actions";

export default async function OperationsLayout({ children }: { children: ReactNode }) {
  const { account } = await requirePrincipal();
  const roles = account.roles.map(({ role }) => role);
  const navigation = [
    { href: "/operations", label: "Overview", allowed: true },
    { href: "/operations/boxes", label: "Boxes", allowed: hasPermission(roles, "boxes.view") },
    { href: "/operations/inventory", label: "Inventory", allowed: hasPermission(roles, "inventory.view") },
  ].filter((item) => item.allowed);

  return <div className="min-h-screen bg-slate-950 text-slate-100"><header className="border-b border-slate-800 bg-slate-950/95"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Modern State</p><Link className="text-2xl font-semibold" href="/operations">OrderPRO</Link></div><div className="flex items-center gap-4"><div className="text-right text-sm"><p className="font-medium">{account.displayName}</p><p className="text-slate-400">{account.locations.map(({ location }) => location.code).join(" · ")}</p></div><form action={logout}><button className="rounded-lg border border-slate-700 px-3 py-2 text-sm" type="submit">Sign out</button></form></div></div></header><div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[220px_1fr]"><nav className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Operations">{navigation.map((item) => <Link className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm font-medium hover:border-emerald-400/50" href={item.href} key={item.href}>{item.label}</Link>)}</nav><main>{children}</main></div></div>;
}
