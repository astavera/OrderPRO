import Link from "next/link";
import {
  getFulfillmentDashboard,
  type FulfillmentDashboardLocationDto,
  type FulfillmentDashboardStoreOnlinePolicyDto,
  type FulfillmentDashboardWalkingCandidateDto,
  type FulfillmentDashboardWalkingVersionDto,
  type FulfillmentDashboardWalkingZoneDto,
} from "@/application/fulfillment/get-fulfillment-dashboard";
import type { FulfillmentDashboardBlocker } from "@/application/fulfillment/fulfillment-dashboard-blockers";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const relevantFlagOrder = [
  "walking_delivery.admin",
  "walking_delivery.publish",
  "walking_fee_policy.admin",
  "walking_fee_policy.staging_publish",
  "walking_fee_policy.publish",
  "walking_delivery.quote_writes",
  "walking_quote.api",
  "walking_quote.external_delivery",
  "store_online_fulfillment",
  "storefront.availability",
  "inventory.mutations",
  "square.production_writes",
] as const;

function formatDate(value: string | null) {
  return value ? dateFormatter.format(new Date(value)) : "Pending";
}

function words(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function locationId(location: FulfillmentDashboardLocationDto) {
  return location.publicId ?? location.code;
}

function locationAddress(location: FulfillmentDashboardLocationDto) {
  const locality = [location.city, location.regionCode, location.postalCode].filter(Boolean).join(", ");
  return [location.addressLine1, locality].filter(Boolean).join(" · ") || "Address pending";
}

function statusTone(status: string) {
  if (status === "PUBLISHED") return "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20";
  if (status === "VALIDATED") return "bg-sky-400/10 text-sky-300 ring-sky-400/20";
  if (status === "ARCHIVED") return "bg-slate-700/60 text-slate-300 ring-slate-600";
  return "bg-amber-400/10 text-amber-200 ring-amber-400/20";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusTone(status)}`}>
      {words(status)}
    </span>
  );
}

function FlagBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={
        enabled
          ? "rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/20"
          : "rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-200 ring-1 ring-inset ring-amber-400/20"
      }
    >
      {enabled ? "Enabled" : "Locked"}
    </span>
  );
}

function FlowStep({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{eyebrow}</p>
      <p className="mt-2 font-semibold text-slate-100">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">{detail}</p>
    </div>
  );
}

function FlowArrow() {
  return <span className="hidden self-center text-xl text-slate-600 sm:block" aria-hidden="true">→</span>;
}

function BlockerList({
  blockers,
  candidates = [],
}: {
  blockers: readonly FulfillmentDashboardBlocker[];
  candidates?: readonly FulfillmentDashboardWalkingCandidateDto[];
}) {
  if (blockers.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-200">
        No readiness blockers were detected in this read model.
      </div>
    );
  }

  const candidateLabel = (blocker: FulfillmentDashboardBlocker) => {
    if (!blocker.locationId) return null;
    const candidate = candidates.find(({ location }) => location.id === blocker.locationId);
    return candidate ? locationId(candidate.location) : blocker.locationId;
  };

  return (
    <ul className="space-y-2">
      {blockers.map((blocker, index) => {
        const label = candidateLabel(blocker);
        return (
          <li
            className="rounded-xl border border-amber-400/15 bg-amber-400/5 px-3 py-2.5"
            key={`${blocker.code}-${blocker.locationId ?? "global"}-${index}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm leading-5 text-amber-100">
                {label ? <span className="font-mono text-xs text-amber-300">{label}: </span> : null}
                {blocker.message}
              </p>
              <span className="font-mono text-[10px] text-amber-300/70">{blocker.code}</span>
            </div>
            {blocker.details.length > 0 ? (
              <p className="mt-1 text-xs text-slate-400">Fields: {blocker.details.map(words).join(", ")}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function cutoffLabel(value: number | null) {
  if (value == null) return "Pending";
  const hours = Math.floor(value / 60).toString().padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes} local`;
}

function StorePolicyCard({ policy }: { policy: FulfillmentDashboardStoreOnlinePolicyDto }) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-emerald-300">{locationId(policy.sourceLocation)}</p>
          <h3 className="mt-1 text-xl font-semibold">{policy.sourceLocation.name}</h3>
          <p className="mt-1 text-sm text-slate-500">{locationAddress(policy.sourceLocation)}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <StatusBadge status={policy.status} />
          <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
            v{policy.versionNumber}{policy.isLatestVersion ? " · latest" : " · history"}
          </span>
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Configured route</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-lg bg-slate-900 px-3 py-2 font-mono text-emerald-300">
            {locationId(policy.sourceLocation)}
          </span>
          <span className="text-slate-600" aria-hidden="true">→</span>
          <span className="rounded-lg bg-slate-900 px-3 py-2 font-mono text-sky-300">
            {locationId(policy.consolidationLocation)}
          </span>
          <span className="text-slate-600" aria-hidden="true">→</span>
          <span className="rounded-lg bg-slate-900 px-3 py-2 text-slate-300">Carrier</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
          <div>
            <p className="text-xs text-slate-500">Customer-promise adjustment</p>
            <p className="mt-1 text-2xl font-semibold text-sky-300">+{policy.addedBusinessDays} business days</p>
          </div>
          <p className="max-w-sm text-xs leading-5 text-slate-400">
            Retrieval adjustment only. An exact ETA still requires the pickup calendar, cutoff and carrier promise.
          </p>
        </div>
      </div>

      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Online sales policy</dt>
          <dd className={policy.onlineSalesEnabled ? "mt-1 font-medium text-emerald-300" : "mt-1 font-medium text-amber-200"}>
            {policy.onlineSalesEnabled ? "Configured on" : "Off / locked"}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Activation gate</dt>
          <dd className="mt-1 font-medium text-slate-200">
            {policy.availableOnlyAfterStoreActivation ? "Required" : "Missing"}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Pickup weekdays</dt>
          <dd className="mt-1 font-medium text-slate-200">
            {policy.pickupWeekdays.length > 0 ? policy.pickupWeekdays.map(words).join(", ") : "Pending"}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Retrieval cutoff</dt>
          <dd className="mt-1 font-medium text-slate-200">{cutoffLabel(policy.retrievalCutoffMinuteOfDay)}</dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Business calendar</dt>
          <dd className="mt-1 font-medium text-slate-200">{policy.businessCalendarRef ?? "Pending"}</dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-slate-500">Effective from</dt>
          <dd className="mt-1 font-medium text-slate-200">{formatDate(policy.effectiveFrom)}</dd>
        </div>
      </dl>

      <div className="mt-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="font-semibold">Readiness blockers</h4>
          <span className="text-sm text-amber-200">{policy.blockers.length}</span>
        </div>
        <BlockerList blockers={policy.blockers} />
      </div>
    </article>
  );
}

function strategyLabel(strategy: string) {
  return strategy === "FIXED" ? "Fixed store" : strategy === "NEAREST_WALKING_ROUTE" ? "Nearest walking route" : words(strategy);
}

function CandidateRow({ candidate }: { candidate: FulfillmentDashboardWalkingCandidateDto }) {
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-950 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-emerald-300">{locationId(candidate.location)}</p>
          <p className="mt-1 text-sm font-medium text-slate-200">{candidate.location.name}</p>
        </div>
        <span className={candidate.location.active ? "text-xs text-emerald-300" : "text-xs text-amber-200"}>
          {candidate.location.active ? "Active location" : "Inactive location"}
        </span>
      </div>
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-lg bg-slate-900 px-3 py-2">
          <span className="text-slate-500">Fee policy</span>
          <p className="mt-1 text-slate-300">
            {candidate.feePolicy ? `${candidate.feePolicy.name} · ${words(candidate.feePolicy.status)}` : "Missing"}
          </p>
        </div>
        <div className="rounded-lg bg-slate-900 px-3 py-2">
          <span className="text-slate-500">Slot policy</span>
          <p className="mt-1 text-slate-300">
            {candidate.slotPolicy ? `${candidate.slotPolicy.name} · ${words(candidate.slotPolicy.status)}` : "Missing"}
          </p>
        </div>
      </div>
    </li>
  );
}

function WalkingZoneCard({ zone }: { zone: FulfillmentDashboardWalkingZoneDto }) {
  const version: FulfillmentDashboardWalkingVersionDto | null = zone.latestVersion ?? zone.currentVersion;

  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap gap-2">
            {(version?.postalCodes ?? []).map((postalCode) => (
              <span className="rounded-lg bg-emerald-400/10 px-2.5 py-1 font-mono text-sm font-semibold text-emerald-300" key={postalCode}>
                {postalCode}
              </span>
            ))}
          </div>
          <h3 className="mt-3 text-xl font-semibold">{zone.name}</h3>
          <p className="mt-1 font-mono text-xs text-slate-500">{zone.slug}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <StatusBadge status={version?.status ?? "NO_VERSION"} />
          {version ? (
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
              v{version.versionNumber} · rev {version.revision}
            </span>
          ) : null}
        </div>
      </div>

      {version ? (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-slate-500">Assignment</dt>
              <dd className="mt-1 font-medium text-slate-200">{strategyLabel(version.assignmentStrategy)}</dd>
            </div>
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-slate-500">Geometry</dt>
              <dd className={version.hasGeometry ? "mt-1 font-medium text-emerald-300" : "mt-1 font-medium text-amber-200"}>
                {version.hasGeometry ? version.geometryType : "Pending"}
              </dd>
            </div>
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-slate-500">Overlap priority</dt>
              <dd className="mt-1 font-medium text-slate-200">{version.priority ?? "Pending"}</dd>
            </div>
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-slate-500">Active days</dt>
              <dd className="mt-1 font-medium text-slate-200">
                {version.activeDays.length > 0 ? version.activeDays.map(words).join(", ") : "Pending"}
              </dd>
            </div>
          </dl>

          <div className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h4 className="font-semibold">Candidate stores</h4>
              <span className="text-sm text-slate-400">{version.candidates.length}</span>
            </div>
            <ul className="space-y-2">
              {version.candidates.map((candidate) => (
                <CandidateRow candidate={candidate} key={candidate.location.id} />
              ))}
            </ul>
          </div>

          <div className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h4 className="font-semibold">Readiness blockers</h4>
              <span className="text-sm text-amber-200">{zone.blockers.length}</span>
            </div>
            <BlockerList blockers={zone.blockers} candidates={version.candidates} />
          </div>
          <Link
            className="mt-5 inline-flex rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-emerald-300 hover:border-emerald-400/60"
            href={`/operations/fulfillment/walking-zones/${zone.id}`}
          >
            Open draft and GeoJSON
          </Link>
        </>
      ) : (
        <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100">
          No configuration version is available for this walking zone.
        </div>
      )}
    </article>
  );
}

export default async function FulfillmentPage() {
  const dashboard = await getFulfillmentDashboard();
  const flagRank = new Map<string, number>(relevantFlagOrder.map((key, index) => [key, index]));
  const flags = [...dashboard.flags].sort((left, right) => {
    const leftRank = flagRank.get(left.key) ?? relevantFlagOrder.length;
    const rightRank = flagRank.get(right.key) ?? relevantFlagOrder.length;
    return leftRank - rightRank || left.key.localeCompare(right.key);
  });
  const publicationFlag = dashboard.flags.find(({ key }) => key === "walking_delivery.publish");
  const storeOnlineFlag = dashboard.flags.find(({ key }) => key === "store_online_fulfillment");
  const walkingBlockerCount = dashboard.walkingZones.reduce((total, zone) => total + zone.blockers.length, 0);
  const storeBlockerCount = dashboard.storeOnlinePolicies.reduce((total, policy) => total + policy.blockers.length, 0);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Fulfillment readiness</p>
          <h1 className="mt-2 text-4xl font-semibold">Walking delivery and store-backed shipping</h1>
          <p className="mt-3 leading-7 text-slate-400">
            Configuration visibility, draft editing and production gates. Saving a draft never publishes it.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <span className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">Draft control plane</span>
          <span className="rounded-full bg-amber-400/10 px-3 py-1 text-sm font-medium text-amber-200">Draft foundation</span>
          <span className={publicationFlag?.enabled ? "rounded-full bg-emerald-400/10 px-3 py-1 text-sm text-emerald-300" : "rounded-full bg-rose-400/10 px-3 py-1 text-sm text-rose-200"}>
            Publication {publicationFlag?.enabled ? "enabled" : "locked"}
          </span>
        </div>
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fulfillment configuration summary">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-sm text-slate-400">Walking zones</p>
          <p className="mt-2 text-3xl font-semibold">{dashboard.walkingZones.length}</p>
          <p className="mt-1 text-xs text-slate-500">Confirmed assignment drafts</p>
        </article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-sm text-slate-400">Store policies</p>
          <p className="mt-2 text-3xl font-semibold">{dashboard.storeOnlinePolicies.length}</p>
          <p className="mt-1 text-xs text-slate-500">Store-to-warehouse routes</p>
        </article>
        <article className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
          <p className="text-sm text-amber-100/80">Walking blockers</p>
          <p className="mt-2 text-3xl font-semibold text-amber-200">{walkingBlockerCount}</p>
          <p className="mt-1 text-xs text-amber-100/60">Across all zone drafts</p>
        </article>
        <article className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
          <p className="text-sm text-amber-100/80">Shipping blockers</p>
          <p className="mt-2 text-3xl font-semibold text-amber-200">{storeBlockerCount}</p>
          <p className="mt-1 text-xs text-amber-100/60">Exact ETA remains unavailable</p>
        </article>
      </section>

      <section className="mt-10" aria-labelledby="fulfillment-paths-heading">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">Operational distinction</p>
          <h2 className="mt-2 text-2xl font-semibold" id="fulfillment-paths-heading">Two separate customer paths</h2>
          <p className="mt-2 text-sm text-slate-400">The retrieval adjustment belongs only to carrier shipping sourced from store inventory.</p>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <article className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Walking · direct local</p>
                <h3 className="mt-2 text-2xl font-semibold">Selected store to customer</h3>
              </div>
              <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                No +2-day adjustment
              </span>
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <FlowStep eyebrow="1 · Assign" title="Selected store" detail="Fixed zone or shortest approved walking route." />
              <FlowArrow />
              <FlowStep eyebrow="2 · Fulfill" title="Walking delivery" detail="Pick, pack and dispatch from that same store." />
              <FlowArrow />
              <FlowStep eyebrow="3 · Complete" title="Customer" detail="Slot and local-delivery policy determine the promise." />
            </div>
            <p className="mt-4 text-sm text-emerald-100/70">Englewood is not part of this path. No silent store fallback is allowed.</p>
          </article>

          <article className="rounded-2xl border border-sky-400/20 bg-sky-400/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-300">Carrier shipping · store-backed</p>
                <h3 className="mt-2 text-2xl font-semibold">Store retrieval through Englewood</h3>
              </div>
              <span className="rounded-full bg-sky-400/10 px-3 py-1 text-sm font-semibold text-sky-300 ring-1 ring-inset ring-sky-400/20">
                +2 business days
              </span>
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <FlowStep eyebrow="1 · Reserve" title="Source store" detail="Reserve only after store receipt and activation." />
              <FlowArrow />
              <FlowStep eyebrow="2 · Consolidate" title="warehouse-englewood" detail="Retrieve, verify and process at the warehouse." />
              <FlowArrow />
              <FlowStep eyebrow="3 · Ship" title="Carrier" detail="Apply the warehouse carrier promise after retrieval." />
            </div>
            <p className="mt-4 text-sm text-sky-100/70">The item remains reserved while traveling from the store to the warehouse.</p>
          </article>
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="feature-flags-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold" id="feature-flags-heading">Feature gates</h2>
            <p className="mt-1 text-sm text-slate-400">An enabled administrative flag is not production certification.</p>
          </div>
          <time className="text-xs text-slate-500" dateTime={dashboard.generatedAt}>Read model {formatDate(dashboard.generatedAt)}</time>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {flags.map((flag) => (
            <article className="rounded-xl border border-slate-800 bg-slate-950 p-4" key={flag.key}>
              <div className="flex items-start justify-between gap-3">
                <code className="break-all text-xs text-slate-300">{flag.key}</code>
                <FlagBadge enabled={flag.enabled} />
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">{flag.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="walking-fee-policy-heading">
        <Link
          className="block rounded-2xl border border-amber-400/25 bg-amber-400/5 p-5 transition hover:border-amber-300/50 hover:bg-amber-400/10"
          href="/operations/fulfillment/fee-policies/WALKING_ROUTE_DISTANCE_STANDARD"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-amber-200">
                Versioned walking fee policy
              </p>
              <h2 className="mt-2 text-2xl font-semibold" id="walking-fee-policy-heading">
                WALKING_ROUTE_DISTANCE_STANDARD
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                Review the inclusive distance tiers, affected stores, blockers and immutable STAGING publication history.
              </p>
            </div>
            <span className="rounded-full border border-amber-300/30 bg-slate-950 px-4 py-2 text-sm font-semibold text-amber-100">
              Review policy →
            </span>
          </div>
        </Link>
      </section>

      <section className="mt-10" aria-labelledby="store-policy-heading">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-300">Store-backed shipping</p>
            <h2 className="mt-2 text-2xl font-semibold" id="store-policy-heading">Policies by source store</h2>
            <p className="mt-2 text-sm text-slate-400">Each route consolidates at `warehouse-englewood`; online activation remains independently gated.</p>
          </div>
          <FlagBadge enabled={storeOnlineFlag?.enabled ?? false} />
        </div>
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {dashboard.storeOnlinePolicies.map((policy) => (
            <StorePolicyCard key={policy.id} policy={policy} />
          ))}
        </div>
        {dashboard.storeOnlinePolicies.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5 text-amber-100">
            No store-backed shipping policies are available in the read model.
          </div>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="walking-zones-heading">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-300">Walking local delivery</p>
            <h2 className="mt-2 text-2xl font-semibold" id="walking-zones-heading">Zone drafts and store assignment</h2>
            <p className="mt-2 text-sm text-slate-400">ZIP labels narrow the search; approved point-in-polygon geometry remains the eligibility boundary.</p>
          </div>
          <span className="rounded-full bg-amber-400/10 px-3 py-1 text-sm font-medium text-amber-200">
            {dashboard.walkingZones.length} draft zones
          </span>
        </div>
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {dashboard.walkingZones.map((zone) => (
            <WalkingZoneCard key={zone.id} zone={zone} />
          ))}
        </div>
        {dashboard.walkingZones.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5 text-amber-100">
            No walking-zone drafts are available in the read model.
          </div>
        ) : null}
      </section>

      <aside className="mt-10 rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="documentation-heading">
        <h2 className="text-xl font-semibold" id="documentation-heading">Reference contracts</h2>
        <p className="mt-2 text-sm text-slate-400">Repository documentation describes phase gates, integration and rollback without enabling production behavior.</p>
        <ul className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
          {[
            "docs/fulfillment-walking-delivery.md",
            "docs/ecommerce-walking-integration.md",
            "docs/operations-walking-runbook.md",
            "docs/openapi/orderpro-walking-zones-v1.yaml",
          ].map((path) => (
            <li className="rounded-lg bg-slate-950 px-3 py-2 font-mono text-slate-400" key={path}>{path}</li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
