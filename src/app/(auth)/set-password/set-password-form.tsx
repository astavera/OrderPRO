"use client";

import { useActionState } from "react";
import { setInvitedUserPassword, type SetPasswordState } from "./actions";

const initialState: SetPasswordState = {};

export function SetPasswordForm() {
  const [state, action, pending] = useActionState(setInvitedUserPassword, initialState);
  return <form action={action} className="mt-6 grid gap-4">
    <label className="grid gap-2 text-sm font-medium">Password<input autoComplete="new-password" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" maxLength={128} minLength={8} name="password" required type="password" /></label>
    <label className="grid gap-2 text-sm font-medium">Confirm password<input autoComplete="new-password" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" maxLength={128} minLength={8} name="confirmPassword" required type="password" /></label>
    {state.error ? <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">{state.error}</p> : null}
    <button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending} type="submit">{pending ? "Saving…" : "Set password"}</button>
  </form>;
}
