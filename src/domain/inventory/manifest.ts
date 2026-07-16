import { createHash } from "node:crypto";
import { z } from "zod";

export const manifestLineSchema = z.object({
  inventoryLotId: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/).refine((value) => Number(value) > 0, "Quantity must be positive"),
});

export type ManifestLine = z.infer<typeof manifestLineSchema>;

export function canonicalManifest(lines: ManifestLine[]) {
  return [...lines]
    .map((line) => manifestLineSchema.parse(line))
    .sort((left, right) => left.inventoryLotId.localeCompare(right.inventoryLotId));
}

export function manifestContentHash(lines: ManifestLine[]) {
  return createHash("sha256").update(JSON.stringify(canonicalManifest(lines))).digest("hex");
}
