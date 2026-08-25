import { z } from "zod";
import { e164MobileSchema } from "./phone.js";

const uuid = z.string().uuid();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);
const text = (max = 500) => z.string().trim().min(1).max(max);
const isoDate = z.string().date();
const instant = z.string().datetime({ offset: true });
const optionalText = (max = 500) => z.string().trim().max(max).nullish();
const pin = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit PIN code");
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
    mobile: e164MobileSchema.nullish(),
    managerId: uuid.nullish(),
    homeNodeId: uuid,
    linkedMembershipId: uuid.nullish(),
    activeFrom: isoDate,
    activeTo: isoDate.nullish(),
  })
  .strict();

const geofenceBaseSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("POLYGON"),
      points: z
        .array(
          z
            .object({
              lat: z.number().min(-90).max(90),
              lng: z.number().min(-180).max(180),
            })
            .strict(),
        )
        .min(3)
        .max(100),
    })
    .strict(),
  z
    .object({
      mode: z.literal("POINT_RADIUS"),
      point: z
        .object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
        })
        .strict(),
      radiusKm: z.number().positive().max(1000),
    })
    .strict(),
  z
    .object({
      mode: z.literal("DYNAMIC_RADIUS"),
      radiusKm: z.number().positive().max(1000),
      contextualAnchor: z.literal("ORGANIZATION_ADDRESS"),
    })
    .strict(),
]);
type Point = { lat: number; lng: number };
const cross = (a: Point, b: Point, c: Point) =>
  (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
const orientation = (a: Point, b: Point, c: Point) => Math.sign(cross(a, b, c));
const onSegment = (a: Point, b: Point, point: Point) =>
  Math.abs(cross(a, b, point)) < 1e-12 &&
  point.lat >= Math.min(a.lat, b.lat) &&
  point.lat <= Math.max(a.lat, b.lat) &&
  point.lng >= Math.min(a.lng, b.lng) &&
  point.lng <= Math.max(a.lng, b.lng);
const intersects = (a: Point, b: Point, c: Point, d: Point) => {
  const abC = orientation(a, b, c),
    abD = orientation(a, b, d),
    cdA = orientation(c, d, a),
    cdB = orientation(c, d, b);
  return (
    (abC !== abD && cdA !== cdB) ||
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b))
  );
};
export const geofenceSchema = geofenceBaseSchema.superRefine(
  (value, context) => {
    if (value.mode !== "POLYGON") return;
    const keys = value.points.map((point) => `${point.lat}:${point.lng}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message:
          "Polygon vertices must be distinct and must not repeat the closing vertex",
      });
    const twiceArea = value.points.reduce((area, point, index) => {
      const next = value.points[(index + 1) % value.points.length]!;
      return area + point.lng * next.lat - next.lng * point.lat;
    }, 0);
    if (Math.abs(twiceArea) < 1e-12)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message: "Polygon must enclose a non-zero area",
      });
    for (let i = 0; i < value.points.length; i++) {
      const previous =
          value.points[(i + value.points.length - 1) % value.points.length]!,
        current = value.points[i]!,
        next = value.points[(i + 1) % value.points.length]!;
      if (
        orientation(previous, current, next) === 0 &&
        onSegment(previous, current, next)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", i],
          message: "Adjacent polygon edges must not overlap",
        });
    }
    for (let i = 0; i < value.points.length; i++)
      for (let j = i + 1; j < value.points.length; j++) {
        const adjacent =
          j === i + 1 || (i === 0 && j === value.points.length - 1);
        if (
          !adjacent &&
          intersects(
            value.points[i]!,
            value.points[(i + 1) % value.points.length]!,
            value.points[j]!,
            value.points[(j + 1) % value.points.length]!,
          )
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["points"],
            message: "Polygon edges must not intersect",
          });
      }
  },
);

export const organizationAddressSchema = z
  .object({
    line1: text(160),
    line2: optionalText(160),
    country: z.literal("IN").default("IN"),
    postalCode: pin,
    postalLocalityId: uuid,
  })
  .strict();

const hierarchy: Record<string, readonly string[]> = {
  LEGAL_ENTITY: [],
  REGION: ["LEGAL_ENTITY"],
  BRANCH: ["REGION"],
  TEAM: ["BRANCH", "HUB"],
  HUB: ["REGION", "BRANCH"],
};
export function organizationParentAllowed(
  nodeType: string,
  parentType: string | null,
) {
  return hierarchy[nodeType]?.includes(parentType ?? "") ?? false;
}

const organizationMasterBaseSchema = z
  .object({
    code,
    name: text(160),
    nodeType: z.enum(["LEGAL_ENTITY", "REGION", "BRANCH", "TEAM", "HUB"]),
    parentId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    timezone: text(80).default("Asia/Kolkata"),
    activeFrom: isoDate,
    activeTo: isoDate.nullish(),
    address: organizationAddressSchema.nullish(),
    geofence: geofenceSchema.nullish(),
  })
  .strict();
export const organizationMasterCreateSchema =
  organizationMasterBaseSchema.superRefine((value, context) => {
    if (value.nodeType === "LEGAL_ENTITY" && value.parentId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentId"],
        message: "A legal entity must be a root node",
      });
    if (value.nodeType !== "LEGAL_ENTITY" && !value.parentId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentId"],
        message: "Select a valid parent node",
      });
    if (["BRANCH", "HUB"].includes(value.nodeType) && !value.address)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: "A PIN-derived physical address is required",
      });
    if (value.geofence?.mode === "DYNAMIC_RADIUS" && !value.address)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["geofence"],
        message: "Dynamic radius requires a PIN-derived organization address",
      });
    if (value.activeTo && value.activeTo < value.activeFrom)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeTo"],
        message: "Active end must not precede start",
      });
  });

export const organizationMasterPatchSchema = organizationMasterBaseSchema
  .partial()
  .extend({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();

const employeeMasterBaseSchema = z
  .object({
    employeeCode: code,
    displayName: text(160),
    designation: text(120),
    email: z.string().trim().toLowerCase().email().max(254).nullish(),
    mobile: e164MobileSchema.nullish(),
    managerId: uuid.nullish(),
    homeNodeId: uuid,
    regionIds: z.array(uuid).max(100).default([]),
    linkedMembershipId: uuid.nullish(),
    activeFrom: isoDate,
    activeTo: isoDate.nullish(),
  })
  .strict();
export const employeeMasterCreateSchema = employeeMasterBaseSchema.refine(
  (value) => !value.activeTo || value.activeTo >= value.activeFrom,
  {
    path: ["activeTo"],
    message: "Active end must not precede start",
  },
);

export const employeeMasterPatchSchema = employeeMasterBaseSchema
  .partial()
  .extend({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(5).max(1000),
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
    escalationMobile: e164MobileSchema.nullish(),
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
    mobile: e164MobileSchema.nullish(),
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
    truckTypeId: uuid.optional(),
    truckType: text(80).optional(),
    cargoTypeId: uuid.optional(),
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
  .strict()
  .refine((value) => value.truckTypeId || value.truckType, {
    path: ["truckTypeId"],
    message: "Select a configured truck type",
  });

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
    truckTypeId: uuid.optional(),
    bodyTypeId: uuid.optional(),
    vehicleType: text(80).optional(),
    make: z.string().trim().max(80).optional(),
    model: z.string().trim().max(80).optional(),
    modelYear: z.number().int().min(1950).max(2200).optional(),
    capacityMilli: z.number().int().safe().positive(),
    gpsDeviceId: z.string().trim().max(120).nullish(),
  })
  .strict()
  .refine((value) => value.truckTypeId || value.vehicleType, {
    path: ["truckTypeId"],
    message: "Select a configured truck type",
  });

export const driverCommandSchema = z
  .object({
    vendorId: uuid,
    code,
    displayName: text(160),
    mobile: e164MobileSchema,
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
    cargoTypeId: uuid.optional(),
    bodyTypeId: uuid.optional(),
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
