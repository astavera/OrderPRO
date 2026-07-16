"use client";

import type { LocationType, RoleCode } from "@prisma/client";
import { useActionState } from "react";
import { roleLabels } from "@/application/auth/permissions";
import { inviteUserAction, type UserManagementState } from "./actions";

type LocationOption = { id: string; code: string; name: string; type: LocationType };
const initialState: UserManagementState = {};

export function InviteUserForm({
  configured,
  roles,
  locations,
}: {
  configured: boolean;
  roles: RoleCode[];
  locations: LocationOption[];
}) {
  const [state, action, pending] = useActionState(inviteUserAction, initialState);

  return <form action={action} className="mt-5 grid gap-5">
    <div className="grid gap-4 md:grid-cols-2">
      <label className="grid gap-2 text-sm font-medium">Display name<input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" maxLength={100} name="displayName" required /></label>
      <label className="grid gap-2 text-sm font-medium">Email<input autoComplete="email" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" maxLength={254} name="email" required type="email" /></label>
    </div>
    <fieldset><legend className="text-sm font-semibold">Roles</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{roles.map((role) => <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm" key={role}><input className="size-4 accent-emerald-400" name="roles" type="checkbox" value={role} />{roleLabels[role]}</label>)}</div></fieldset>
    <fieldset><legend className="text-sm font-semibold">Operational locations</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{locations.map((location) => <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm" key={location.id}><input className="mt-1 size-4 accent-emerald-400" name="locationIds" type="checkbox" value={location.id} /><span><span className="font-semibold">{location.code}</span><span className="block text-slate-400">{location.name} · {location.type}</span></span></label>)}</div></fieldset>
    {!configured ? <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200" role="alert">Add the server-only Supabase secret key before sending invitations.</p> : null}
    {state.success ? <p className="text-sm text-emerald-300" role="status">{state.success}</p> : null}
    {state.error ? <p className="text-sm text-red-300" role="alert">{state.error}</p> : null}
    <div><button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending || !configured} type="submit">{pending ? "Sending…" : "Send invitation"}</button></div>
  </form>;
}
