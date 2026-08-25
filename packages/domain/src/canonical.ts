import { z } from "zod";

const uuid = z.string().uuid();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);
const text = (max = 500) => z.string().trim().min(1).max(max);
const isoDate = z.string().date();
const instant = z.string().datetime({ offset: true });
const exactInteger = z
  .union([
    z.number().int().safe().transform(String),
    z
      .string()
      .trim()
      .regex(/^-?\d+$/),
  ])
  .transform((value) => BigInt(value).toString());
const minor = exactInteger;
const positiveMinor = exactInteger.refine((value) => BigInt(value) >= 0n, {
  message: "Amount must not be negative",
});
const nonZeroMinor = exactInteger.refine((value) => BigInt(value) > 0n, {
  message: "Amount must be positive",
});

export const organizationNodeCommandSchema = z
  .object({
    code,
    name: text(160),
    nodeType: z.enum(["LEGAL_ENTITY", "REGION", "BRANCH", "TEAM", "HUB"]),
    parentId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    timezone: text(80),
    address: z.string().trim().max(1000).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    postalCodes: z.array(text(20)).max(100).default([]),
    geofence: z.record(z.unknown()).default({}),
    activeFrom: isoDate,
    activeTo: isoDate.nullish(),
  })
  .strict()
  .refine((v) => !v.activeTo || v.activeTo >= v.activeFrom, {
    path: ["activeTo"],
    message: "Active end must not precede start",
  });

export const employeeCommandSchema = z
  .object({
    employeeCode: code,
    displayName: text(160),
    email: z.string().email().max(254).nullish(),
    mobile: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullish(),
    managerId: uuid.nullish(),
    homeNodeId: uuid,
    linkedMembershipId: uuid.nullish(),
    activeFrom: isoDate,
    activeTo: isoDate.nullish(),
  })
  .strict();

export const clientCommandSchema = z
  .object({
    code,
    legalName: text(200),
    industry: z.string().trim().max(100).optional(),
    billingEntityId: uuid,
    accountManagerEmployeeId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    taxIdentifier: z.string().trim().toUpperCase().max(32).nullish(),
    escalationEmail: z.string().email().max(254).nullish(),
    escalationMobile: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullish(),
    creditDays: z.number().int().min(0).max(365),
    podMode: z.enum(["PHYSICAL", "DIGITAL", "BOTH"]),
  })
  .strict();

export const clientLocationCommandSchema = z
  .object({
    clientId: uuid,
    code,
    name: text(160),
    locationType: text(60),
    organizationNodeId: uuid,
    managerEmployeeId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    mobile: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullish(),
    geofence: z.record(z.unknown()).default({}),
  })
  .strict();

export const contractCommandSchema = z
  .object({
    clientId: uuid,
    code,
    name: text(160),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullish(),
    creditDays: z.number().int().min(0).max(365),
    podMode: z.enum(["PHYSICAL", "DIGITAL", "BOTH"]),
    documentRequirements: z.array(text(80)).max(30).default([]),
    terms: z.record(z.unknown()).default({}),
  })
  .strict();

export const laneCommandSchema = z
  .object({
    contractVersionId: uuid,
    code,
    originLocationId: uuid,
    destinationLocationId: uuid,
    truckType: text(80),
    cargoType: z.string().trim().max(80).optional(),
    quantityMinMilli: z.number().int().safe().nonnegative().default(0),
    quantityMaxMilli: z.number().int().safe().positive().nullish(),
    priority: z.number().int().min(0).max(1000).default(0),
    placementMinutes: z.number().int().nonnegative(),
    transitMinutes: z.number().int().nonnegative(),
    podMinutes: z.number().int().nonnegative(),
    rateMinor: positiveMinor,
    taxBasisPoints: z.number().int().min(0).max(10000),
    effectiveFrom: instant,
    effectiveTo: instant.nullish(),
  })
  .strict();

export const vendorCommandSchema = z
  .object({
    code,
    legalName: text(200),
    pan: z.string().trim().toUpperCase().max(16).nullish(),
    gstin: z.string().trim().toUpperCase().max(20).nullish(),
    tdsBasisPoints: z.number().int().min(0).max(10000).default(0),
    msmeNumber: z.string().trim().max(40).nullish(),
    paymentTermsDays: z.number().int().min(0).max(365).default(0),
    onboardingEmployeeId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
  })
  .strict();

export const vehicleCommandSchema = z
  .object({
    vendorId: uuid,
    registrationNumber: text(30).transform((v) => v.toUpperCase()),
    vehicleType: text(80),
    make: z.string().trim().max(80).optional(),
    model: z.string().trim().max(80).optional(),
    modelYear: z.number().int().min(1950).max(2200).optional(),
    capacityMilli: z.number().int().safe().positive(),
    gpsDeviceId: z.string().trim().max(120).nullish(),
  })
  .strict();

export const driverCommandSchema = z
  .object({
    vendorId: uuid,
    code,
    displayName: text(160),
    mobile: z.string().regex(/^\+[1-9]\d{7,14}$/),
    licenceNumber: text(40).transform((v) => v.toUpperCase()),
    licenceClass: text(40),
    licenceValidTo: isoDate,
    emergencyContact: z.string().trim().max(160).nullish(),
    portalMembershipId: uuid.nullish(),
  })
  .strict();

export const indentCommandSchema = z
  .object({
    indentNo: code,
    clientId: uuid,
    clientLocationId: uuid,
    laneId: uuid,
    requestedVehicles: z.number().int().positive(),
    quantityMilli: z.number().int().safe().positive(),
    pickupWindowStart: instant,
    pickupWindowEnd: instant,
    committedPlacementAt: instant.optional(),
    commitmentOverrideReason: z.string().trim().min(10).max(500).optional(),
    ownerMembershipId: uuid.nullish(),
    source: z.enum(["MANUAL", "COPY", "IMPORT", "API"]),
    sourceReference: z.string().trim().max(120).nullish(),
    cargoType: z.string().trim().max(80).optional(),
    bodyType: z.string().trim().max(80).optional(),
  })
  .strict()
  .refine((v) => v.pickupWindowEnd > v.pickupWindowStart, {
    path: ["pickupWindowEnd"],
    message: "Pickup window end must be after start",
  })
  .refine((v) => !v.committedPlacementAt || !!v.commitmentOverrideReason, {
    path: ["commitmentOverrideReason"],
    message: "A reason is required to override the SLA commitment",
  });

export const allocationCommandSchema = z
  .object({
    indentId: uuid,
    vendorId: uuid,
    allottedVehicles: z.number().int().positive(),
    offeredRateMinor: positiveMinor,
    offerChannel: z.enum([
      "PORTAL",
      "PHONE_VERIFIED",
      "EMAIL",
      "WHATSAPP_VERIFIED",
    ]),
    offeredAt: instant,
    expiresAt: instant,
    ownerMembershipId: uuid.nullish(),
  })
  .strict()
  .refine((v) => v.expiresAt > v.offeredAt, {
    path: ["expiresAt"],
    message: "Offer expiry must be after offer time",
  });

export const tripEventCommandSchema = z
  .object({
    eventKey: text(120),
    eventType: z.enum([
      "AT_ORIGIN",
      "LOADED",
      "DEPARTED",
      "CHECKPOINT",
      "AT_DESTINATION",
      "DELIVERED",
      "EXCEPTION",
      "SOS",
      "GPS",
    ]),
    source: z.enum(["WEB", "MOBILE", "OFFLINE", "GPS", "API"]),
    deviceAt: instant,
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    speedKph: z.number().min(0).max(300).optional(),
    odometerKm: z.number().min(0).optional(),
    evidence: z.record(z.unknown()).default({}),
  })
  .strict();

export const invoiceLineSchema = z
  .object({
    tripId: uuid,
    podTaskId: uuid.nullish(),
    chargeCode: code,
    quantityMilli: z.number().int().safe().positive(),
    rateMinor: minor,
    taxBasisPoints: z.number().int().min(0).max(10000),
  })
  .strict();
export const invoiceCommandSchema = z
  .object({
    invoiceNo: code,
    clientId: uuid,
    clientLocationId: uuid,
    invoiceDate: isoDate,
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditDays: z.number().int().min(0).max(365),
    lines: z.array(invoiceLineSchema).min(1).max(500),
  })
  .strict();

export const receiptCommandSchema = z
  .object({
    receiptRef: code,
    clientId: uuid,
    paymentDate: isoDate,
    amountMinor: nonZeroMinor,
    mode: z.enum(["BANK_TRANSFER", "CHEQUE", "CASH", "CARD", "OTHER"]),
    instrumentNo: text(120),
    bankReference: z.string().trim().max(120).nullish(),
  })
  .strict();
export const receiptAllocationSchema = z
  .object({
    invoiceId: uuid.nullish(),
    entryType: z.enum(["ALLOCATION", "DEDUCTION", "ON_ACCOUNT"]),
    amountMinor: nonZeroMinor,
    reason: z.string().trim().max(500).nullish(),
  })
  .strict();

export const configurationCommandSchema = z
  .object({
    namespace: z.enum([
      "branding",
      "locale",
      "operations",
      "documents",
      "finance",
      "alerts",
      "numbering",
      "integrations",
    ]),
    value: z.record(z.unknown()),
    effectiveFrom: instant,
    effectiveTo: instant.nullish(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.namespace !== "alerts") return;
    const yellowAt = configuration.value.yellowAt;
    const redAt = configuration.value.redAt;
    if (yellowAt === undefined && redAt === undefined) return;
    if (
      typeof yellowAt !== "number" ||
      !Number.isFinite(yellowAt) ||
      yellowAt < 0 ||
      typeof redAt !== "number" ||
      !Number.isFinite(redAt) ||
      redAt < 0 ||
      yellowAt >= redAt
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value", "redAt"],
        message:
          "Alert thresholds must be non-negative and redAt must be greater than yellowAt",
      });
  });

export const documentUploadSchema = z
  .object({
    documentId: uuid.optional(),
    targetType: text(80),
    targetId: uuid,
    category: text(80),
    confidentiality: z.enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"]),
    fileName: text(255),
    mediaType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    contentBase64: text(14_000_000),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    issueDate: isoDate.nullish(),
    expiryDate: isoDate.nullish(),
  })
  .strict();

export const transitionCommandSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    toState: text(40),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export function calculateMoneyLine(
  quantityMilli: number | string | bigint,
  rateMinor: number | string | bigint,
  taxBasisPoints: number,
) {
  const roundRatio = (numerator: bigint, denominator: bigint) =>
    numerator < 0n
      ? -((-numerator + denominator / 2n) / denominator)
      : (numerator + denominator / 2n) / denominator;
  const taxableMinor = roundRatio(
    BigInt(quantityMilli) * BigInt(rateMinor),
    1000n,
  );
  const taxMinor = roundRatio(taxableMinor * BigInt(taxBasisPoints), 10000n);
  return {
    taxableMinor: taxableMinor.toString(),
    taxMinor: taxMinor.toString(),
    totalMinor: (taxableMinor + taxMinor).toString(),
  };
}

export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)]),
    );
  return value;
}

export function ageColour(days: number, yellowAt: number, redAt: number) {
  if (days >= redAt) return "RED" as const;
  if (days >= yellowAt) return "YELLOW" as const;
  return "GREEN" as const;
}
