import { createHash } from "node:crypto";
import {
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS,
  LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT,
  LOCAL_WALKING_DELIVERY_V4_LOCATIONS,
  LOCAL_WALKING_DELIVERY_V4_POLICY_ID,
  LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE,
  LOCAL_WALKING_DELIVERY_V4_STRATEGY,
  evaluateLocalWalkingDeliveryV4Tier,
  type LocalWalkingDeliveryV4LocationId,
} from "../../domain/walking-delivery/local-walking-delivery-v4";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
  LocalDeliveryApplicationError,
  LocalDeliveryRoutingError,
  type EvaluateLocalDeliveryQuoteCommand,
  type LocalDeliveryAddress,
  type LocalDeliveryAssignment,
  type LocalDeliveryCandidateRoute,
  type LocalDeliveryCoordinates,
  type LocalDeliveryGeocode,
  type LocalDeliveryGeocodedAddress,
  type LocalDeliveryInventoryAssessment,
  type LocalDeliveryLocation,
  type LocalDeliveryNormalizedAddress,
  type LocalDeliveryPolicySnapshot,
  type LocalDeliveryQuoteDependencies,
  type LocalDeliveryQuoteResult,
  type LocalDeliverySlot,
} from "./contracts";

const METERS_TO_FEET = 3.280839895013123;
const CONTACT_STORE_QUOTE_TTL_SECONDS = 300;
const SUPPORTED_POSTAL_CODES = new Set(["10021", "10065", "10075", "10028", "10128"]);
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEW_YORK_TIME_ZONE = "America/New_York";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(command: EvaluateLocalDeliveryQuoteCommand) {
  return `sha256:${createHash("sha256")
    .update(stableJson({
      address: command.address,
      cartLines: command.cartLines,
      clientId: command.clientId,
      environment: command.environment,
      requestedDate: command.requestedDate,
    }))
    .digest("hex")}`;
}

function validDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function validInstant(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCoordinates(value: unknown): value is LocalDeliveryCoordinates {
  return (
    isRecord(value) &&
    typeof value.latitude === "number" &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === "number" &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

function validAddress(value: unknown): value is LocalDeliveryAddress {
  if (!isRecord(value)) return false;
  const address = value;
  return (
    typeof address.line1 === "string" &&
    address.line1.trim().length >= 3 &&
    address.line1.length <= 200 &&
    (address.line2 === null ||
      (typeof address.line2 === "string" && address.line2.length <= 200)) &&
    typeof address.city === "string" &&
    address.city.trim().length >= 2 &&
    address.city.length <= 100 &&
    typeof address.state === "string" &&
    address.state.trim().length === 2 &&
    typeof address.postalCode === "string" &&
    /^\d{5}(?:-\d{4})?$/.test(address.postalCode.trim()) &&
    typeof address.country === "string" &&
    address.country.trim().length === 2
  );
}

function validGeocodedAddress(value: unknown): value is LocalDeliveryGeocodedAddress {
  if (!isRecord(value)) return false;
  const borough = value["borough"];
  if (!validAddress(value)) return false;
  return (
    typeof borough === "string" &&
    borough.trim().length > 0 &&
    borough.length <= 100
  );
}

function validCommand(command: EvaluateLocalDeliveryQuoteCommand) {
  return (
    stableId.test(command.clientId) &&
    command.clientId.length <= 120 &&
    stableId.test(command.correlationId) &&
    command.correlationId.length <= 120 &&
    command.idempotencyKey.length >= 8 &&
    command.idempotencyKey.length <= 160 &&
    validAddress(command.address) &&
    validDate(command.requestedDate) &&
    command.cartLines.length > 0 &&
    command.cartLines.length <= 100 &&
    command.cartLines.every(
      (line) =>
        stableId.test(line.variantId) &&
        line.variantId.length <= 160 &&
        Number.isInteger(line.quantity) &&
        line.quantity > 0 &&
        line.quantity <= 999,
    )
  );
}

function validGeocode(geocode: unknown): geocode is LocalDeliveryGeocode {
  return Boolean(
    isRecord(geocode) &&
      geocode.exactAddress === true &&
      geocode.ambiguous === false &&
      typeof geocode.isManhattan === "boolean" &&
      typeof geocode.provider === "string" &&
      geocode.provider.trim().length > 0 &&
      geocode.provider.length <= 80 &&
      typeof geocode.postalCode === "string" &&
      /^\d{5}$/.test(geocode.postalCode) &&
      validGeocodedAddress(geocode.normalizedAddress) &&
      geocode.normalizedAddress.postalCode === geocode.postalCode &&
      validCoordinates(geocode.coordinates),
  );
}

function isManhattanGeocode(
  geocode: LocalDeliveryGeocode,
): geocode is LocalDeliveryGeocode & {
  readonly isManhattan: true;
  readonly normalizedAddress: LocalDeliveryNormalizedAddress;
} {
  return (
    geocode.isManhattan === true &&
    geocode.normalizedAddress.city === "New York" &&
    geocode.normalizedAddress.borough === "Manhattan" &&
    geocode.normalizedAddress.state === "NY" &&
    geocode.normalizedAddress.country === "US"
  );
}

function validLocation(value: unknown): value is LocalDeliveryLocation {
  if (!isRecord(value)) return false;
  const location = value;
  if (typeof location.locationId !== "string") return false;
  const canonical = LOCAL_WALKING_DELIVERY_V4_LOCATIONS[
    location.locationId as LocalWalkingDeliveryV4LocationId
  ];
  if (!canonical) return false;
  return (
    stableId.test(location.locationId) &&
    typeof location.name === "string" &&
    location.name === canonical.name &&
    typeof location.address === "string" &&
    location.address === canonical.address &&
    validCoordinates(location.coordinates) &&
    location.coordinates.latitude === canonical.latitude &&
    location.coordinates.longitude === canonical.longitude &&
    typeof location.priority === "number" &&
    Number.isInteger(location.priority) &&
    location.priority > 0
  );
}

function validAssignment(
  value: unknown,
  postalCode: string,
): value is LocalDeliveryAssignment {
  if (
    !isRecord(value) ||
    (value.rule !== "FIXED_POSTAL_ZONE" && value.rule !== "NEAREST_WALKING_ROUTE") ||
    !Array.isArray(value.candidates)
  ) {
    return false;
  }
  const candidates: LocalDeliveryLocation[] = [];
  for (const candidate of value.candidates) {
    if (!validLocation(candidate)) return false;
    candidates.push(candidate);
  }
  const expectedLocationIds = postalCode === "10075"
    ? ["third_avenue", "east_86th_street"]
    : postalCode === "10021" || postalCode === "10065"
      ? ["third_avenue"]
      : postalCode === "10028" || postalCode === "10128"
        ? ["east_86th_street"]
        : [];
  const expectedRule = postalCode === "10075"
    ? "NEAREST_WALKING_ROUTE"
    : "FIXED_POSTAL_ZONE";
  const actualLocationIds = new Set(
    candidates.map(({ locationId }) => locationId),
  );
  return (
    value.rule === expectedRule &&
    candidates.length === expectedLocationIds.length &&
    actualLocationIds.size === expectedLocationIds.length &&
    expectedLocationIds.every((locationId) => actualLocationIds.has(locationId)) &&
    (value.rule === "FIXED_POSTAL_ZONE" ||
      new Set(candidates.map(({ priority }) => priority)).size === expectedLocationIds.length)
  );
}

function validPolicy(
  value: unknown,
  environment: EvaluateLocalDeliveryQuoteCommand["environment"],
): value is LocalDeliveryPolicySnapshot {
  if (!isRecord(value)) return false;
  const policy = value;
  return (
    environment === "STAGING" &&
    policy.environment === environment &&
    policy.policyId === LOCAL_WALKING_DELIVERY_V4_POLICY_ID &&
    policy.feePolicyVersionId === LOCAL_DELIVERY_FEE_POLICY_VERSION_ID &&
    policy.zoneVersionId === LOCAL_DELIVERY_ZONE_VERSION_ID &&
    policy.strategy === LOCAL_WALKING_DELIVERY_V4_STRATEGY &&
    policy.distanceBasis === LOCAL_WALKING_DELIVERY_V4_DISTANCE_BASIS &&
    policy.distanceUnit === LOCAL_WALKING_DELIVERY_V4_DISTANCE_UNIT &&
    policy.routingMode === LOCAL_WALKING_DELIVERY_V4_ROUTING_MODE &&
    policy.currency === "USD" &&
    policy.routingProfile === "walking" &&
    typeof policy.quoteTtlSeconds === "number" &&
    Number.isInteger(policy.quoteTtlSeconds) &&
    policy.quoteTtlSeconds >= 60 &&
    policy.quoteTtlSeconds <= 86_400 &&
    typeof policy.holdTtlSeconds === "number" &&
    Number.isInteger(policy.holdTtlSeconds) &&
    policy.holdTtlSeconds >= 30 &&
    policy.holdTtlSeconds <= 3_600 &&
    typeof policy.preparationBufferSeconds === "number" &&
    Number.isInteger(policy.preparationBufferSeconds) &&
    policy.preparationBufferSeconds >= 0 &&
    policy.preparationBufferSeconds <= 14_400 &&
    typeof policy.handoffBufferSeconds === "number" &&
    Number.isInteger(policy.handoffBufferSeconds) &&
    policy.handoffBufferSeconds >= 0 &&
    policy.handoffBufferSeconds <= 14_400
  );
}

function distanceMetersToFeet(distanceMeters: number) {
  return Math.round((distanceMeters * METERS_TO_FEET + Number.EPSILON) * 100) / 100;
}

function selectRoute(
  assignment: LocalDeliveryAssignment,
  routes: readonly LocalDeliveryCandidateRoute[],
) {
  const locations = new Map(assignment.candidates.map((location) => [location.locationId, location]));
  return [...routes].sort((left, right) => {
    const distance = left.walkingDistanceFeet - right.walkingDistanceFeet;
    if (distance !== 0) return distance;
    const duration = left.walkingDurationSeconds - right.walkingDurationSeconds;
    if (duration !== 0) return duration;
    return locations.get(left.locationId)!.priority - locations.get(right.locationId)!.priority;
  })[0];
}

function dateInNewYork(instant: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function validSlot(
  value: unknown,
  selectedLocationId: string,
  requestedDate: string,
  calculatedAt: string,
): value is LocalDeliverySlot {
  if (!isRecord(value)) return false;
  const slot = value;
  return (
    typeof slot.slotId === "string" &&
    stableId.test(slot.slotId) &&
    slot.slotId.length <= 160 &&
    slot.locationId === selectedLocationId &&
    typeof slot.startsAt === "string" &&
    validInstant(slot.startsAt) &&
    typeof slot.endsAt === "string" &&
    validInstant(slot.endsAt) &&
    Date.parse(slot.startsAt) > Date.parse(calculatedAt) &&
    Date.parse(slot.endsAt) > Date.parse(slot.startsAt) &&
    dateInNewYork(slot.startsAt) === requestedDate &&
    typeof slot.remainingCapacitySeconds === "number" &&
    Number.isInteger(slot.remainingCapacitySeconds) &&
    slot.remainingCapacitySeconds > 0
  );
}

function validInventoryAssessment(
  value: unknown,
  cartLines: EvaluateLocalDeliveryQuoteCommand["cartLines"],
): value is LocalDeliveryInventoryAssessment {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !["READY", "TRANSFER_REQUIRED", "NOT_READY"].includes(value.status) ||
    !Array.isArray(value.lines)
  ) {
    return false;
  }

  if (value.status === "NOT_READY") {
    return value.lines.length === 0 && value.earliestReadyAt === null;
  }

  if (value.lines.length !== cartLines.length) return false;
  const lineNumbers = new Set<number>();
  let hasTransferLine = false;
  let latestReadyAt: number | null = null;
  for (const candidate of value.lines) {
    if (!isRecord(candidate)) return false;
    const lineNumber = candidate.lineNumber;
    if (
      typeof lineNumber !== "number" ||
      !Number.isInteger(lineNumber) ||
      lineNumber < 1 ||
      lineNumber > cartLines.length ||
      lineNumbers.has(lineNumber)
    ) {
      return false;
    }
    const cartLine = cartLines[lineNumber - 1];
    if (
      !cartLine ||
      candidate.variantId !== cartLine.variantId ||
      candidate.quantity !== cartLine.quantity ||
      typeof candidate.productId !== "string" ||
      !uuid.test(candidate.productId) ||
      (candidate.readinessStatus !== "READY" &&
        candidate.readinessStatus !== "TRANSFER_REQUIRED") ||
      typeof candidate.inventoryOwnerLocationId !== "string" ||
      !uuid.test(candidate.inventoryOwnerLocationId) ||
      typeof candidate.inventoryOwnerExternalLocationId !== "string" ||
      !stableId.test(candidate.inventoryOwnerExternalLocationId) ||
      candidate.inventoryOwnerExternalLocationId.length > 64 ||
      typeof candidate.inventoryNodeId !== "string" ||
      !uuid.test(candidate.inventoryNodeId) ||
      typeof candidate.inventoryNodeExternalId !== "string" ||
      !stableId.test(candidate.inventoryNodeExternalId) ||
      candidate.inventoryNodeExternalId.length > 64 ||
      (candidate.containerId !== null &&
        (typeof candidate.containerId !== "string" || !uuid.test(candidate.containerId))) ||
      (candidate.storageLocationId !== null &&
        (typeof candidate.storageLocationId !== "string" ||
          !uuid.test(candidate.storageLocationId))) ||
      (candidate.containerId === null && candidate.storageLocationId === null) ||
      !["NOT_REQUIRED", "TRANSFER_REQUIRED", "REQUESTED", "IN_TRANSIT", "RECEIVED", "READY"].includes(
        String(candidate.transferStatus),
      ) ||
      (candidate.earliestReadyAt !== null &&
        (typeof candidate.earliestReadyAt !== "string" ||
          !validInstant(candidate.earliestReadyAt)))
    ) {
      return false;
    }
    if (
      candidate.readinessStatus === "READY" &&
      candidate.transferStatus !== "NOT_REQUIRED" &&
      candidate.transferStatus !== "READY"
    ) {
      return false;
    }
    if (candidate.readinessStatus === "TRANSFER_REQUIRED") {
      if (
        candidate.earliestReadyAt === null ||
        !["TRANSFER_REQUIRED", "REQUESTED", "IN_TRANSIT", "RECEIVED"].includes(
          String(candidate.transferStatus),
        )
      ) {
        return false;
      }
      hasTransferLine = true;
    }
    if (candidate.earliestReadyAt !== null) {
      const timestamp = Date.parse(candidate.earliestReadyAt);
      latestReadyAt = latestReadyAt === null ? timestamp : Math.max(latestReadyAt, timestamp);
    }
    lineNumbers.add(lineNumber);
  }

  if (value.status === "READY" && hasTransferLine) return false;
  if (value.status === "TRANSFER_REQUIRED" && !hasTransferLine) return false;
  if (
    value.earliestReadyAt !== null &&
    (typeof value.earliestReadyAt !== "string" || !validInstant(value.earliestReadyAt))
  ) {
    return false;
  }
  return latestReadyAt === null
    ? value.earliestReadyAt === null
    : typeof value.earliestReadyAt === "string" &&
        Date.parse(value.earliestReadyAt) === latestReadyAt;
}

async function geocodeAddress(
  command: EvaluateLocalDeliveryQuoteCommand,
  dependencies: LocalDeliveryQuoteDependencies,
) {
  let geocode: LocalDeliveryGeocode | null;
  try {
    geocode = await dependencies.geocoder.geocodeExactAddress({
      address: command.address,
      correlationId: command.correlationId,
    });
  } catch {
    throw new LocalDeliveryApplicationError("INVALID_ADDRESS");
  }
  if (!validGeocode(geocode)) throw new LocalDeliveryApplicationError("INVALID_ADDRESS");
  return geocode;
}

async function calculateRoutes(
  assignment: LocalDeliveryAssignment,
  destination: LocalDeliveryCoordinates,
  correlationId: string,
  dependencies: LocalDeliveryQuoteDependencies,
) {
  try {
    const routes = await Promise.all(
      assignment.candidates.map(async (location): Promise<LocalDeliveryCandidateRoute> => {
        const route = await dependencies.router.getWalkingRoute({
          origin: location.coordinates,
          destination,
          correlationId,
        });
        if (
          route.profile !== "walking" ||
          !route.provider.trim() ||
          route.provider.length > 80 ||
          !Number.isFinite(route.distanceMeters) ||
          route.distanceMeters < 0 ||
          !Number.isInteger(route.durationSeconds) ||
          route.durationSeconds < 0
        ) {
          throw new LocalDeliveryRoutingError("DISTANCE_UNAVAILABLE");
        }
        return {
          locationId: location.locationId,
          locationPriority: location.priority,
          walkingDistanceFeet: distanceMetersToFeet(route.distanceMeters),
          walkingDurationSeconds: route.durationSeconds,
          routingProvider: route.provider,
        };
      }),
    );
    if (new Set(routes.map(({ routingProvider }) => routingProvider)).size !== 1) {
      throw new LocalDeliveryRoutingError("ROUTING_PROVIDER_UNAVAILABLE");
    }
    return routes;
  } catch (error) {
    if (error instanceof LocalDeliveryRoutingError) {
      throw new LocalDeliveryApplicationError(error.code);
    }
    throw new LocalDeliveryApplicationError("ROUTING_PROVIDER_UNAVAILABLE");
  }
}

export async function evaluateLocalDeliveryQuote(
  command: EvaluateLocalDeliveryQuoteCommand,
  dependencies: LocalDeliveryQuoteDependencies,
): Promise<LocalDeliveryQuoteResult> {
  if (!validCommand(command)) throw new LocalDeliveryApplicationError("INVALID_REQUEST");

  const hash = requestHash(command);
  const existing = await dependencies.quotes.findByIdempotency({
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
  });
  if (existing) {
    if (existing.requestHash !== hash) throw new LocalDeliveryApplicationError("IDEMPOTENCY_CONFLICT");
    return { ...existing.quote, replayed: true };
  }

  const calculatedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const geocode = await geocodeAddress(command, dependencies);
  if (!isManhattanGeocode(geocode)) {
    throw new LocalDeliveryApplicationError("ADDRESS_NOT_IN_MANHATTAN");
  }

  if (!SUPPORTED_POSTAL_CODES.has(geocode.postalCode)) {
    return dependencies.quotes.save({
      clientId: command.clientId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hash,
      cartLines: command.cartLines,
      persistencePlan: { kind: "CONTACT_STORE", calculatedAt },
      quote: {
        eligible: false,
        bookable: false,
        reasonCode: "CONTACT_STORE",
        storefrontMessage: "Contact store",
        normalizedAddress: geocode.normalizedAddress,
        coordinates: geocode.coordinates,
        postalCode: geocode.postalCode,
        correlationId: command.correlationId,
        expiresAt: new Date(Date.parse(calculatedAt) + CONTACT_STORE_QUOTE_TTL_SECONDS * 1_000).toISOString(),
      },
    });
  }

  let policy: LocalDeliveryPolicySnapshot | null;
  let assignment: LocalDeliveryAssignment | null;
  try {
    policy = await dependencies.policy.getPublishedPolicy({
      environment: command.environment,
      calculatedAt,
    });
    if (!validPolicy(policy, command.environment)) {
      throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
    }
    assignment = await dependencies.policy.getAssignment({
      postalCode: geocode.postalCode,
      feePolicyVersionId: policy.feePolicyVersionId,
      zoneVersionId: policy.zoneVersionId,
      environment: command.environment,
      calculatedAt,
    });
  } catch (error) {
    if (error instanceof LocalDeliveryApplicationError) throw error;
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }
  if (!assignment || !validAssignment(assignment, geocode.postalCode)) {
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }

  let inPublishedZone: boolean;
  try {
    inPublishedZone = await dependencies.zone.containsPoint({
      zoneVersionId: policy.zoneVersionId,
      postalCode: geocode.postalCode,
      coordinates: geocode.coordinates,
      calculatedAt,
    });
  } catch {
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }
  if (!inPublishedZone) throw new LocalDeliveryApplicationError("OUTSIDE_WALKING_AREA");

  const candidateRoutes = await calculateRoutes(
    assignment,
    geocode.coordinates,
    command.correlationId,
    dependencies,
  );
  const selectedRoute = selectRoute(assignment, candidateRoutes);
  const selectedLocation = assignment.candidates.find(
    ({ locationId }) => locationId === selectedRoute.locationId,
  );
  if (!selectedLocation) throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");

  let fee;
  try {
    fee = await dependencies.policy.evaluateFee({
      feePolicyVersionId: policy.feePolicyVersionId,
      environment: command.environment,
      calculatedAt,
      walkingDistanceFeet: selectedRoute.walkingDistanceFeet,
    });
  } catch {
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }
  if (
    !fee ||
    !Number.isInteger(fee.feeCents) ||
    fee.feeCents < 0 ||
    !stableId.test(fee.tierId)
  ) {
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }
  const canonicalFee = evaluateLocalWalkingDeliveryV4Tier(
    selectedRoute.walkingDistanceFeet,
  );
  if (
    !canonicalFee.valid ||
    fee.feeCents !== canonicalFee.feeCents ||
    fee.tierId !== canonicalFee.feeTierId
  ) {
    throw new LocalDeliveryApplicationError("POLICY_VERSION_UNAVAILABLE");
  }

  let inventory;
  try {
    inventory = await dependencies.inventory.assess({
      deliveryLocationId: selectedLocation.locationId,
      cartLines: command.cartLines,
      requestedDate: command.requestedDate,
      correlationId: command.correlationId,
    });
  } catch {
    throw new LocalDeliveryApplicationError("INVENTORY_NOT_READY");
  }
  if (
    !validInventoryAssessment(inventory, command.cartLines) ||
    inventory.status === "NOT_READY" ||
    (inventory.status === "TRANSFER_REQUIRED" &&
      (!inventory.earliestReadyAt || !validInstant(inventory.earliestReadyAt)))
  ) {
    throw new LocalDeliveryApplicationError("INVENTORY_NOT_READY");
  }

  const roundTripDistanceFeet = Math.round(selectedRoute.walkingDistanceFeet * 200) / 100;
  const estimatedRoundTripDurationSeconds = selectedRoute.walkingDurationSeconds * 2;
  const requiredCapacitySeconds = estimatedRoundTripDurationSeconds +
    policy.preparationBufferSeconds + policy.handoffBufferSeconds;
  if (!Number.isSafeInteger(requiredCapacitySeconds) || requiredCapacitySeconds <= 0) {
    throw new LocalDeliveryApplicationError("DISTANCE_UNAVAILABLE");
  }
  let slots: readonly LocalDeliverySlot[];
  try {
    slots = await dependencies.slots.getAvailableSlots({
      locationId: selectedLocation.locationId,
      requestedDate: command.requestedDate,
      requiredCapacitySeconds,
      notBefore: inventory.earliestReadyAt,
      correlationId: command.correlationId,
    });
  } catch {
    throw new LocalDeliveryApplicationError("SLOTS_UNAVAILABLE");
  }

  if (!Array.isArray(slots)) {
    throw new LocalDeliveryApplicationError("SLOTS_UNAVAILABLE");
  }
  const slotIds = new Set<string>();
  for (const slot of slots) {
    if (
      !validSlot(
        slot,
        selectedLocation.locationId,
        command.requestedDate,
        calculatedAt,
      ) ||
      slotIds.has(slot.slotId)
    ) {
      throw new LocalDeliveryApplicationError("SLOTS_UNAVAILABLE");
    }
    slotIds.add(slot.slotId);
  }
  const availableSlots = slots.filter(
    (slot) =>
      slot.remainingCapacitySeconds >= requiredCapacitySeconds &&
      (!inventory.earliestReadyAt || Date.parse(slot.startsAt) >= Date.parse(inventory.earliestReadyAt)),
  );
  const availability = availableSlots.length === 0
    ? { bookable: false, reasonCode: "NO_SLOTS_FOR_SELECTED_LOCATION" } as const
    : inventory.status === "TRANSFER_REQUIRED"
      ? { bookable: true, reasonCode: "TRANSFER_REQUIRED" } as const
      : { bookable: true, reasonCode: "ELIGIBLE" } as const;
  const expiresAt = new Date(Date.parse(calculatedAt) + policy.quoteTtlSeconds * 1_000).toISOString();

  return dependencies.quotes.save({
    clientId: command.clientId,
    idempotencyKey: command.idempotencyKey,
    requestHash: hash,
    cartLines: command.cartLines,
    persistencePlan: {
      kind: "OFFER",
      calculatedAt,
      holdTtlSeconds: policy.holdTtlSeconds,
      preparationBufferSeconds: policy.preparationBufferSeconds,
      handoffBufferSeconds: policy.handoffBufferSeconds,
      inventoryLines: inventory.lines.map((line) => ({ ...line })),
    },
    quote: {
      eligible: true,
      ...availability,
      normalizedAddress: geocode.normalizedAddress,
      coordinates: geocode.coordinates,
      postalCode: geocode.postalCode,
      selectedLocationId: selectedLocation.locationId,
      selectedLocationName: selectedLocation.name,
      assignmentRule: assignment.rule,
      walkingDistanceFeet: selectedRoute.walkingDistanceFeet,
      walkingDurationSeconds: selectedRoute.walkingDurationSeconds,
      roundTripDistanceFeet,
      estimatedRoundTripDurationSeconds,
      requiredCapacitySeconds,
      feeCents: fee.feeCents,
      currency: policy.currency,
      feeTierId: fee.tierId,
      candidateRoutes,
      availableSlots,
      inventoryStatus: inventory.status,
      transferEarliestReadyAt: inventory.earliestReadyAt,
      inventoryOwnerLocationIds: [
        ...new Set(inventory.lines.map(({ inventoryOwnerExternalLocationId }) =>
          inventoryOwnerExternalLocationId)),
      ],
      inventoryNodeIds: [
        ...new Set(inventory.lines.map(({ inventoryNodeExternalId }) => inventoryNodeExternalId)),
      ],
      zoneVersionId: policy.zoneVersionId,
      feePolicyVersionId: policy.feePolicyVersionId,
      routingProvider: selectedRoute.routingProvider,
      routingProfile: policy.routingProfile,
      routeCalculatedAt: calculatedAt,
      expiresAt,
      correlationId: command.correlationId,
    },
  });
}
