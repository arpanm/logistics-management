import { z } from "zod";

const trimmed = (min: number, max: number) =>
  z.string().trim().min(min).max(max);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,30}$/);
const email = z.string().trim().toLowerCase().email().max(254);
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const DEFAULT_COUNTRIES = ["AE", "GB", "IN", "SG", "US"] as const;
export const DEFAULT_CURRENCIES = [
  "AED",
  "EUR",
  "GBP",
  "INR",
  "SGD",
  "USD",
] as const;
const luminance = (colour: string) => {
  const channels = colour
    .slice(1)
    .match(/.{2}/g)!
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};
const contrast = (first: string, second: string) => {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
};

const tenantCreateBaseSchema = z
  .object({
    name: trimmed(2, 120),
    code,
    legalName: trimmed(2, 160),
    taxIdentifier: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,32}$/),
    address: z
      .object({
        line1: trimmed(2, 160),
        line2: z.string().trim().max(160).optional().default(""),
        city: trimmed(2, 80),
        region: trimmed(2, 80),
        postalCode: trimmed(2, 20),
        country: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/),
      })
      .strict(),
    timezone: z
      .string()
      .trim()
      .refine((value) => {
        try {
          Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid IANA timezone"),
    locale: z
      .string()
      .trim()
      .refine((value) => {
        try {
          return Intl.getCanonicalLocales(value).length === 1;
        } catch {
          return false;
        }
      }, "Invalid locale"),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    fiscalYearStart: z
      .object({
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
      })
      .refine(({ month, day }) => {
        if (month === 2 && day > 28) return false;
        return (
          day <= [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        );
      }, "Fiscal year start must be valid every year"),
    legalEntity: z
      .object({
        name: trimmed(2, 160),
        code,
        taxIdentifier: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{2,32}$/)
          .optional(),
      })
      .strict(),
    support: z
      .object({
        name: trimmed(2, 100),
        email,
        mobile: z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{7,14}$/)
          .optional(),
      })
      .strict(),
    owner: z.object({ name: trimmed(2, 100), email }).strict(),
    branding: z
      .object({
        shortName: trimmed(2, 32),
        primaryColor: hex,
        accentColor: hex,
      })
      .strict(),
    active: z.boolean().default(true),
  })
  .strict();

export function tenantCreateSchemaFor(
  countries: readonly string[] = DEFAULT_COUNTRIES,
  currencies: readonly string[] = DEFAULT_CURRENCIES,
) {
  return tenantCreateBaseSchema.superRefine((value, context) => {
    if (!countries.includes(value.address.country))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address", "country"],
        message: "Unsupported country code",
      });
    if (!currencies.includes(value.currency))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Unsupported currency code",
      });
    if (contrast(value.branding.primaryColor, "#FFFFFF") < 4.5)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branding", "primaryColor"],
        message: "Primary colour must meet WCAG AA contrast with white text",
      });
    if (contrast(value.branding.accentColor, "#14213D") < 4.5)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branding", "accentColor"],
        message: "Accent colour must meet WCAG AA contrast with dark text",
      });
  });
}

export const tenantCreateSchema = tenantCreateSchemaFor();

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;

export const loginSchema = z
  .object({
    email: email.optional(),
    identifier: z.string().trim().min(3).max(254).optional(),
    password: z.string().min(1).max(256),
    tenantCode: code.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.email || value.identifier), {
    path: ["identifier"],
    message: "Email or mobile is required",
  });
export const inviteAcceptSchema = z
  .object({
    displayName: trimmed(2, 100),
    password: z.string().min(12).max(256),
    passwordConfirmation: z.string(),
    termsAccepted: z.literal(true),
  })
  .strict()
  .refine((v) => v.password === v.passwordConfirmation, {
    path: ["passwordConfirmation"],
    message: "Passwords do not match",
  });
export const lifecycleSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: trimmed(10, 500),
    confirmationCode: code.optional(),
  })
  .strict();
export const switchTenantSchema = z
  .object({
    tenantId: z.string().uuid(),
    expectedContextVersion: z.number().int().positive(),
  })
  .strict();
export const checklistSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    state: z.enum(["COMPLETE", "NOT_STARTED"]),
  })
  .strict();
export const probeCreateSchema = z
  .object({ label: trimmed(2, 100), note: z.string().trim().max(2000) })
  .strict();
export const probeUpdateSchema = probeCreateSchema
  .extend({ expectedVersion: z.number().int().positive() })
  .partial({ label: true, note: true })
  .strict();
export const membershipFixtureSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    status: z.enum(["ACTIVE", "SUSPENDED"]),
  })
  .strict();

export const scopeTypeSchema = z.enum([
  "TENANT",
  "LEGAL_ENTITY",
  "REGION",
  "BRANCH",
  "CLIENT",
  "LOCATION",
  "VENDOR",
  "ASSIGNED_TRIP",
]);
export const scopeActionSchema = z.enum([
  "READ",
  "CREATE",
  "UPDATE",
  "APPROVE",
  "EXPORT",
  "ADMIN",
]);
const identifierFields = z
  .object({
    email: email.optional(),
    mobile: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
  })
  .refine((v) => Boolean(v.email || v.mobile), {
    message: "Email or mobile is required",
    path: ["email"],
  });
export const accessGrantSchema = z.object({
  scopeNodeId: z.string().uuid(),
  actions: z.array(scopeActionSchema).min(1),
});
export const accessAssignmentSchema = z.object({
  roleId: z.string().uuid(),
  grants: z.array(accessGrantSchema).min(1),
});
export const accessInviteSchema = identifierFields.and(
  z.object({
    displayName: trimmed(2, 100),
    employeeCode: code,
    authenticationMethod: z.literal("LOCAL_PASSWORD").default("LOCAL_PASSWORD"),
    portalAudience: z.enum(["INTERNAL", "VENDOR", "DRIVER", "CLIENT"]),
    assignments: z.array(accessAssignmentSchema).min(1),
    expiresInHours: z.number().int().min(1).max(720).default(72),
    reason: z.string().trim().max(500).optional(),
  }),
);
export const accessAcceptSchema = z
  .object({
    displayName: trimmed(2, 100),
    password: z.string().min(12).max(256).optional(),
    passwordConfirmation: z.string().optional(),
    currentPassword: z.string().min(1).max(256).optional(),
    termsAccepted: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.password && value.password !== value.passwordConfirmation)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passwordConfirmation"],
        message: "Passwords do not match",
      });
    if (!value.password && !value.currentPassword)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Credentials are required",
      });
  });
export const accessMutationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  assignments: z.array(accessAssignmentSchema).min(1),
  reason: trimmed(10, 500),
  previewFingerprint: z.string().length(64),
});
export const accessPreviewSchema = z.object({
  expectedVersion: z.number().int().positive(),
  assignments: z.array(accessAssignmentSchema).min(1),
});
export const accessLifecycleSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: trimmed(10, 500),
});
export const roleMutationSchema = z.object({
  code,
  name: trimmed(2, 100),
  description: z.string().trim().max(500).default(""),
  portalAudiences: z
    .array(z.enum(["INTERNAL", "VENDOR", "DRIVER", "CLIENT"]))
    .min(1),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_.-]+$/)).min(1),
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
});
export const policyOperationSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  action: scopeActionSchema,
  resourceId: z.string().uuid(),
});
export const fnd02FixtureSchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,12}$/),
    scenario: z.enum(["SCOPES_ONLY", "ACCESS_MATRIX", "PORTALS", "REPORTS"]),
  })
  .strict();
export const probeAccessCreateSchema = z
  .object({
    label: trimmed(2, 100),
    resourceType: z
      .enum(["WORK_ITEM", "ALLOCATION", "TRIP", "PAYMENT", "CLIENT_STATUS"])
      .default("WORK_ITEM"),
    scopeNodeIds: z.array(z.string().uuid()).min(1),
    assignedUserId: z.string().uuid().optional(),
    status: z.enum(["OPEN", "COMPLETED"]).default("OPEN"),
    taxIdentifier: z.string().trim().max(32).optional(),
    mobile: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    bankDetail: z.string().trim().max(64).optional(),
    commercialRateMinor: z.number().int().safe().optional(),
    paymentMinor: z.number().int().safe().optional(),
    internalMarginMinor: z.number().int().safe().optional(),
  })
  .superRefine((value, context) => {
    if (value.resourceType === "TRIP" && !value.assignedUserId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignedUserId"],
        message: "Assigned user is required for trip proof resources",
      });
  });
export const probeAccessUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    label: trimmed(2, 100).optional(),
    status: z.enum(["OPEN", "COMPLETED"]).optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.status !== undefined, {
    message: "At least one change is required",
  });
export const probeReassignSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    assignedUserId: z.string().uuid(),
    reason: trimmed(10, 500),
  })
  .strict();

export const sha256 = async (value: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
};

export function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
