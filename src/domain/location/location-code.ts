import { z } from "zod";

export const operationalLocationCodeSchema = z.enum(["WH01", "ST72", "ST86"]);
export type OperationalLocationCode = z.infer<typeof operationalLocationCodeSchema>;

export function fulfillmentMethodsFor(code: OperationalLocationCode) {
  return code === "WH01" ? (["SHIPPING"] as const) : (["PICKUP", "LOCAL_DELIVERY"] as const);
}
