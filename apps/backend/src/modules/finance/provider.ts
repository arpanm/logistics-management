import { financeManifests } from "./manifest.js";

export type TaxLine = { taxableMinor: bigint; taxBasisPoints: bigint };

export function roundBasisPointMinor(valueMinor: bigint, basisPoints: bigint) {
  const numerator = valueMinor * basisPoints;
  return numerator < 0n
    ? -((-numerator + 5_000n) / 10_000n)
    : (numerator + 5_000n) / 10_000n;
}

export function calculateInvoice(lines: readonly TaxLine[]) {
  let taxableMinor = 0n;
  let taxMinor = 0n;
  for (const line of lines) {
    taxableMinor += line.taxableMinor;
    taxMinor += roundBasisPointMinor(line.taxableMinor, line.taxBasisPoints);
  }
  return { taxableMinor, taxMinor, totalMinor: taxableMinor + taxMinor };
}

export function calculateDueDate(acknowledgedAt: Date, creditDays: number) {
  if (!Number.isSafeInteger(creditDays) || creditDays < 0)
    throw new Error("creditDays must be a non-negative integer");
  return new Date(acknowledgedAt.getTime() + creditDays * 86_400_000);
}

export type ReceiptLedgerEntry = {
  kind: "ALLOCATION" | "DEDUCTION" | "ON_ACCOUNT" | "REVERSAL";
  amountMinor: bigint;
  reversesEntryId?: string;
};

export function receiptPosition(
  receiptMinor: bigint,
  entries: readonly ReceiptLedgerEntry[],
) {
  const appliedMinor = entries.reduce(
    (sum, entry) =>
      sum +
      (entry.kind === "REVERSAL" ? -entry.amountMinor : entry.amountMinor),
    0n,
  );
  return {
    receivedMinor: receiptMinor,
    appliedMinor,
    unallocatedMinor: receiptMinor - appliedMinor,
  };
}

export function invoiceBalance(
  postedTotalMinor: bigint,
  allocations: readonly { amountMinor: bigint; reversed: boolean }[],
) {
  return (
    postedTotalMinor -
    allocations.reduce(
      (sum, item) => sum + (item.reversed ? 0n : item.amountMinor),
      0n,
    )
  );
}

export function collectionColour(openBalanceMinor: bigint, ageingDays: number) {
  if (openBalanceMinor <= 0n) return "CLOSED" as const;
  if (ageingDays <= 30) return "GREEN" as const;
  if (ageingDays <= 45) return "YELLOW" as const;
  return "RED" as const;
}

export function vendorPayable(input: {
  taxableMinor: bigint;
  gstMinor: bigint;
  tdsMinor: bigint;
  deductionsMinor: bigint;
  advancesMinor: bigint;
  paymentsMinor: bigint;
}) {
  const approvedMinor =
    input.taxableMinor +
    input.gstMinor -
    input.tdsMinor -
    input.deductionsMinor -
    input.advancesMinor;
  return {
    approvedMinor,
    outstandingMinor: approvedMinor - input.paymentsMinor,
  };
}

export function contributionMargin(
  clientRevenueMinor: bigint,
  vendorCostMinor: bigint,
  approvedTripChargesMinor: bigint,
) {
  return clientRevenueMinor - vendorCostMinor - approvedTripChargesMinor;
}

export const financeProvider = {
  namespace: "finance",
  manifests: financeManifests,
  links: {
    invoices: ["trips", "proofs", "client-rate-snapshots"],
    receipts: ["invoices", "bank-accounts"],
    vendorBills: ["trips", "vendor-rate-snapshots", "verified-bank-accounts"],
  },
  invariants: [
    "all monetary values are integer minor units",
    "posted documents and ledgers are append-only",
    "reversals are compensating entries",
    "service lines cannot be billed twice",
    "maker and checker differ when segregation is enabled",
    "payment requires a currently verified approved bank snapshot",
  ],
} as const;
