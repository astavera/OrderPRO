import { requirePermission } from "@/application/auth/current-principal";
import { activeLocationIds } from "@/application/auth/principal-access";
import { prisma } from "@/infrastructure/database/prisma";

export const dynamic = "force-dynamic";

export default async function OperationsDashboard() {
  const { account } = await requirePermission("dashboard.view");
  const locationIds = activeLocationIds(account);
  const [locations, flags] = await Promise.all([
    prisma.operationalLocation.findMany({ where: { id: { in: locationIds } }, orderBy: { code: "asc" }, select: { code: true, name: true, type: true, active: true } }),
    prisma.featureFlag.findMany({ orderBy: { key: "asc" }, select: { key: true, enabled: true } }),
  ]);
  return <div><p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Operations overview</p><h1 className="mt-2 text-4xl font-semibold">Welcome, {account.displayName}</h1><p className="mt-3 text-slate-400">Foundation status across authorized operations.</p><section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{locations.map((location) => <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5" key={location.code}><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{location.code}</h2><span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">{location.active ? "Active" : "Inactive"}</span></div><p className="mt-2 text-slate-300">{location.name}</p><p className="mt-1 text-sm text-slate-500">{location.type}</p></article>)}</section><section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-xl font-semibold">Production gates</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{flags.map((flag) => <div className="flex items-center justify-between rounded-xl bg-slate-950 p-3" key={flag.key}><span className="text-sm text-slate-300">{flag.key}</span><span className={flag.enabled ? "text-emerald-300" : "text-amber-300"}>{flag.enabled ? "Enabled" : "Locked"}</span></div>)}</div></section></div>;
}
