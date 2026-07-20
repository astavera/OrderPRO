"use client";

import { useActionState } from "react";
import {
  activateStagingM2mAction,
  type StagingM2mActivationActionState,
} from "./actions";

export function StagingM2mActivationForm({
  canActivate,
  confirmation,
  approvalId,
  approvalDigestSha256,
  initialCommandId,
}: {
  canActivate: boolean;
  confirmation: string;
  approvalId: string | null;
  approvalDigestSha256: string | null;
  initialCommandId: string;
}) {
  const initialState: StagingM2mActivationActionState = {
    commandId: initialCommandId,
  };
  const [state, action, pending] = useActionState(
    activateStagingM2mAction,
    initialState,
  );
  const disabled =
    !canActivate ||
    !approvalId ||
    !approvalDigestSha256 ||
    pending ||
    Boolean(state.success);

  return (
    <form action={action} className="grid gap-5">
      <input
        name="commandId"
        type="hidden"
        value={state.commandId ?? initialCommandId}
      />
      <input name="expectedApprovalId" type="hidden" value={approvalId ?? ""} />
      <input
        name="expectedApprovalDigestSha256"
        type="hidden"
        value={approvalDigestSha256 ?? ""}
      />

      <label className="grid gap-2 text-sm font-medium">
        Activation reason
        <textarea
          className="min-h-28 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-red-400 disabled:opacity-60"
          disabled={disabled}
          maxLength={500}
          minLength={10}
          name="reason"
          placeholder="Why should this exact approved STAGING registry become active now?"
          required
        />
        <span className="text-xs font-normal text-slate-500">
          Do not paste tokens, secrets, authorization headers or Client IDs.
        </span>
      </label>

      <label className="grid gap-2 text-sm font-medium">
        Type the exact confirmation
        <span className="break-all font-mono text-xs text-red-200">
          {confirmation}
        </span>
        <input
          autoComplete="off"
          className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono outline-none focus:border-red-400 disabled:opacity-60"
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
          className="rounded-xl bg-red-300 px-5 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          type="submit"
        >
          {pending ? "Activating registry..." : "Activate M2M registry"}
        </button>
        <p className="max-w-xl text-xs text-slate-500">
          This activates only the approved STAGING client, credential and two grants.
          It does not enable Auth0 runtime verification or open Local Delivery routes.
        </p>
      </div>
    </form>
  );
}
