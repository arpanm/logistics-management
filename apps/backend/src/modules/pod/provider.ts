import { podManifest } from "./manifest.js";

const DAY_MS = 86_400_000;

export function podAgeingDays(
  deliveredAt: Date,
  receivedAt: Date | null,
  asOf: Date,
) {
  const stop = receivedAt && receivedAt < asOf ? receivedAt : asOf;
  return Math.max(
    0,
    Math.floor((stop.getTime() - deliveredAt.getTime()) / DAY_MS),
  );
}

export function podColour(ageingDays: number) {
  if (!Number.isSafeInteger(ageingDays) || ageingDays < 0)
    throw new Error("ageing days must be a non-negative integer");
  if (ageingDays <= 7) return "GREEN" as const;
  if (ageingDays <= 15) return "YELLOW" as const;
  return "RED" as const;
}

export function deduplicatedValueAtRisk(
  links: readonly { invoiceId: string; postedTotalMinor: bigint }[],
) {
  const invoices = new Map<string, bigint>();
  for (const link of links) invoices.set(link.invoiceId, link.postedTotalMinor);
  return [...invoices.values()].reduce((sum, value) => sum + value, 0n);
}

export const podProvider = {
  namespace: "pod",
  manifests: [podManifest],
  consumes: ["trip.delivery_completed"],
  documentStorage: "postgres-provider-abstraction",
  fileGuards: [
    "declared-type",
    "detected-type",
    "size",
    "malware-status",
    "tenant-permission",
    "expiring-access",
  ],
  invariants: [
    "one LR may link to many invoices without duplicate value-at-risk",
    "receipt date stops ageing",
    "OCR output is never authoritative until confirmed",
    "submission requires acknowledgement and contract snapshot requirements",
  ],
} as const;
