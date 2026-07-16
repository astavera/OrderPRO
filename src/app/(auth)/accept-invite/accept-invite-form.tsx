"use client";

import { useActionState } from "react";
import { acceptInvite, type AcceptInviteState } from "./actions";

const initialState: AcceptInviteState = {};

export function AcceptInviteForm({ tokenHash }: { tokenHash: string }) {
  const [state, action, pending] = useActionState(acceptInvite, initialState);
  return <form action={action} className="mt-6">
    <input name="tokenHash" type="hidden" value={tokenHash} />
    <input name="type" type="hidden" value="invite" />
    {state.error ? <p className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">{state.error}</p> : null}
    <button className="w-full rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending} type="submit">{pending ? "Accepting…" : "Accept invitation"}</button>
  </form>;
}
