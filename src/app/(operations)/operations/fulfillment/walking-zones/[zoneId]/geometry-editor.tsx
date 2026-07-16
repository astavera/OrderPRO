"use client";

import { useMemo, useState } from "react";
import { validateWalkingGeometry } from "@/domain/walking-delivery/geometry";
import type { WalkingGeometry, WalkingPolygonCoordinates, WalkingPosition } from "@/domain/walking-delivery/types";

function polygons(geometry: WalkingGeometry): readonly WalkingPolygonCoordinates[] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function renderPath(geometry: WalkingGeometry) {
  const points = polygons(geometry).flat(2) as WalkingPosition[];
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const longitudeSpan = Math.max(maxLongitude - minLongitude, 0.000001);
  const latitudeSpan = Math.max(maxLatitude - minLatitude, 0.000001);
  const project = ([longitude, latitude]: WalkingPosition) => [
    18 + ((longitude - minLongitude) / longitudeSpan) * 524,
    242 - ((latitude - minLatitude) / latitudeSpan) * 224,
  ];

  return polygons(geometry).map((polygon) =>
    polygon
      .map((ring) => ring.map((point, index) => `${index === 0 ? "M" : "L"}${project(point).join(" ")}`).join(" ") + " Z")
      .join(" "),
  );
}

export function GeometryEditor({ initialValue, disabled }: { initialValue: string; disabled: boolean }) {
  const [value, setValue] = useState(initialValue);
  const preview = useMemo(() => {
    if (!value.trim()) return { geometry: null, issues: ["No geometry uploaded yet."] };
    try {
      const geometry = JSON.parse(value) as unknown;
      const result = validateWalkingGeometry(geometry);
      return result.valid
        ? { geometry: geometry as WalkingGeometry, issues: [] as string[] }
        : { geometry: null, issues: result.issues.map((issue) => `${issue.code}: ${issue.path}`) };
    } catch {
      return { geometry: null, issues: ["GeoJSON is not valid JSON."] };
    }
  }, [value]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Polygon / MultiPolygon GeoJSON</p>
          <p className="mt-1 text-xs text-slate-400">WGS84 coordinates only. Saving never publishes the geometry.</p>
        </div>
        <label className="rounded-xl border border-slate-700 px-3 py-2 text-sm hover:border-emerald-400/60">
          Import GeoJSON
          <input
            accept="application/geo+json,application/json,.geojson,.json"
            className="sr-only"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(setValue);
            }}
            type="file"
          />
        </label>
      </div>
      <textarea
        className="min-h-48 rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs outline-none focus:border-emerald-400 disabled:opacity-70"
        disabled={disabled}
        name="geometryText"
        onChange={(event) => setValue(event.target.value)}
        placeholder='{"type":"Polygon","coordinates":[...]}'
        value={value}
      />
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
        {preview.geometry ? (
          <svg aria-label="GeoJSON geometry preview" className="h-64 w-full" role="img" viewBox="0 0 560 260">
            <rect fill="#020617" height="260" width="560" />
            {renderPath(preview.geometry).map((path, index) => (
              <path d={path} fill="#34d39944" fillRule="evenodd" key={index} stroke="#34d399" strokeWidth="2" />
            ))}
            <text fill="#64748b" fontSize="11" x="14" y="254">Geometry preview - no production basemap</text>
          </svg>
        ) : (
          <div className="grid min-h-64 place-content-center gap-2 p-6 text-center text-sm text-amber-200">
            <p>Geometry preview unavailable</p>
            {preview.issues.slice(0, 4).map((issue) => <p className="font-mono text-xs text-slate-500" key={issue}>{issue}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}
