import Link from "next/link";

export default function BoxNotFound() {
  return <section className="rounded-2xl border border-slate-800 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">Box unavailable</p><h1 className="mt-2 text-3xl font-semibold">Box not found</h1><p className="mt-3 max-w-xl text-slate-400">The code is invalid, the box does not exist, or it is outside your assigned operational locations.</p><Link className="mt-6 inline-flex rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950" href="/operations/boxes">Return to boxes</Link></section>;
}
