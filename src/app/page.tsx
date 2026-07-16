const foundations = [
  ["Locations", "WH01, ST72 and ST86 mappings"],
  ["Identity & RBAC", "Permission and location-scoped access"],
  ["Inventory ledger", "Immutable owner and physical movements"],
  ["Integration safety", "Inbox, outbox and idempotent mutations"],
] as const;

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-400">Modern State operations</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight sm:text-7xl">OrderPRO</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">The independent operational control plane for orders, owner inventory, warehouse movement and fulfillment.</p>
        <div className="mt-8 inline-flex rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">Foundation setup — production operations are disabled</div>
        <section className="mt-14 grid gap-4 md:grid-cols-2" aria-label="Platform foundations">
          {foundations.map(([title, description]) => (
            <article className="rounded-2xl border border-slate-800 bg-slate-900 p-6" key={title}>
              <h2 className="text-xl font-semibold">{title}</h2>
              <p className="mt-2 text-slate-400">{description}</p>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
