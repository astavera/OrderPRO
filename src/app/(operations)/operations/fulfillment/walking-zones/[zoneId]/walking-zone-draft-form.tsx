"use client";

import { useActionState, useState } from "react";
import { GeometryEditor } from "./geometry-editor";
import { updateWalkingZoneDraftAction, type WalkingZoneDraftActionState } from "../actions";

const weekdayOptions = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

type StoreOption = { id: string; code: string; publicId: string | null; name: string };

type Draft = {
  id: string;
  revision: number;
  status: string;
  assignmentStrategy: string;
  postalCodes: readonly string[];
  priority: number | null;
  geometryText: string;
  activeDays: readonly string[];
  maxDistanceMiles: string | null;
  maxRouteMinutes: number | null;
  minimumOrderCents: number | null;
  candidateLocationIds: readonly string[];
};

export function WalkingZoneDraftForm({
  zoneId,
  zoneName,
  draft,
  stores,
  editable,
}: {
  zoneId: string;
  zoneName: string;
  draft: Draft;
  stores: StoreOption[];
  editable: boolean;
}) {
  const [initialCommandId] = useState(() => crypto.randomUUID());
  const initialState: WalkingZoneDraftActionState = { commandId: initialCommandId, revision: draft.revision };
  const [state, action, pending] = useActionState(updateWalkingZoneDraftAction, initialState);
  const disabled = !editable || pending || draft.status === "PUBLISHED" || draft.status === "ARCHIVED";

  return (
    <form action={action} className="grid gap-6">
      <input name="commandId" type="hidden" value={state.commandId ?? initialCommandId} />
      <input name="versionId" type="hidden" value={draft.id} />
      <input name="zoneId" type="hidden" value={zoneId} />
      <input name="expectedRevision" type="hidden" value={state.revision ?? draft.revision} />

      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">Name
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" defaultValue={zoneName} disabled={disabled} maxLength={120} name="name" required />
        </label>
        <label className="grid gap-2 text-sm font-medium">Postal codes
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono outline-none focus:border-emerald-400" defaultValue={draft.postalCodes.join(", ")} disabled={disabled} name="postalCodes" placeholder="10075" required />
        </label>
        <label className="grid gap-2 text-sm font-medium">Assignment strategy
          <select className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" defaultValue={draft.assignmentStrategy} disabled={disabled} name="assignmentStrategy">
            <option value="FIXED">Fixed store</option>
            <option value="NEAREST_WALKING_ROUTE">Nearest walking route</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium">Priority (required before validation)
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 outline-none focus:border-emerald-400" defaultValue={draft.priority ?? ""} disabled={disabled} name="priority" type="number" />
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-semibold">Candidate stores</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {stores.map((store) => (
            <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm" key={store.id}>
              <input className="mt-1 size-4 accent-emerald-400" defaultChecked={draft.candidateLocationIds.includes(store.id)} disabled={disabled} name="candidateLocationIds" type="checkbox" value={store.id} />
              <span><span className="font-semibold">{store.name}</span><span className="block text-slate-400">{store.publicId ?? store.code}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Active service days (not confirmed yet)</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {weekdayOptions.map((day) => (
            <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs" key={day}>
              <input className="accent-emerald-400" defaultChecked={draft.activeDays.includes(day)} disabled={disabled} name="activeDays" type="checkbox" value={day} />
              {day.slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="grid gap-2 text-sm font-medium">Max walking miles
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" defaultValue={draft.maxDistanceMiles ?? ""} disabled={disabled} min="0" name="maxDistanceMiles" step="0.001" type="number" />
        </label>
        <label className="grid gap-2 text-sm font-medium">Max route minutes
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" defaultValue={draft.maxRouteMinutes ?? ""} disabled={disabled} min="0" name="maxRouteMinutes" step="1" type="number" />
        </label>
        <label className="grid gap-2 text-sm font-medium">Minimum order cents
          <input className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" defaultValue={draft.minimumOrderCents ?? ""} disabled={disabled} min="0" name="minimumOrderCents" step="1" type="number" />
        </label>
      </div>

      <GeometryEditor disabled={disabled} initialValue={draft.geometryText} />

      {!editable ? <p className="rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-300">Your role has read-only fulfillment access.</p> : null}
      {state.success ? <p className="text-sm text-emerald-300" role="status">{state.success}</p> : null}
      {state.error ? <p className="text-sm text-red-300" role="alert">{state.error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded-xl bg-emerald-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={disabled} type="submit">{pending ? "Saving..." : "Save draft"}</button>
        <p className="text-xs text-slate-500">Revision {state.revision ?? draft.revision}. Saving does not publish.</p>
      </div>
    </form>
  );
}
