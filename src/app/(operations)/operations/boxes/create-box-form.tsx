"use client";

import { useActionState, useState } from "react";
import { createBoxAction, type CreateBoxState } from "./actions";

type LocationOption = { id: string; code: string; name: string };
const initialState: CreateBoxState = {};

export function CreateBoxForm({ locations }: { locations: LocationOption[] }) {
  const [state, action, pending] = useActionState(createBoxAction, initialState);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  return <form action={async (data) => { await action(data); setCommandId(crypto.randomUUID()); }} className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-2"><input name="commandId" type="hidden" value={commandId} /><label className="grid gap-2 text-sm font-medium">Commercial owner<select className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" name="ownerLocationId" required>{locations.map((location) => <option key={location.id} value={location.id}>{location.code} — {location.name}</option>)}</select></label><label className="grid gap-2 text-sm font-medium">Current physical location<select className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" name="currentLocationId" required>{locations.map((location) => <option key={location.id} value={location.id}>{location.code} — {location.name}</option>)}</select></label><div className="flex items-center gap-4 sm:col-span-2"><button className="rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-60" disabled={pending} type="submit">{pending ? "Creating…" : "Create empty box"}</button>{state.success ? <p className="text-sm text-emerald-300" role="status">{state.success}</p> : null}{state.error ? <p className="text-sm text-red-300" role="alert">{state.error}</p> : null}</div></form>;
}
