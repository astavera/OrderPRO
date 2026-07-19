"use client";

import { useActionState } from "react";
import {
  approveStagingM2mAction,
  type StagingM2mApprovalActionState,
} from "./actions";

export function StagingM2mApprovalForm({
  canApprove,
  confirmation,
  certificationAuditEventId,
  evidenceDigestSha256,
  initialCommandId,
}: {
  canApprove: boolean;
  confirmation: string;
  certificationAuditEventId: string | null;
  evidenceDigestSha256: string | null;
  initialCommandId: string;
}) {
  const initialState: StagingM2mApprovalActionState = {
    commandId: initialCommandId,
  };
  const [state, action, pending] = useActionState(
    approveStagingM2mAction,
    initialState,
  );
  const disabled =
    !canApprove ||
    !certificationAuditEventId ||
    !evidenceDigestSha256 ||
    pending ||
    Boolean(state.success);

  return (
    <form action={action} className="grid gap-5">
      <input
        name="commandId"
        type="hidden"
        value={state.commandId ?? initialCommandId}
      />
      <input
        name="expectedCertificationAuditEventId"
        type="hidden"
        value={certificationAuditEventId ?? ""}
      />
      <input
        name="expectedEvidenceDigestSha256"
        type="hidden"
        value={evidenceDigestSha256 ?? ""}
      />

      <label className="grid gap-2 text-sm font-medium">
        Approval reason
        <textarea
          className="min-h-28 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400 disabled:opacity-60"
          disabled={disabled}
          maxLength={500}
          minLength={10}
          name="reason"
          placeholder="Why should this exact certified STAGING client move to approved-pending-activation?"
          required
        />
        <span className="text-xs font-normal text-slate-500">
          Do not paste tokens, secrets, authorization headers or Client IDs.
        </span>
      </label>

      <label className="grid gap-2 text-sm font-medium">
        Type the exact confirmation
        <span className="break-all font-mono text-xs text-amber-200">
          {confirmation}
        </span>
        <input
          autoComplete="off"
          className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono outline-none focus:border-emerald-400 disabled:opacity-60"
          disabled={disabled}
          name="confirmation"
          pattern={confirmation}
          required
        />
      </label>

      {state.success ? (
        <p className="text-sm text-emerald-300" role="status">
          {state.success}
        </p>
      ) : null}
      {state.error ? (
        <p className="text-sm text-red-300" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-xl bg-amber-300 px-5 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          type="submit"
        >
          {pending ? "Recording approval…" : "Approve pending activation"}
        </button>
        <p className="max-w-xl text-xs text-slate-500">
          This records one immutable Owner decision. It does not assign an owner to the machine client,
          activate credentials or grants, enable Auth0 verification, or open the Local Delivery API.
        </p>
      </div>
    </form>
  );
}
