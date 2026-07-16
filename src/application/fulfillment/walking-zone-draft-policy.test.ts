import { describe, expect, it } from "vitest";
import { validateWalkingZoneDraft, type WalkingZoneDraftInput } from "./walking-zone-draft-policy";

const base: WalkingZoneDraftInput = {
  name: "Walking delivery 10075",
  postalCodes: ["10075"],
  priority: 100,
  assignmentStrategy: "NEAREST_WALKING_ROUTE",
  candidateLocationIds: ["store-a", "store-b"],
  geometry: {
    type: "Polygon",
    coordinates: [[[-74, 40], [-73, 40], [-73, 41], [-74, 41], [-74, 40]]],
  },
  activeDays: ["MONDAY"],
  maxDistanceMiles: null,
  maxRouteMinutes: null,
  minimumOrderCents: null,
};

describe("walking-zone draft policy", () => {
  it("accepts a structurally valid editable draft", () => {
    expect(validateWalkingZoneDraft(base)).toEqual([]);
  });

  it("permits unconfirmed optional publication values to remain null", () => {
    expect(validateWalkingZoneDraft({ ...base, priority: null, geometry: null, activeDays: [] })).toEqual([]);
  });

  it("enforces deterministic strategy candidate counts", () => {
    expect(
      validateWalkingZoneDraft({ ...base, assignmentStrategy: "FIXED", candidateLocationIds: ["a", "b"] }),
    ).toContain("FIXED_CANDIDATE_COUNT_INVALID");
    expect(validateWalkingZoneDraft({ ...base, candidateLocationIds: ["a"] })).toContain(
      "NEAREST_CANDIDATE_COUNT_INVALID",
    );
  });

  it("rejects corrupt supplied geometry while allowing it to be omitted", () => {
    expect(validateWalkingZoneDraft({ ...base, geometry: { type: "Polygon", coordinates: [] } })).toContain(
      "GEOMETRY_INVALID",
    );
  });
});
