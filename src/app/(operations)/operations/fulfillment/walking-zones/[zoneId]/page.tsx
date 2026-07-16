import Link from "next/link";
import { notFound } from "next/navigation";
import { getWalkingZoneEditorData } from "@/application/fulfillment/get-walking-zone-editor";
import { WalkingZoneDraftForm } from "./walking-zone-draft-form";

export const dynamic = "force-dynamic";

export default async function WalkingZonePage({ params }: PageProps<"/operations/fulfillment/walking-zones/[zoneId]">) {
  const { zoneId } = await params;
  const data = await getWalkingZoneEditorData(zoneId);
  if (!data) notFound();

  const geometryText = data.version.geometry ? JSON.stringify(data.version.geometry, null, 2) : "";
  const editable = data.canManage && data.adminEnabled;

  return (
    <section>
      <Link className="text-sm text-emerald-300 hover:text-emerald-200" href="/operations/fulfillment">← Fulfillment</Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Walking delivery draft</p>
          <h1 className="mt-2 text-4xl font-semibold">{data.zone.name}</h1>
          <p className="mt-2 font-mono text-sm text-slate-400">{data.zone.slug} · version {data.version.versionNumber} · {data.version.status}</p>
        </div>
        <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">Not published</span>
      </div>

      <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <WalkingZoneDraftForm
          draft={{
            id: data.version.id,
            revision: data.version.revision,
            status: data.version.status,
            assignmentStrategy: data.version.assignmentStrategy,
            postalCodes: data.version.postalCodes,
            priority: data.version.priority,
            geometryText,
            activeDays: data.version.activeDays,
            maxDistanceMiles: data.version.maxDistanceMiles,
            maxRouteMinutes: data.version.maxRouteMinutes,
            minimumOrderCents: data.version.minimumOrderCents,
            candidateLocationIds: data.version.candidates.map(({ location }) => location.id),
          }}
          editable={editable}
          stores={data.stores}
          zoneId={data.zone.id}
          zoneName={data.zone.name}
        />
      </div>
    </section>
  );
}
