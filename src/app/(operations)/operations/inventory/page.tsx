import { requirePermission } from "@/application/auth/current-principal";
import { activeLocationIds } from "@/application/auth/principal-access";
import { prisma } from "@/infrastructure/database/prisma";
export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const { account } = await requirePermission("inventory.view");
  const locationIds = activeLocationIds(account);
  const [products, lots, containers, entries] = await Promise.all([
    prisma.product.count(),
    prisma.inventoryLot.count({ where: { ownerLocationId: { in: locationIds } } }),
    prisma.container.count({ where: { OR: [{ ownerLocationId: { in: locationIds } }, { currentLocationId: { in: locationIds } }] } }),
    prisma.inventoryLedgerEntry.count({ where: { OR: [{ fromLocationId: { in: locationIds } }, { toLocationId: { in: locationIds } }] } }),
  ]);
  const cards = [["Products", products], ["Owner lots", lots], ["Containers", containers], ["Ledger entries", entries]] as const;

  return <section><p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Inventory control</p><h1 className="mt-2 text-4xl font-semibold">Inventory</h1><div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label,value]) => <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5" key={label}><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></article>)}</div><p className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-400">Read-only visibility is active. Inventory mutations remain locked.</p></section>;
}
