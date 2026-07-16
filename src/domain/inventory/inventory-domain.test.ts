import { describe, expect, it } from "vitest";
import { generateBoxCode, isValidBoxCode } from "./box-code";
import { assertContainerTransition, canTransitionContainer } from "./container-state";
import { canonicalManifest, manifestContentHash } from "./manifest";

const first = { inventoryLotId: "00000000-0000-4000-8000-000000000001", productId: "00000000-0000-4000-8000-000000000011", quantity: "2" };
const second = { inventoryLotId: "00000000-0000-4000-8000-000000000002", productId: "00000000-0000-4000-8000-000000000012", quantity: "1.500" };

describe("inventory domain", () => {
  it("generates scanner-safe box codes with a checksum", () => {
    const code = generateBoxCode();
    expect(code).toMatch(/^BX-/);
    expect(isValidBoxCode(code)).toBe(true);
    expect(isValidBoxCode(`${code.slice(0, -1)}2`)).toBe(code.endsWith("2"));
  });

  it("allows the safe container lifecycle and blocks skips", () => {
    expect(canTransitionContainer("SEALED", "STAGED")).toBe(true);
    expect(canTransitionContainer("SEALED", "ACTIVE")).toBe(false);
    expect(() => assertContainerTransition("IN_TRANSIT", "ACTIVE")).toThrow(/not allowed/);
  });

  it("canonicalizes manifests before hashing", () => {
    expect(canonicalManifest([second, first])).toEqual([first, second]);
    expect(manifestContentHash([first, second])).toBe(manifestContentHash([second, first]));
  });

  it("rejects zero or negative manifest quantities", () => {
    expect(() => canonicalManifest([{ ...first, quantity: "0" }])).toThrow();
    expect(() => canonicalManifest([{ ...first, quantity: "-1" }])).toThrow();
  });
});
