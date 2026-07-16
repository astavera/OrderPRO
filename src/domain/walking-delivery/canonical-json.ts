import { createHash } from "node:crypto";

function canonicalize(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Sparse array at ${path}[${index}]`);
      }
      items.push(canonicalize(value[index], `${path}[${index}]`));
    }
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Unsupported object at ${path}`);
    }

    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`);

    return `{${properties.join(",")}}`;
  }

  throw new TypeError(`Unsupported JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

export function stableSha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
