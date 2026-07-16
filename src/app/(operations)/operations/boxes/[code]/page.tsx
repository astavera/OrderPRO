import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/application/auth/current-principal";
import { activeLocationIds } from "@/application/auth/principal-access";
import { getBoxDetail } from "@/application/boxes/get-box-detail";
import { prisma } from "@/infrastructure/database/prisma";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: Date | null) {
  return value ? dateFormatter.format(value) : "—";
}

export default async function BoxDetailPage({ params }: PageProps<"/operations/boxes/[code]">) {
  const { account } = await requirePermission("boxes.view");
  const locationIds = activeLocationIds(account);
  const { code } = await params;
  const [box, workflowFlags] = await Promise.all([
    getBoxDetail(code, locationIds),
    prisma.featureFlag.findMany({
      where: { key: { in: ["inventory.mutations", "warehouse.box_workflow"] } },
      orderBy: { key: "asc" },
      select: { key: true, enabled: true },
    }),
  ]);

  if (!box) notFound();
  const manifest = box.manifests[0];

  return (
    <section>
      <Link className="text-sm text-emerald-300 hover:text-emerald-200" href="/operations/boxes">← Boxes</Link>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Box detail</p>
          <h1 className="mt-2 font-mono text-4xl font-semibold">{box.code}</h1>
          <p className="mt-3 text-slate-400">Read-only operational record across the box lifecycle.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-sm font-medium text-emerald-300">{box.status}</span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">Version {box.version}</span>
        </div>
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Box locations and timestamps">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Commercial owner</p><p className="mt-2 text-xl font-semibold">{box.ownerLocation.code}</p><p className="mt-1 text-sm text-slate-500">{box.ownerLocation.name} · {box.ownerLocation.type}</p></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Physical location</p><p className="mt-2 text-xl font-semibold">{box.currentLocation.code}</p><p className="mt-1 text-sm text-slate-500">{box.currentLocation.name} · {box.currentLocation.type}</p></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Storage location</p><p className="mt-2 text-xl font-semibold">{box.storageLocation?.code ?? "Unassigned"}</p><p className="mt-1 text-sm text-slate-500">{box.storageLocation?.name ?? "No bin or area assigned"}</p></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Last updated</p><p className="mt-2 text-lg font-semibold">{formatDate(box.updatedAt)}</p><p className="mt-1 text-sm text-slate-500">Created {formatDate(box.createdAt)}</p></article>
      </section>

      <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h2 className="text-2xl font-semibold">Workflow gates</h2><p className="mt-1 text-sm text-slate-400">Content changes stay unavailable until catalog and transactional scan controls are certified.</p></div>
          <div className="flex flex-wrap gap-2">{workflowFlags.map((flag) => <span className={flag.enabled ? "rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300" : "rounded-full bg-amber-400/10 px-3 py-1 text-xs text-amber-200"} key={flag.key}>{flag.key}: {flag.enabled ? "Enabled" : "Locked"}</span>)}</div>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold">Current contents</h2><p className="mt-1 text-sm text-slate-400">Projection rebuilt from the append-only inventory ledger.</p></div><p className="text-sm text-slate-500">{box.contentProjection.length} lot{box.contentProjection.length === 1 ? "" : "s"}</p></div>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">Current projected contents of this box</caption><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3" scope="col">Product</th><th className="px-4 py-3" scope="col">Lot</th><th className="px-4 py-3" scope="col">Season</th><th className="px-4 py-3" scope="col">Quantity</th><th className="px-4 py-3" scope="col">Ledger sequence</th></tr></thead><tbody>{box.contentProjection.map((line) => <tr className="border-t border-slate-800" key={line.inventoryLotId}><td className="px-4 py-3 font-medium">{line.product.displayName}</td><td className="px-4 py-3 font-mono text-xs text-slate-400">{line.inventoryLot.sourceReference ?? line.inventoryLotId}</td><td className="px-4 py-3">{line.inventoryLot.seasonCode ?? "—"}</td><td className="px-4 py-3 font-semibold text-emerald-300">{line.quantity.toString()}</td><td className="px-4 py-3 font-mono text-xs">{line.ledgerSequence.toString()}</td></tr>)}{box.contentProjection.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={5}>This box has no projected inventory content.</td></tr> : null}</tbody></table>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold">Latest manifest</h2><p className="mt-1 text-sm text-slate-400">The newest version attached to this box.</p></div>{manifest ? <p className="text-sm text-slate-400">v{manifest.version} · {manifest.status}{manifest.closedAt ? ` · closed ${formatDate(manifest.closedAt)}` : ""}</p> : null}</div>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[680px] text-left text-sm"><caption className="sr-only">Latest box manifest lines</caption><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3" scope="col">Product</th><th className="px-4 py-3" scope="col">Lot</th><th className="px-4 py-3" scope="col">Season</th><th className="px-4 py-3" scope="col">Quantity</th></tr></thead><tbody>{manifest?.lines.map((line) => <tr className="border-t border-slate-800" key={line.id}><td className="px-4 py-3 font-medium">{line.product.displayName}</td><td className="px-4 py-3 font-mono text-xs text-slate-400">{line.inventoryLot.sourceReference ?? line.inventoryLotId}</td><td className="px-4 py-3">{line.inventoryLot.seasonCode ?? "—"}</td><td className="px-4 py-3">{line.quantity.toString()}</td></tr>)}{!manifest || manifest.lines.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={4}>The latest manifest has no lines.</td></tr> : null}</tbody></table>
        </div>
      </section>

      <section className="mt-8 grid gap-8 xl:grid-cols-2">
        <div><div className="flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold">Ledger history</h2><p className="mt-1 text-sm text-slate-400">Most recent 50 entries.</p></div><span className="text-sm text-slate-500">{box.ledgerEntries.length}</span></div><div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800"><table className="w-full min-w-[620px] text-left text-sm"><caption className="sr-only">Recent inventory ledger entries for this box</caption><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3" scope="col">Seq.</th><th className="px-4 py-3" scope="col">Event</th><th className="px-4 py-3" scope="col">Product</th><th className="px-4 py-3" scope="col">Qty.</th><th className="px-4 py-3" scope="col">When</th></tr></thead><tbody>{box.ledgerEntries.map((entry) => <tr className="border-t border-slate-800" key={entry.id}><td className="px-4 py-3 font-mono text-xs">{entry.sequence.toString()}</td><td className="px-4 py-3 text-emerald-300">{entry.eventType}</td><td className="px-4 py-3">{entry.product.displayName}</td><td className="px-4 py-3">{entry.quantity.toString()}</td><td className="px-4 py-3 text-slate-400">{formatDate(entry.occurredAt)}</td></tr>)}{box.ledgerEntries.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={5}>No ledger entries for this box.</td></tr> : null}</tbody></table></div></div>
        <div><div className="flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold">Seal history</h2><p className="mt-1 text-sm text-slate-400">Most recent 20 seal events.</p></div><span className="text-sm text-slate-500">{box.sealEvents.length}</span></div><div className="mt-4 overflow-hidden rounded-2xl border border-slate-800"><table className="w-full text-left text-sm"><caption className="sr-only">Recent seal events for this box</caption><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3" scope="col">Seal</th><th className="px-4 py-3" scope="col">Action</th><th className="px-4 py-3" scope="col">When</th><th className="px-4 py-3" scope="col">Reason</th></tr></thead><tbody>{box.sealEvents.map((event) => <tr className="border-t border-slate-800" key={event.id}><td className="px-4 py-3 font-mono">{event.sealCode}</td><td className="px-4 py-3 text-emerald-300">{event.action}</td><td className="px-4 py-3 text-slate-400">{formatDate(event.occurredAt)}</td><td className="px-4 py-3">{event.reason ?? "—"}</td></tr>)}{box.sealEvents.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={4}>No seal events for this box.</td></tr> : null}</tbody></table></div></div>
      </section>
    </section>
  );
}
