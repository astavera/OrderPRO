"use client";

import type { LocationType, RoleCode } from "@prisma/client";
import { useActionState } from "react";
import { roleLabels } from "@/application/auth/permissions";
import { updateUserAccessAction, type UserManagementState } from "./actions";

type LocationOption = { id: string; code: string; name: string; type: LocationType };
type EditableUser = {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
  version: number;
  roles: RoleCode[];
  locationIds: string[];
};
const initialState: UserManagementState = {};

export function UserAccessForm({ user, roles, locations, isSelf }: { user: EditableUser; roles: RoleCode[]; locations: LocationOption[]; isSelf: boolean }) {
  const [state, action, pending] = useActionState(updateUserAccessAction, initialState);

  return <form action={action} className="grid gap-6">
    <input name="userId" type="hidden" value={user.id} />
    <input name="expectedVersion" type="hidden" value={user.version} />
    <div className="grid gap-4 md:grid-cols-2">
      <label className="grid gap-2 text-sm font-medium">Display name<input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" defaultValue={user.displayName} maxLength={100} name="displayName" required /></label>
      <label className="grid gap-2 text-sm font-medium">Email<input className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 text-slate-500" disabled readOnly value={user.email} /></label>
    </div>
    <label className="grid max-w-sm gap-2 text-sm font-medium">Account status<select className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" defaultValue={String(user.active)} disabled={isSelf} name={isSelf ? undefined : "active"}><option value="true">Active</option><option value="false">Inactive</option></select>{isSelf ? <><input name="active" type="hidden" value="true" /><span className="text-xs text-amber-300">You cannot deactivate your own account.</span></> : null}</label>
    <fieldset><legend className="text-sm font-semibold">Roles</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{roles.map((role) => <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm" key={role}><input className="size-4 accent-emerald-400" defaultChecked={user.roles.includes(role)} name="roles" type="checkbox" value={role} />{roleLabels[role]}</label>)}</div></fieldset>
    <fieldset><legend className="text-sm font-semibold">Operational locations</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{locations.map((location) => <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm" key={location.id}><input className="mt-1 size-4 accent-emerald-400" defaultChecked={user.locationIds.includes(location.id)} name="locationIds" type="checkbox" value={location.id} /><span><span className="font-semibold">{location.code}</span><span className="block text-slate-400">{location.name} · {location.type}</span></span></label>)}</div></fieldset>
    <label className="grid gap-2 text-sm font-medium">Reason for change<textarea className="min-h-24 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" maxLength={500} minLength={3} name="reason" required /></label>
    {state.success ? <p className="text-sm text-emerald-300" role="status">{state.success}</p> : null}
    {state.error ? <p className="text-sm text-red-300" role="alert">{state.error}</p> : null}
    <div><button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending} type="submit">{pending ? "Saving…" : "Save access"}</button></div>
  </form>;
}
