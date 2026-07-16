import { requirePrincipal } from "@/application/auth/current-principal";
import { prisma } from "@/infrastructure/database/prisma";
import { CreateBoxForm } from "./create-box-form";

export const dynamic = "force-dynamic";

export default async function BoxesPage() {
  const { account } = await requirePrincipal();
  const locationIds = account.locations.map(({ locationId }) => locationId);
  const [flag, locations, boxes] = await Promise.all([
    prisma.featureFlag.findUnique({ where: { key: "warehouse.box_creation" } }),
    prisma.operationalLocation.findMany({ where: { id: { in: locationIds }, active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.container.findMany({ where: { ownerLocationId: { in: locationIds }, type: "BOX" }, orderBy: { createdAt: "desc" }, take: 25, include: { ownerLocation: { select: { code: true } }, currentLocation: { select: { code: true } }, manifests: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } } } }),
  ]);
  return <section><p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Warehouse</p><h1 className="mt-2 text-4xl font-semibold">Boxes</h1><p className="mt-3 text-slate-400">Create and track owner-pure physical containers.</p>{flag?.enabled ? <div className="mt-8"><CreateBoxForm locations={locations} /></div> : <div className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-6 text-amber-200">Box creation is locked.</div>}<div className="mt-8 overflow-hidden rounded-2xl border border-slate-800"><table className="w-full text-left text-sm"><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3">Box ID</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">Physical</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Manifest</th></tr></thead><tbody>{boxes.map((box) => <tr className="border-t border-slate-800" key={box.id}><td className="px-4 py-3 font-mono font-semibold text-emerald-300">{box.code}</td><td className="px-4 py-3">{box.ownerLocation.code}</td><td className="px-4 py-3">{box.currentLocation.code}</td><td className="px-4 py-3">{box.status}</td><td className="px-4 py-3">v{box.manifests[0]?.version ?? 1} · {box.manifests[0]?.status ?? "DRAFT"}</td></tr>)}{boxes.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={5}>No boxes yet.</td></tr> : null}</tbody></table></div></section>;
}
