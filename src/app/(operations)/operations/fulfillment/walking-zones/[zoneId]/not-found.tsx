import Link from "next/link";

export default function WalkingZoneNotFound() {
  return <section className="rounded-2xl border border-slate-800 bg-slate-900 p-8"><h1 className="text-3xl font-semibold">Walking zone unavailable</h1><p className="mt-3 text-slate-400">The zone does not exist or is outside your assigned location scope.</p><Link className="mt-6 inline-block text-emerald-300" href="/operations/fulfillment">Return to fulfillment</Link></section>;
}
