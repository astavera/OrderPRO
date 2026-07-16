"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(login, initialState);
  return (
    <form action={action} className="mt-8 grid gap-5">
      <label className="grid gap-2 text-sm font-medium">Email<input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" name="email" type="email" autoComplete="username" required /></label>
      <label className="grid gap-2 text-sm font-medium">Password<input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
      {state.error ? <p aria-live="polite" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">{state.error}</p> : null}
      <button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-60" disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
