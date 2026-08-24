import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown) =>
  JSON.stringify(canonical(value));
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const tenantKeyHash = (tenantId: string, key: string) =>
  sha256(`${tenantId}:${key}`);
