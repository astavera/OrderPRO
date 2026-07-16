import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/application/auth/current-principal";
import { hasPermission } from "@/application/auth/permissions";
import { activeLocationIds } from "@/application/auth/principal-access";
import { visibleBoxWhere } from "@/application/boxes/box-visibility";
import { normalizeBoxCode } from "@/domain/inventory/box-code";
import { prisma } from "@/infrastructure/database/prisma";
import { CreateBoxForm } from "./create-box-form";
import { openBoxAction } from "./lookup-action";

export const dynamic = "force-dynamic";

type BoxesPageProps = {
  searchParams: Promise<{ q?: string | string[] }>;
};

export default async function BoxesPage({ searchParams }: BoxesPageProps) {
  const { account } = await requirePermission("boxes.view");
  const canMutateBoxes = hasPermission(account.roles.map(({ role }) => role), "boxes.mutate");
  const locationIds = activeLocationIds(account);
  const rawQuery = (await searchParams).q;
  const query = normalizeBoxCode(Array.isArray(rawQuery) ? rawQuery[0] : rawQuery ?? "").slice(0, 16);
  const visibility = visibleBoxWhere(locationIds);
  const boxWhere: Prisma.ContainerWhereInput = query
    ? { AND: [visibility, { code: { contains: query, mode: "insensitive" } }] }
    : visibility;

  const [flag, locations, boxes] = await Promise.all([
    prisma.featureFlag.findUnique({ where: { key: "warehouse.box_creation" } }),
    prisma.operationalLocation.findMany({
      where: { id: { in: locationIds }, active: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.container.findMany({
      where: boxWhere,
      orderBy: [{ updatedAt: "desc" }, { code: "asc" }],
      take: 25,
      include: {
        ownerLocation: { select: { code: true } },
        currentLocation: { select: { code: true } },
        manifests: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, status: true },
        },
      },
    }),
  ]);

  return (
    <section>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Warehouse</p>
      <h1 className="mt-2 text-4xl font-semibold">Boxes</h1>
      <p className="mt-3 text-slate-400">Create and track owner-pure physical containers.</p>

      <form action={openBoxAction} className="mt-8 flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:flex-row">
        <label className="grid flex-1 gap-2 text-sm font-medium" htmlFor="box-query">
          Scan or enter a box code
          <input
            autoComplete="off"
            autoFocus
            className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono uppercase outline-none focus:border-emerald-400"
            defaultValue={query}
            id="box-query"
            maxLength={16}
            name="q"
            placeholder="BX-..."
          />
        </label>
        <div className="flex items-end gap-3">
          <button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950" type="submit">Open box</button>
          {query ? <Link className="rounded-xl border border-slate-700 px-4 py-3 text-sm" href="/operations/boxes">Clear</Link> : null}
        </div>
      </form>

      {canMutateBoxes && flag?.enabled ? (
        <div className="mt-8"><CreateBoxForm locations={locations} /></div>
      ) : canMutateBoxes ? (
        <div className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-6 text-amber-200">Box creation is locked.</div>
      ) : (
        <div className="mt-8 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-300">You have read-only access to boxes.</div>
      )}

      <div className="mt-8 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Visible boxes</h2>
          <p className="mt-1 text-sm text-slate-400">Boxes owned by or physically present at your assigned locations.</p>
        </div>
        <p className="text-sm text-slate-500">{boxes.length} result{boxes.length === 1 ? "" : "s"}{query ? ` for ${query}` : ""}</p>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Boxes visible at the user&apos;s assigned operational locations</caption>
          <thead className="bg-slate-900 text-slate-400">
            <tr><th className="px-4 py-3" scope="col">Box ID</th><th className="px-4 py-3" scope="col">Owner</th><th className="px-4 py-3" scope="col">Physical</th><th className="px-4 py-3" scope="col">Status</th><th className="px-4 py-3" scope="col">Manifest</th><th className="px-4 py-3" scope="col"><span className="sr-only">Open</span></th></tr>
          </thead>
          <tbody>
            {boxes.map((box) => (
              <tr className="border-t border-slate-800" key={box.id}>
                <td className="px-4 py-3 font-mono font-semibold text-emerald-300"><Link className="hover:text-emerald-200" href={`/operations/boxes/${box.code}`}>{box.code}</Link></td>
                <td className="px-4 py-3">{box.ownerLocation.code}</td>
                <td className="px-4 py-3">{box.currentLocation.code}</td>
                <td className="px-4 py-3">{box.status}</td>
                <td className="px-4 py-3">v{box.manifests[0]?.version ?? 1} · {box.manifests[0]?.status ?? "DRAFT"}</td>
                <td className="px-4 py-3 text-right"><Link className="font-medium text-emerald-300 hover:text-emerald-200" href={`/operations/boxes/${box.code}`}>Details</Link></td>
              </tr>
            ))}
            {boxes.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={6}>No boxes match this location scope and search.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
