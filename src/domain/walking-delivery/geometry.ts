import type {
  WalkingGeometry,
  WalkingGeometryValidationIssue,
  WalkingGeometryValidationResult,
  WalkingLinearRing,
  WalkingPolygonCoordinates,
  WalkingPosition,
} from "./types";

const EPSILON = 1e-10;

function positionsEqual(left: WalkingPosition, right: WalkingPosition) {
  return left[0] === right[0] && left[1] === right[1];
}

function isFinitePosition(value: unknown): value is WalkingPosition {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

export function isValidWalkingPosition(value: unknown): value is WalkingPosition {
  return isFinitePosition(value) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function crossProduct(first: WalkingPosition, second: WalkingPosition, third: WalkingPosition) {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function isPointOnSegment(point: WalkingPosition, start: WalkingPosition, end: WalkingPosition) {
  if (Math.abs(crossProduct(start, end, point)) > EPSILON) {
    return false;
  }

  return (
    point[0] >= Math.min(start[0], end[0]) - EPSILON &&
    point[0] <= Math.max(start[0], end[0]) + EPSILON &&
    point[1] >= Math.min(start[1], end[1]) - EPSILON &&
    point[1] <= Math.max(start[1], end[1]) + EPSILON
  );
}

function segmentsIntersect(
  firstStart: WalkingPosition,
  firstEnd: WalkingPosition,
  secondStart: WalkingPosition,
  secondEnd: WalkingPosition,
) {
  const firstSideStart = crossProduct(firstStart, firstEnd, secondStart);
  const firstSideEnd = crossProduct(firstStart, firstEnd, secondEnd);
  const secondSideStart = crossProduct(secondStart, secondEnd, firstStart);
  const secondSideEnd = crossProduct(secondStart, secondEnd, firstEnd);

  if (
    ((firstSideStart > EPSILON && firstSideEnd < -EPSILON) ||
      (firstSideStart < -EPSILON && firstSideEnd > EPSILON)) &&
    ((secondSideStart > EPSILON && secondSideEnd < -EPSILON) ||
      (secondSideStart < -EPSILON && secondSideEnd > EPSILON))
  ) {
    return true;
  }

  return (
    (Math.abs(firstSideStart) <= EPSILON && isPointOnSegment(secondStart, firstStart, firstEnd)) ||
    (Math.abs(firstSideEnd) <= EPSILON && isPointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (Math.abs(secondSideStart) <= EPSILON && isPointOnSegment(firstStart, secondStart, secondEnd)) ||
    (Math.abs(secondSideEnd) <= EPSILON && isPointOnSegment(firstEnd, secondStart, secondEnd))
  );
}

function signedRingArea(ring: WalkingLinearRing) {
  let twiceArea = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }

  return twiceArea / 2;
}

function ringHasSelfIntersection(ring: WalkingLinearRing) {
  const segmentCount = ring.length - 1;

  for (let firstIndex = 0; firstIndex < segmentCount; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segmentCount; secondIndex += 1) {
      const adjacent = secondIndex === firstIndex + 1;
      const closureAdjacent = firstIndex === 0 && secondIndex === segmentCount - 1;

      if (adjacent || closureAdjacent) {
        continue;
      }

      if (
        segmentsIntersect(
          ring[firstIndex],
          ring[firstIndex + 1],
          ring[secondIndex],
          ring[secondIndex + 1],
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function validateRing(value: unknown, path: string, issues: WalkingGeometryValidationIssue[]) {
  if (!Array.isArray(value) || value.length < 4) {
    issues.push({ code: "RING_TOO_SHORT", path, message: "A linear ring requires at least four positions." });
    return;
  }

  const positions: WalkingPosition[] = [];
  let positionsAreValid = true;

  value.forEach((position, index) => {
    const positionPath = `${path}[${index}]`;

    if (!isFinitePosition(position)) {
      positionsAreValid = false;
      issues.push({ code: "INVALID_POSITION", path: positionPath, message: "A position requires finite longitude and latitude." });
      return;
    }

    positions.push(position);

    if (!isValidWalkingPosition(position)) {
      positionsAreValid = false;
      issues.push({ code: "COORDINATE_OUT_OF_RANGE", path: positionPath, message: "Longitude or latitude is outside WGS84 bounds." });
    }
  });

  if (!positionsAreValid || positions.length !== value.length) {
    return;
  }

  if (!positionsEqual(positions[0], positions[positions.length - 1])) {
    issues.push({ code: "RING_NOT_CLOSED", path, message: "The first and last positions of a linear ring must match." });
    return;
  }

  for (let index = 0; index < positions.length - 1; index += 1) {
    if (positionsEqual(positions[index], positions[index + 1])) {
      issues.push({ code: "RING_DEGENERATE_SEGMENT", path: `${path}[${index}]`, message: "Adjacent positions cannot be identical." });
    }
  }

  if (Math.abs(signedRingArea(positions)) <= EPSILON) {
    issues.push({ code: "RING_ZERO_AREA", path, message: "A linear ring must enclose a non-zero area." });
  }

  if (ringHasSelfIntersection(positions)) {
    issues.push({ code: "RING_SELF_INTERSECTION", path, message: "The linear ring intersects itself." });
  }
}

function validatePolygon(value: unknown, path: string, issues: WalkingGeometryValidationIssue[]) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ code: "EMPTY_POLYGON", path, message: "A polygon requires an exterior linear ring." });
    return;
  }

  value.forEach((ring, index) => validateRing(ring, `${path}[${index}]`, issues));
}

export function validateWalkingGeometry(value: unknown): WalkingGeometryValidationResult {
  const issues: WalkingGeometryValidationIssue[] = [];

  if (!value || typeof value !== "object" || !("type" in value) || !("coordinates" in value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_GEOMETRY_TYPE", path: "$", message: "Expected a GeoJSON Polygon or MultiPolygon." }],
    };
  }

  const geometry = value as { type: unknown; coordinates: unknown };

  if (geometry.type === "Polygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      issues.push({ code: "EMPTY_GEOMETRY", path: "$.coordinates", message: "Polygon coordinates cannot be empty." });
    } else {
      validatePolygon(geometry.coordinates, "$.coordinates", issues);
    }
  } else if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      issues.push({ code: "EMPTY_GEOMETRY", path: "$.coordinates", message: "MultiPolygon coordinates cannot be empty." });
    } else {
      geometry.coordinates.forEach((polygon, index) => validatePolygon(polygon, `$.coordinates[${index}]`, issues));
    }
  } else {
    issues.push({ code: "INVALID_GEOMETRY_TYPE", path: "$.type", message: "Only Polygon and MultiPolygon are supported." });
  }

  return { valid: issues.length === 0, issues };
}

type RingContainment = "OUTSIDE" | "INSIDE" | "BOUNDARY";

function ringContainment(point: WalkingPosition, ring: WalkingLinearRing): RingContainment {
  const vertices = ring.slice(0, -1);

  for (let index = 0; index < ring.length - 1; index += 1) {
    if (isPointOnSegment(point, ring[index], ring[index + 1])) {
      return "BOUNDARY";
    }
  }

  let inside = false;
  for (let currentIndex = 0, previousIndex = vertices.length - 1; currentIndex < vertices.length; previousIndex = currentIndex, currentIndex += 1) {
    const current = vertices[currentIndex];
    const previous = vertices[previousIndex];
    const crossesLatitude = current[1] > point[1] !== previous[1] > point[1];

    if (
      crossesLatitude &&
      point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / (previous[1] - current[1]) + current[0]
    ) {
      inside = !inside;
    }
  }

  return inside ? "INSIDE" : "OUTSIDE";
}

function pointInPolygon(point: WalkingPosition, polygon: WalkingPolygonCoordinates) {
  if (ringContainment(point, polygon[0]) === "OUTSIDE") {
    return false;
  }

  for (let holeIndex = 1; holeIndex < polygon.length; holeIndex += 1) {
    if (ringContainment(point, polygon[holeIndex]) !== "OUTSIDE") {
      return false;
    }
  }

  return true;
}

export function pointInWalkingGeometry(point: WalkingPosition, geometry: WalkingGeometry) {
  if (!isValidWalkingPosition(point) || !validateWalkingGeometry(geometry).valid) {
    return false;
  }

  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }

  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}
