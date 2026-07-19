import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
  LOCAL_DELIVERY_ZONE_VERSION_ID,
  type LocalDeliveryQuoteSaveInput,
} from "../../application/local-delivery-v4/contracts";

vi.mock("server-only", () => ({}));

import { PrismaLocalDeliveryQuoteStore } from "./prisma-local-delivery-quote-store";

const calculatedAt = "2026-07-16T16:00:00.000Z";
const expiresAt = "2026-07-16T16:15:00.000Z";
const effectiveFrom = new Date("2026-07-01T00:00:00.000Z");
const transactionNow = new Date("2026-07-16T16:05:00.000Z");

type ContactStoreSaveInput = Extract<
  LocalDeliveryQuoteSaveInput,
  { readonly persistencePlan: { readonly kind: "CONTACT_STORE" } }
>;
type OfferSaveInput = Extract<
  LocalDeliveryQuoteSaveInput,
  { readonly persistencePlan: { readonly kind: "OFFER" } }
>;

function contactStoreInput(): ContactStoreSaveInput {
  return {
    clientId: "storefront-staging",
    idempotencyKey: "contact-store-001",
    requestHash: "contact-store-request-hash",
    cartLines: [{ variantId: "variant-contact", quantity: 2 }],
    persistencePlan: { kind: "CONTACT_STORE", calculatedAt },
    quote: {
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      normalizedAddress: {
        line1: "350 Madison Ave",
        line2: null,
        city: "New York",
        state: "NY",
        postalCode: "10017",
        country: "US",
        borough: "Manhattan",
      },
      coordinates: { latitude: 40.7537, longitude: -73.9787 },
      postalCode: "10017",
      correlationId: "correlation-contact-store",
      expiresAt,
    },
  };
}

function storedContactStoreQuote() {
  return {
    id: "quote-contact-store",
    requestHash: "contact-store-request-hash",
    reasonCode: "CONTACT_STORE",
    normalizedAddressStructured: {
      line1: "350 Madison Ave",
      line2: null,
      city: "New York",
      state: "NY",
      postalCode: "10017",
      country: "US",
      borough: "Manhattan",
    },
    customerCoordinates: [-73.9787, 40.7537],
    postalCode: "10017",
    calculatedAt: new Date(calculatedAt),
    expiresAt: new Date(expiresAt),
    correlationId: "correlation-contact-store",
  };
}

function offerInput(): OfferSaveInput {
  return {
    clientId: "storefront-staging",
    idempotencyKey: "offer-001",
    requestHash: "offer-request-hash",
    cartLines: [{ variantId: "variant-1", quantity: 1 }],
    persistencePlan: {
      kind: "OFFER",
      calculatedAt,
      holdTtlSeconds: 300,
      preparationBufferSeconds: 180,
      handoffBufferSeconds: 120,
      inventoryLines: [{
        lineNumber: 1,
        variantId: "variant-1",
        productId: "product-1",
        quantity: 1,
        readinessStatus: "READY",
        inventoryOwnerLocationId: "op-third",
        inventoryOwnerExternalLocationId: "third_avenue",
        inventoryNodeId: "op-third",
        inventoryNodeExternalId: "third_avenue",
        containerId: "container-1",
        storageLocationId: null,
        transferStatus: "NOT_REQUIRED",
        earliestReadyAt: null,
      }],
    },
    quote: {
      eligible: true,
      bookable: true,
      reasonCode: "ELIGIBLE",
      normalizedAddress: {
        line1: "310 E 75th St",
        line2: null,
        city: "New York",
        state: "NY",
        postalCode: "10021",
        country: "US",
        borough: "Manhattan",
      },
      coordinates: { latitude: 40.7702, longitude: -73.957 },
      postalCode: "10021",
      selectedLocationId: "third_avenue",
      selectedLocationName: "Third Avenue",
      assignmentRule: "FIXED_POSTAL_ZONE",
      walkingDistanceFeet: 1_760,
      walkingDurationSeconds: 420,
      roundTripDistanceFeet: 3_520,
      estimatedRoundTripDurationSeconds: 840,
      requiredCapacitySeconds: 1_140,
      feeCents: 1_000,
      currency: "USD",
      feeTierId: "base-10",
      candidateRoutes: [{
        locationId: "third_avenue",
        locationPriority: 1,
        walkingDistanceFeet: 1_760,
        walkingDurationSeconds: 420,
        routingProvider: "test-router",
      }],
      availableSlots: [{
        slotId: "slot-1",
        locationId: "third_avenue",
        startsAt: "2026-07-20T14:00:00-04:00",
        endsAt: "2026-07-20T15:00:00-04:00",
        remainingCapacitySeconds: 2_000,
      }],
      inventoryStatus: "READY",
      transferEarliestReadyAt: null,
      inventoryOwnerLocationIds: ["third_avenue"],
      inventoryNodeIds: ["third_avenue"],
      zoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
      feePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
      routingProvider: "test-router",
      routingProfile: "walking",
      routeCalculatedAt: calculatedAt,
      expiresAt,
      correlationId: "correlation-offer",
    },
  };
}

function storedOfferQuote() {
  return {
    id: "quote-offer",
    requestHash: "offer-request-hash",
    reasonCode: "ELIGIBLE",
    normalizedAddressStructured: {
      line1: "310 E 75th St",
      line2: null,
      city: "New York",
      state: "NY",
      postalCode: "10021",
      country: "US",
      borough: "Manhattan",
    },
    customerCoordinates: [-73.957, 40.7702],
    postalCode: "10021",
    calculatedAt: new Date(calculatedAt),
    expiresAt: new Date(expiresAt),
    correlationId: "correlation-offer",
    selectedLocalDeliveryLocation: {
      displayName: "Third Avenue",
      externalLocationId: "third_avenue",
    },
    externalSelectedLocationId: "third_avenue",
    assignmentRule: "FIXED_POSTAL_ZONE",
    routingProvider: "test-router",
    routingProfile: "walking",
    distanceFeet: new Prisma.Decimal(1_760),
    durationSeconds: 420,
    roundTripDistanceFeet: new Prisma.Decimal(3_520),
    estimatedRoundTripDurationSeconds: 840,
    capacityRequiredSeconds: 1_140,
    feeCents: 1_000,
    currency: "USD",
    bookable: true,
    tier: { tierKey: "base-10" },
    externalZoneVersionId: LOCAL_DELIVERY_ZONE_VERSION_ID,
    externalFeePolicyVersionId: LOCAL_DELIVERY_FEE_POLICY_VERSION_ID,
    routeCalculatedAt: new Date(calculatedAt),
    inventoryReadinessStatus: "READY",
    inventoryReadyAt: null,
    candidateRoutes: [{
      externalLocationId: "third_avenue",
      locationPriority: 1,
      walkingDistanceFeet: new Prisma.Decimal(1_760),
      walkingDurationSeconds: 420,
      routingProvider: "test-router",
      routingProfile: "walking",
    }],
    slotSnapshot: {
      policy: { slotPolicyId: "slot-policy" },
      slots: [{
        slotId: "slot-1",
        locationId: "third_avenue",
        startsAt: "2026-07-20T14:00:00-04:00",
        endsAt: "2026-07-20T15:00:00-04:00",
        remainingCapacitySeconds: 2_000,
      }],
    },
    inventoryLines: [{
      lineNumber: 1,
      variantId: "variant-1",
      productId: "product-1",
      quantity: 1,
      readinessStatus: "READY",
      inventoryOwnerLocationId: "op-third",
      inventoryOwnerExternalLocationId: "third_avenue",
      inventoryNodeId: "op-third",
      inventoryNodeExternalId: "third_avenue",
      containerId: "container-1",
      storageLocationId: null,
      transferStatus: "NOT_REQUIRED",
      earliestReadyAt: null,
    }],
  };
}

describe("PrismaLocalDeliveryQuoteStore", () => {
  it("persists CONTACT_STORE inside a serializable transaction, forces deferred constraints and maps the stored row", async () => {
    const create = vi.fn(async () => ({ id: "quote-contact-store" }));
    const findUniqueInTransaction = vi.fn(async () => storedContactStoreQuote());
    const executeRaw = vi.fn(async (query: unknown) => {
      void query;
      return 0;
    });
    const tx = {
      walkingDeliveryQuote: { create, findUnique: findUniqueInTransaction },
      $queryRaw: vi.fn(async () => [{ transactionNow }]),
      $executeRaw: executeRaw,
    };
    const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx));
    const db = {
      $transaction: transaction,
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaLocalDeliveryQuoteStore(db).save(contactStoreInput());

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schemaVersion: "orderpro.walking-delivery-quote.v2",
        clientId: "storefront-staging",
        idempotencyKey: "contact-store-001",
        normalizedAddress: "350 Madison Ave, New York, NY 10017",
        normalizedAddressStructured: expect.objectContaining({ postalCode: "10017" }),
        customerCoordinates: [-73.9787, 40.7537],
        postalCode: "10017",
        bookable: false,
        reasonCode: "CONTACT_STORE",
        inventoryReadinessStatus: "NOT_EVALUATED",
      }),
      select: { id: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0]?.[0]).toMatchObject({
      strings: ["SET CONSTRAINTS ALL IMMEDIATE"],
      values: [],
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueInTransaction.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      quoteId: "quote-contact-store",
      replayed: false,
      eligible: false,
      bookable: false,
      reasonCode: "CONTACT_STORE",
      storefrontMessage: "Contact store",
      normalizedAddress: {
        line1: "350 Madison Ave",
        line2: null,
        city: "New York",
        state: "NY",
        postalCode: "10017",
        country: "US",
        borough: "Manhattan",
      },
      coordinates: { latitude: 40.7537, longitude: -73.9787 },
      postalCode: "10017",
      correlationId: "correlation-contact-store",
      expiresAt,
    });
  });

  it("creates candidate-route and inventory evidence before validating and reloading an offer", async () => {
    const identity = {
      id: "local-third",
      externalLocationId: "third_avenue",
      operationalLocationId: "op-third",
      active: true,
      operationalLocation: { active: true },
    };
    const feePolicy = {
      status: "PUBLISHED",
      calculationPolicyVersionId: "fee-version",
      effectiveFrom,
      effectiveTo: null,
    };
    const slotPolicy = {
      id: "slot-policy",
      status: "PUBLISHED",
      effectiveFrom,
      effectiveTo: null,
    };
    const createQuote = vi.fn(async () => ({ id: "quote-offer" }));
    const createCandidates = vi.fn(async () => ({ count: 1 }));
    const createInventory = vi.fn(async () => ({ count: 1 }));
    const executeRaw = vi.fn(async () => 0);
    const tx = {
      $queryRaw: vi.fn(async () => [{ transactionNow }]),
      localDeliveryLocationIdentity: { findUnique: vi.fn(async () => identity) },
      walkingZoneSetVersion: {
        findUnique: vi.fn(async () => ({
          id: "zone-set",
          status: "PUBLISHED",
          environment: "STAGING",
          effectiveFrom,
          effectiveTo: null,
        })),
      },
      walkingZoneVersion: {
        findMany: vi.fn(async () => [{
          id: "zone-version",
          status: "PUBLISHED",
          effectiveFrom,
          effectiveTo: null,
          geometry: { type: "Polygon", coordinates: [] },
          candidates: [{ locationId: "op-third", feePolicy, slotPolicy }],
        }]),
      },
      feeCalculationPolicyVersion: {
        findUnique: vi.fn(async () => ({
          id: "fee-version",
          status: "PUBLISHED",
          environment: "STAGING",
          effectiveFrom,
          effectiveTo: null,
          holdTtlSeconds: 300,
          preparationBufferSeconds: 180,
          handoffBufferSeconds: 120,
        })),
      },
      feeCalculationPolicyPublication: {
        findFirst: vi.fn(async () => ({ id: "fee-publication" })),
      },
      walkingPublication: {
        findFirst: vi.fn(async () => ({ id: "walking-publication" })),
      },
      feeCalculationTier: {
        findFirst: vi.fn(async () => ({ id: "tier", tierKey: "base-10" })),
      },
      inventoryNodeBalance: {
        findFirst: vi.fn(async () => ({ id: "inventory-balance" })),
      },
      walkingDeliveryQuote: {
        create: createQuote,
        findUnique: vi.fn(async () => storedOfferQuote()),
      },
      walkingDeliveryQuoteCandidateRoute: { createMany: createCandidates },
      walkingDeliveryQuoteInventoryLine: { createMany: createInventory },
      $executeRaw: executeRaw,
    };
    const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx));
    const db = {
      $transaction: transaction,
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaLocalDeliveryQuoteStore(db).save(offerInput());

    expect(createCandidates).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        quoteId: "quote-offer",
        externalLocationId: "third_avenue",
        sequence: 1,
        walkingDistanceFeet: 1_760,
        selected: true,
      })],
    });
    expect(createInventory).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        quoteId: "quote-offer",
        lineNumber: 1,
        productId: "product-1",
        inventoryOwnerLocationId: "op-third",
        inventoryOwnerExternalLocationId: "third_avenue",
        inventoryNodeId: "op-third",
        inventoryNodeExternalId: "third_avenue",
        containerId: "container-1",
      })],
    });
    expect(createCandidates.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(createInventory.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({
      quoteId: "quote-offer",
      replayed: false,
      eligible: true,
      bookable: true,
      reasonCode: "ELIGIBLE",
      selectedLocationId: "third_avenue",
      walkingDistanceFeet: 1_760,
      roundTripDistanceFeet: 3_520,
      feeCents: 1_000,
      feeTierId: "base-10",
      availableSlots: [{ slotId: "slot-1", locationId: "third_avenue" }],
      inventoryOwnerLocationIds: ["third_avenue"],
      inventoryNodeIds: ["third_avenue"],
    });
  });

  it("rejects offer inventory evidence that does not exactly match consecutive cart lines", async () => {
    const base = offerInput();
    const firstLine = base.persistencePlan.inventoryLines[0]!;
    const secondLine = {
      ...firstLine,
      lineNumber: 2,
      variantId: "variant-2",
      productId: "product-2",
    };
    const invalidInputs: OfferSaveInput[] = [
      {
        ...base,
        persistencePlan: {
          ...base.persistencePlan,
          inventoryLines: [{ ...firstLine, variantId: "wrong-variant" }],
        },
      },
      {
        ...base,
        persistencePlan: {
          ...base.persistencePlan,
          inventoryLines: [{ ...firstLine, quantity: 2 }],
        },
      },
      {
        ...base,
        cartLines: [
          ...base.cartLines,
          { variantId: "variant-2", quantity: 1 },
        ],
        persistencePlan: {
          ...base.persistencePlan,
          inventoryLines: [firstLine, { ...secondLine, lineNumber: 3 }],
        },
      },
    ];
    const transaction = vi.fn();
    const db = {
      $transaction: transaction,
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;
    const store = new PrismaLocalDeliveryQuoteStore(db);

    for (const input of invalidInputs) {
      await expect(store.save(input)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts a CONTACT_STORE cart only as idempotency input and creates no inventory evidence", async () => {
    const create = vi.fn(async () => ({ id: "quote-contact-store" }));
    const createInventory = vi.fn();
    const tx = {
      walkingDeliveryQuote: {
        create,
        findUnique: vi.fn(async () => storedContactStoreQuote()),
      },
      walkingDeliveryQuoteInventoryLine: { createMany: createInventory },
      $queryRaw: vi.fn(async () => [{ transactionNow }]),
      $executeRaw: vi.fn(async () => 0),
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    const result = await new PrismaLocalDeliveryQuoteStore(db).save(contactStoreInput());

    expect(contactStoreInput().cartLines).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(createInventory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reasonCode: "CONTACT_STORE", bookable: false });
  });

  it("rejects an expired quote using the clock read inside the transaction", async () => {
    const create = vi.fn();
    const tx = {
      walkingDeliveryQuote: { create },
      $queryRaw: vi.fn(async () => [{ transactionNow: new Date(expiresAt) }]),
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)),
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      new PrismaLocalDeliveryQuoteStore(db).save(contactStoreInput()),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing timezone", "2026-07-16T16:15:00"],
    ["space instead of T", "2026-07-16 16:15:00Z"],
    ["impossible calendar date", "2026-02-30T16:15:00Z"],
  ])("rejects a non-RFC3339 quote expiry: %s", async (_label, invalidExpiry) => {
    const base = contactStoreInput();
    const input: ContactStoreSaveInput = {
      ...base,
      quote: { ...base.quote, expiresAt: invalidExpiry },
    };
    const transaction = vi.fn();
    const db = {
      $transaction: transaction,
      walkingDeliveryQuote: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await expect(new PrismaLocalDeliveryQuoteStore(db).save(input)).rejects.toThrow(
      "INVALID_QUOTE_EXPIRY",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rethrows P2002 when no quote exists for the requested idempotency tuple", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique conflict", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["unrelated_unique_constraint"] },
    });
    const findUnique = vi.fn(async () => null);
    const db = {
      $transaction: vi.fn(async () => {
        throw p2002;
      }),
      walkingDeliveryQuote: { findUnique },
    } as unknown as PrismaClient;

    await expect(
      new PrismaLocalDeliveryQuoteStore(db).save(contactStoreInput()),
    ).rejects.toBe(p2002);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        clientId_idempotencyKey: {
          clientId: "storefront-staging",
          idempotencyKey: "contact-store-001",
        },
      },
    }));
  });

  it("replays P2002 only when the matching idempotency tuple actually exists", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique conflict", {
      code: "P2002",
      clientVersion: "test",
    });
    const findUnique = vi.fn(async () => storedContactStoreQuote());
    const db = {
      $transaction: vi.fn(async () => {
        throw p2002;
      }),
      walkingDeliveryQuote: { findUnique },
    } as unknown as PrismaClient;

    const result = await new PrismaLocalDeliveryQuoteStore(db).save(contactStoreInput());

    expect(result).toMatchObject({ quoteId: "quote-contact-store", replayed: true });
  });
});
