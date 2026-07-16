import { createHash } from "node:crypto";
import { z } from "zod";

export const manifestLineSchema = z.object({
  inventoryLotId: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/).refine((value) => Number(value) > 0, "Quantity must be positive"),
});

export type ManifestLine = z.infer<typeof manifestLineSchema>;

function canonicalQuantity(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}

export function canonicalManifest(lines: ManifestLine[]) {
  return [...lines]
    .map((line) => {
      const parsed = manifestLineSchema.parse(line);
      return { ...parsed, quantity: canonicalQuantity(parsed.quantity) };
    })
    .sort((left, right) => left.inventoryLotId.localeCompare(right.inventoryLotId));
}

export function manifestContentHash(lines: ManifestLine[]) {
  return createHash("sha256").update(JSON.stringify(canonicalManifest(lines))).digest("hex");
}
