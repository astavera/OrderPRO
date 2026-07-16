"use client";

import { useActionState, useState } from "react";
import {
  publishWalkingFeePolicyAction,
  type PublishWalkingFeePolicyActionState,
} from "./actions";

export function PublishWalkingFeePolicyForm({
  versionId,
  expectedRevision,
  confirmation,
  canPublish,
  status,
}: {
  versionId: string;
  expectedRevision: number;
  confirmation: string;
  canPublish: boolean;
  status: string;
}) {
  const [initialCommandId] = useState(() => crypto.randomUUID());
  const initialState: PublishWalkingFeePolicyActionState = { commandId: initialCommandId };
  const [state, action, pending] = useActionState(publishWalkingFeePolicyAction, initialState);
  const disabled = !canPublish || pending || status === "PUBLISHED" || status === "ARCHIVED";

  return (
    <form action={action} className="grid gap-5">
      <input name="commandId" type="hidden" value={state.commandId ?? initialCommandId} />
      <input name="versionId" type="hidden" value={versionId} />
      <input name="expectedRevision" type="hidden" value={expectedRevision} />

      <label className="grid gap-2 text-sm font-medium">
        Approval reason
        <textarea
          className="min-h-28 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400 disabled:opacity-60"
          disabled={disabled}
          maxLength={500}
          minLength={10}
          name="reason"
          placeholder="Why is this calibration ready for audited STAGING publication?"
          required
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Type the exact confirmation
        <span className="font-mono text-xs text-amber-200">{confirmation}</span>
        <input
          autoComplete="off"
          className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono outline-none focus:border-emerald-400 disabled:opacity-60"
          disabled={disabled}
          name="confirmation"
          pattern={confirmation}
          required
        />
      </label>

      {state.success ? <p className="text-sm text-emerald-300" role="status">{state.success}</p> : null}
      {state.error ? <p className="text-sm text-red-300" role="alert">{state.error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-xl bg-amber-300 px-5 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          type="submit"
        >
          {pending ? "Publishing..." : "Approve STAGING publication"}
        </button>
        <p className="text-xs text-slate-500">
          This publishes revision {expectedRevision}; it does not enable the quote API or production delivery.
        </p>
      </div>
    </form>
  );
}
