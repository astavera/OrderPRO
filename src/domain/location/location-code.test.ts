import { describe, expect, it } from "vitest";
import { fulfillmentMethodsFor, operationalLocationCodeSchema } from "./location-code";

describe("operational locations", () => {
  it("keeps warehouse shipping-only", () => expect(fulfillmentMethodsFor("WH01")).toEqual(["SHIPPING"]));
  it("keeps stores pickup and delivery-only", () => expect(fulfillmentMethodsFor("ST72")).toEqual(["PICKUP", "LOCAL_DELIVERY"]));
  it("rejects unknown codes", () => expect(operationalLocationCodeSchema.safeParse("STORE-1").success).toBe(false));
});
