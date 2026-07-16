import Link from "next/link";
import { notFound } from "next/navigation";
import { getWalkingFeePolicyAdministration } from "@/application/fulfillment/get-walking-fee-policy-administration";
import { PublishWalkingFeePolicyForm } from "./publish-form";

export const dynamic = "force-dynamic";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function tierDistanceLabel(tier: {
  lowerExclusiveFeet: number | null;
  upperInclusiveFeet: number | null;
}) {
  if (tier.lowerExclusiveFeet === null && tier.upperInclusiveFeet !== null) {
    return `0 ≤ distance ≤ ${tier.upperInclusiveFeet} ft`;
  }
  if (tier.upperInclusiveFeet === null && tier.lowerExclusiveFeet !== null) {
    return `distance > ${tier.lowerExclusiveFeet} ft`;
  }
  return `${tier.lowerExclusiveFeet} < distance ≤ ${tier.upperInclusiveFeet} ft`;
}

export default async function WalkingRouteDistanceStandardPage() {
  const data = await getWalkingFeePolicyAdministration();
  if (!data) notFound();

  return (
    <section>
      <Link className="text-sm text-emerald-300 hover:text-emerald-200" href="/operations/fulfillment">
        ← Fulfillment
      </Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">
            Versioned walking fee policy
          </p>
          <h1 className="mt-2 text-4xl font-semibold">{data.policy.name}</h1>
          <p className="mt-2 font-mono text-sm text-slate-400">
            {data.policy.code} · {data.version.versionKey} · revision {data.version.revision}
          </p>
        </div>
        <div className="flex gap-2">
          <span className="rounded-full border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-sm text-sky-200">
            {data.version.environment}
          </span>
          <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">
            {data.version.status}
          </span>
        </div>
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(22rem,0.6fr)]">
        <div className="grid gap-6">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Approved distance tiers</h2>
            <p className="mt-2 text-sm text-slate-400">
              Walking-route distance only. Avenue surcharges and the historical street/avenue matrix are forbidden.
            </p>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-slate-700 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-3">Tier</th>
                    <th className="px-3 py-3">Inclusive boundary</th>
                    <th className="px-3 py-3">Fee</th>
                    <th className="px-3 py-3">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {data.version.tiers.map((tier) => (
                    <tr className="border-b border-slate-800 last:border-0" key={tier.id}>
                      <td className="px-3 py-4 font-mono text-xs text-slate-300">{tier.tierKey}</td>
                      <td className="px-3 py-4">{tierDistanceLabel(tier)}</td>
                      <td className="px-3 py-4">
                        {tier.feeCents === null ? "No automatic quote" : money.format(tier.feeCents / 100)}
                      </td>
                      <td className="px-3 py-4">{tier.reasonCode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Affected store policies</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {data.version.locations.map((entry) => (
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-4" key={entry.feePolicyId}>
                  <p className="font-semibold">{entry.location.name}</p>
                  <p className="mt-1 font-mono text-xs text-slate-400">
                    {entry.location.publicId ?? entry.location.code}
                  </p>
                  <p className="mt-3 text-xs text-slate-400">
                    {entry.policyKey} v{entry.policyVersionNumber} · {entry.serviceScope}
                  </p>
                  <p className={`mt-2 text-xs ${entry.granted ? "text-emerald-300" : "text-red-300"}`}>
                    {entry.granted ? "Active location grant" : "Missing active location grant"}
                  </p>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Publication history</h2>
            {data.version.publications.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No historical publication exists for this version.</p>
            ) : (
              <div className="mt-4 grid gap-3">
                {data.version.publications.map((publication) => (
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4" key={publication.id}>
                    <div className="flex flex-wrap justify-between gap-2">
                      <p className="font-semibold">Publication {publication.publicationNumber} · {publication.status}</p>
                      <time className="text-xs text-slate-400" dateTime={publication.publishedAt}>
                        {new Date(publication.publishedAt).toLocaleString("en-US")}
                      </time>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-slate-500">{publication.digest}</p>
                    <p className="mt-2 text-xs text-slate-400">
                      {publication.publishedBy
                        ? `Approved by ${publication.publishedBy.displayName} (${publication.publishedBy.email})`
                        : "Publisher identity retained by ID"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>

        <aside className="grid content-start gap-6">
          <article className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
            <h2 className="text-xl font-semibold text-amber-100">Audited approval</h2>
            <p className="mt-2 text-sm text-slate-300">
              Publication creates an immutable snapshot and digest, an approval audit event, an outbox event and an idempotency record in one transaction.
            </p>
            {data.blockers.length > 0 ? (
              <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 p-4">
                <p className="text-sm font-semibold text-red-200">Publication blockers</p>
                <ul className="mt-2 list-disc space-y-2 pl-5 text-xs text-red-100">
                  {data.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="mt-5">
              <PublishWalkingFeePolicyForm
                canPublish={data.canPublish}
                confirmation={data.publishConfirmation}
                expectedRevision={data.version.revision}
                status={data.version.status}
                versionId={data.version.id}
              />
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">Independent gates</h2>
            <div className="mt-4 grid gap-3">
              {data.flags.map((flag) => (
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-3" key={flag.key}>
                  <div className="flex items-center justify-between gap-3">
                    <code className="text-xs text-slate-300">{flag.key}</code>
                    <span className={flag.enabled ? "text-xs text-emerald-300" : "text-xs text-slate-500"}>
                      {flag.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{flag.description}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
            <p>Strategy: <span className="font-mono text-slate-200">{data.version.strategy}</span></p>
            <p className="mt-2">Routing profile: <span className="font-mono text-slate-200">{data.version.routingProfile}</span></p>
            <p className="mt-2">Currency: <span className="font-mono text-slate-200">{data.version.currency}</span></p>
            {data.version.digest ? <p className="mt-2 break-all">Digest: <span className="font-mono text-slate-200">{data.version.digest}</span></p> : null}
          </article>
        </aside>
      </div>
    </section>
  );
}
