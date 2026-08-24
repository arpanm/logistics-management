import {
  allocationManifest,
  indentManifest,
  operationsManifests,
  tripManifest,
} from "./manifest.js";

export type MinorUnits = bigint;

export function addUtcMinutes(instant: Date, minutes: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 0)
    throw new Error("minutes must be a non-negative safe integer");
  return new Date(instant.getTime() + minutes * 60_000);
}

export function placementColour(committedAt: Date, placedAtOrAsOf: Date) {
  const elapsedMs = Math.max(
    0,
    placedAtOrAsOf.getTime() - committedAt.getTime(),
  );
  if (elapsedMs <= 24 * 3_600_000) return "GREEN" as const;
  if (elapsedMs <= 48 * 3_600_000) return "YELLOW" as const;
  return "RED" as const;
}

export function allocationTotals(
  requested: number,
  cancelled: number,
  allocations: readonly { allotted: number; placed: number; status: string }[],
) {
  const eligible = Math.max(0, requested - cancelled);
  const active = allocations.filter(
    (item) => !["REJECTED", "EXPIRED", "CANCELLED"].includes(item.status),
  );
  const allotted = active.reduce((sum, item) => sum + item.allotted, 0);
  const placed = active.reduce((sum, item) => sum + item.placed, 0);
  return {
    eligible,
    allotted,
    placed,
    pending: Math.max(0, eligible - placed),
    remainingToAllocate: Math.max(0, eligible - allotted),
    fillBasisPoints:
      eligible === 0 ? 10_000 : Math.floor((placed * 10_000) / eligible),
  };
}

export function exactLineAmount(
  quantityMilliUnits: bigint,
  rateMinorPerUnit: bigint,
): MinorUnits {
  return (quantityMilliUnits * rateMinorPerUnit) / 1_000n;
}

export function deduplicateTripEvents<
  T extends { source: string; externalId: string },
>(events: readonly T[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.source}:${event.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const operationsProvider = {
  namespace: "operations",
  manifests: operationsManifests,
  resources: {
    indents: indentManifest,
    allocations: allocationManifest,
    trips: tripManifest,
  },
  links: {
    allocations: { belongsTo: "indents", foreignKey: "indentId" },
    trips: { belongsTo: "allocations", foreignKey: "allocationId" },
  },
  invariants: [
    "tenant context is server-derived",
    "commercial and SLA terms are snapshotted",
    "creates and offline events are idempotent",
    "replacements and event conflicts append history",
    "trip location is collected only while actively assigned",
  ],
} as const;
