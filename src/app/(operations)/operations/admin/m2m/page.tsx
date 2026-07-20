import { randomUUID } from "node:crypto";
import { getStagingMachineAuthorizationApprovalPageData } from "@/application/m2m/staging-authorization-approval";
import { getStagingMachineAuthorizationActivationPageData } from "@/application/m2m/staging-authorization-activation";
import { StagingM2mActivationForm } from "./activation-form";
import { StagingM2mApprovalForm } from "./approval-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function StatusPill({ good, children }: { good: boolean; children: React.ReactNode }) {
  return (
    <span
      className={
        good
          ? "rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200"
          : "rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs text-amber-200"
      }
    >
      {children}
    </span>
  );
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

export default async function StagingM2mApprovalPage() {
  const [data, activationData] = await Promise.all([
    getStagingMachineAuthorizationApprovalPageData(),
    getStagingMachineAuthorizationActivationPageData(),
  ]);
  const approved = data.approval?.decision === "APPROVED_PENDING_ACTIVATION";
  const activated = activationData.activation?.result === "ACTIVATED";
  const gateRows = approved
    ? ([
        ["Activation UI gate", activationData.gates.activationUiEnabled],
        ["Approval UI closed", activationData.gates.approvalUiDisabled],
        ["Production build", activationData.gates.productionBuild],
        ["STAGING runtime", activationData.gates.stagingRuntime],
        ["M2M authentication disabled", activationData.gates.m2mAuthDisabled],
        ["Local Delivery V4 API disabled", activationData.gates.localDeliveryApiDisabled],
        ["Release provenance present", activationData.gates.releaseProvenancePresent],
        ["Forbidden secrets absent", activationData.gates.forbiddenSecretsAbsent],
        ["Three guarded transitions", activationData.transitionGuardsIntact],
        ["Audited activation boundary", activationData.activationBoundaryIntact],
      ] as const)
    : ([
        ["Approval UI gate", data.gates.approvalUiEnabled],
        ["Production build", data.gates.productionBuild],
        ["STAGING runtime", data.gates.stagingRuntime],
        ["M2M authentication disabled", data.gates.m2mAuthDisabled],
        ["Local Delivery V4 API disabled", data.gates.localDeliveryApiDisabled],
        ["Release provenance present", data.gates.releaseProvenancePresent],
        ["Forbidden secrets absent", data.gates.forbiddenSecretsAbsent],
        ["Three no-activation triggers", data.activationBlockersIntact],
        ["Audited append-only approval boundary", data.approvalBoundaryIntact],
      ] as const);

  return (
    <section>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">
        Administration · Machine-to-machine
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold">Storefront STAGING authorization</h1>
          <p className="mt-3 max-w-3xl text-slate-400">
            Review, approve and activate the exact Auth0 registry snapshot through separate audited steps.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill good>{data.client?.environment ?? "STAGING"}</StatusPill>
          <StatusPill good={approved}>
            {activated
              ? "REGISTRY ACTIVE"
              : approved
                ? "APPROVED · PENDING ACTIVATION"
                : "PENDING OWNER APPROVAL"}
          </StatusPill>
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-sky-400/30 bg-sky-400/5 p-5">
        <h2 className="text-lg font-semibold text-sky-100">
          {activated
            ? "Registry active; delivery API still closed"
            : approved
              ? "Separate registry activation"
              : "Approval does not activate access"}
        </h2>
        <p className="mt-2 text-sm text-slate-300">
          {activated ? (
            <>
              The client, credential and exact grants are <code>ACTIVE</code>. Auth0 runtime verification and
              Local Delivery V4 remain independent release steps and are not enabled here.
            </>
          ) : approved ? (
            <>
              The immutable approval is complete. Activation changes only the registered client, credential
              and two grants in one audited transaction; it does not open Local Delivery routes.
            </>
          ) : (
            <>
              A successful decision remains <code>APPROVED_PENDING_ACTIVATION</code>. The machine client,
              credential and both grants remain <code>PENDING_VERIFICATION</code>.
            </>
          )}
        </p>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
        <div className="grid content-start gap-6">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">Authorization snapshot</h2>
                <p className="mt-1 font-mono text-xs text-slate-400">
                  {data.client?.key ?? "storefront-staging"}
                </p>
              </div>
              <StatusPill
                good={
                  data.client?.status ===
                  (activated ? "ACTIVE" : "PENDING_VERIFICATION")
                }
              >
                {data.client?.status ?? "NOT FOUND"}
              </StatusPill>
            </div>
            {data.client ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Machine client</p>
                  <p className="mt-2 font-semibold">{data.client.displayName}</p>
                  <p className="mt-1 text-sm text-slate-400">Version {data.client.version}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    Machine owner: {data.client.ownerAssigned ? "assigned" : "not assigned"}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Credential</p>
                  {data.client.credential ? (
                    <>
                      <p className="mt-2 font-semibold">{data.client.credential.provider}</p>
                      <p className="mt-1 text-sm text-slate-400">
                        {data.client.credential.status} · version {data.client.credential.version}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        {data.client.credential.verifiedAt
                          ? `Verified ${new Date(data.client.credential.verifiedAt).toLocaleString("en-US")}`
                          : "Not verified"}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-amber-200">Exact credential not available.</p>
                  )}
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 sm:col-span-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Scope grants</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {data.client.grants.map((grant) => (
                      <div className="rounded-lg border border-slate-800 px-3 py-2" key={grant.scope}>
                        <code className="text-xs text-slate-200">{grant.scope}</code>
                        <p className="mt-1 text-xs text-slate-500">
                          {grant.status} · version {grant.version}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-amber-200">The registered STAGING client was not found.</p>
            )}
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Certification evidence</h2>
            {data.certification?.evidenceDigestSha256 ? (
              <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Certified at</dt>
                  <dd className="mt-1 text-slate-200">
                    {new Date(data.certification.certifiedAt).toLocaleString("en-US")}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Audit event</dt>
                  <dd className="mt-1 font-mono text-xs text-slate-200">
                    {data.certification.auditEventId}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Evidence digest</dt>
                  <dd className="mt-1 font-mono text-xs text-slate-200" title={data.certification.evidenceDigestSha256}>
                    {shortHash(data.certification.evidenceDigestSha256)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Verifier digest</dt>
                  <dd className="mt-1 font-mono text-xs text-slate-200">
                    {data.certification.verifierDigestSha256
                      ? shortHash(data.certification.verifierDigestSha256)
                      : "Invalid"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-amber-200">No intact certification is available for review.</p>
            )}
          </article>

          {data.approval ? (
            <article className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-5">
              <h2 className="text-xl font-semibold text-emerald-100">Immutable approval recorded</h2>
              <p className="mt-3 text-sm text-slate-200">{data.approval.reason}</p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Decision</dt>
                  <dd className="mt-1 font-mono text-xs text-emerald-200">{data.approval.decision}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Authorization status</dt>
                  <dd className="mt-1 font-mono text-xs text-amber-200">{data.approval.authorizationStatus}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Approved by</dt>
                  <dd className="mt-1 text-slate-200">
                    {data.approval.approvedBy} ({data.approval.approvedByEmail})
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Approved at</dt>
                  <dd className="mt-1 text-slate-200">
                    {new Date(data.approval.approvedAt).toLocaleString("en-US")}
                  </dd>
                </div>
              </dl>
            </article>
          ) : null}

          {activationData.activation ? (
            <article className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-5">
              <h2 className="text-xl font-semibold text-emerald-100">
                Immutable activation recorded
              </h2>
              <p className="mt-3 text-sm text-slate-200">
                {activationData.activation.reason}
              </p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Result</dt>
                  <dd className="mt-1 font-mono text-xs text-emerald-200">
                    {activationData.activation.result}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Activated at</dt>
                  <dd className="mt-1 text-slate-200">
                    {new Date(activationData.activation.activatedAt).toLocaleString("en-US")}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500">Activated by</dt>
                  <dd className="mt-1 text-slate-200">
                    {activationData.activation.activatedBy} ({activationData.activation.activatedByEmail})
                  </dd>
                </div>
              </dl>
            </article>
          ) : null}
        </div>

        <aside className="grid content-start gap-6">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Fail-closed gates</h2>
            <div className="mt-4 grid gap-2">
              {gateRows.map(([label, ready]) => (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-3 py-3" key={label}>
                  <span className="text-sm text-slate-300">{label}</span>
                  <span className={ready ? "text-xs text-emerald-300" : "text-xs text-amber-300"}>
                    {ready ? "READY" : "BLOCKED"}
                  </span>
                </div>
              ))}
            </div>
          </article>

          {(approved ? activationData.blockers : data.blockers).length > 0 && !activated ? (
            <article className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
              <h2 className="text-lg font-semibold text-amber-100">
                {approved ? "Activation blockers" : "Approval blockers"}
              </h2>
              <ul className="mt-3 grid gap-3 text-sm text-amber-50">
                {(approved ? activationData.blockers : data.blockers).map((blocker) => (
                  <li className="rounded-xl border border-amber-400/20 bg-slate-950/40 p-3" key={blocker.code}>
                    <p>{blocker.message}</p>
                    <code className="mt-1 block text-[10px] text-amber-300/70">{blocker.code}</code>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}

          <article className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
            <h2 className="text-xl font-semibold text-amber-100">
              {activated ? "Activation complete" : "Owner decision"}
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Signed in as {data.actor.displayName} ({data.actor.email}). Your authenticated account is revalidated inside the transaction.
            </p>
            <div className="mt-5">
              {activated ? (
                <p className="text-sm text-emerald-200">
                  The registry activation is immutable. Close the activation UI gate before enabling Auth0 verification.
                </p>
              ) : approved ? (
                <StagingM2mActivationForm
                  approvalDigestSha256={activationData.approval?.digestSha256 ?? null}
                  approvalId={activationData.approval?.id ?? null}
                  canActivate={activationData.canActivate}
                  confirmation={activationData.confirmation}
                  initialCommandId={randomUUID()}
                />
              ) : (
                <StagingM2mApprovalForm
                  canApprove={data.canApprove}
                  certificationAuditEventId={data.certification?.auditEventId ?? null}
                  confirmation={data.confirmation}
                  evidenceDigestSha256={data.certification?.evidenceDigestSha256 ?? null}
                  initialCommandId={randomUUID()}
                />
              )}
            </div>
          </article>
        </aside>
      </div>
    </section>
  );
}
