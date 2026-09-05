import { z } from "zod";

export const conversationChannelSchema = z.enum(["WEB", "WHATSAPP"]);
export const conversationIntentSchema = z.enum([
  "PROBE_CREATE",
  "PROBE_UPDATE",
  "GOVERNED_COMMENT_CREATE",
  "IMPORT_PREVIEW",
  "IMPORT_COMMIT",
  "DOCUMENT_UPLOAD",
  "CLIENT_CREATE",
  "VENDOR_CREATE",
  "RECORD_RECEIPT",
  "OPERATIONS_STATUS_UPDATE",
  "FINANCE_STATUS_UPDATE",
  "APPROVAL_DECIDE",
  "REFERENCE_SEARCH",
  "STATUS_REPORT",
  "OPERATIONAL_INSIGHT",
]);

const attachmentSchema = z
  .object({
    filename: z.string().trim().min(1).max(180),
    mediaType: z.string().trim().min(3).max(120),
    byteSize: z.number().int().min(1).max(5_000_000),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    contentBase64: z.string().min(1).max(7_000_000),
    dataset: z
      .enum([
        "CLIENT",
        "LOCATION",
        "VENDOR",
        "INDENT_PLACEMENT",
        "POD",
        "INVOICE_COLLECTION",
        "PAYMENT_RECEIPT",
      ])
      .optional(),
    sourceTimezone: z.string().trim().min(1).max(80).optional(),
    importMode: z.enum(["APPEND", "UPSERT", "FULL_FILE"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isData =
      value.mediaType === "text/csv" ||
      value.mediaType.includes("spreadsheetml");
    if (isData && !value.dataset)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataset"],
        message: "Dataset is required for CSV/XLSX",
      });
    if (isData && !value.sourceTimezone)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceTimezone"],
        message: "Source timezone is required for CSV/XLSX",
      });
    if (isData && !value.importMode)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["importMode"],
        message: "Import mode is required for CSV/XLSX",
      });
  });

export type ConversationInboundAttachment = z.input<typeof attachmentSchema>;

export const conversationThreadCreateSchema = z
  .object({ title: z.string().trim().min(1).max(120).optional() })
  .strict();
export const conversationMessageCreateSchema = z
  .object({
    text: z.string().trim().min(1).max(8_000),
    attachments: z.array(attachmentSchema).max(1).default([]),
  })
  .strict();
export const conversationProposalActionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const whatsappChallengeCreateSchema = z.object({}).strict();

export type ConversationIntent = z.infer<typeof conversationIntentSchema>;

export type ConversationExtraction = {
  intent: ConversationIntent | null;
  confidence: number;
  arguments: Record<string, unknown>;
  missing: string[];
};

export function extractConfiguredConversationIntent(
  provider: "deterministic" | "disabled",
  text: string,
): ConversationExtraction {
  return provider === "disabled"
    ? { intent: null, confidence: 0, arguments: {}, missing: [] }
    : extractEnglishConversationIntent(text);
}

/**
 * Deliberately bounded English extractor. It only emits identifiers from the
 * closed registry above; an AI extractor can later implement this interface,
 * but its output must still be validated against the command-specific schema.
 */
export function extractEnglishConversationIntent(
  text: string,
): ConversationExtraction {
  const value = normalizeConversationalEnglish(text);
  const uuid =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
  const id = value.match(uuid)?.[0];
  const version = Number(value.match(/\bversion\s+(\d+)\b/i)?.[1] ?? NaN);
  if (/\b(create|add)\b.*\b(probe|test record)\b/i.test(value)) {
    const label = value.match(/\blabel\s+["']?([^,"']+)/i)?.[1]?.trim();
    const note = value.match(/\bnote\s+["']?(.+)$/i)?.[1]?.trim();
    return {
      intent: "PROBE_CREATE",
      confidence: 1,
      arguments: { label, note: note ?? "" },
      missing: label ? [] : ["label"],
    };
  }
  if (/\b(update|edit)\b.*\b(probe|test record)\b/i.test(value)) {
    const label = value.match(/\blabel\s+["']?([^,"']+)/i)?.[1]?.trim();
    const note = value.match(/\bnote\s+["']?(.+)$/i)?.[1]?.trim();
    return {
      intent: "PROBE_UPDATE",
      confidence: 1,
      arguments: { id, expectedVersion: version, label, note },
      missing: [!id && "id", !Number.isInteger(version) && "version"]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(add|create|post)\b.*\bcomment\b/i.test(value)) {
    const targetType = value
      .match(/\b(?:indent|allocation|trip|pod|invoice|vendor bill)\b/i)?.[0]
      ?.toLowerCase()
      .replace(" ", "_");
    const body = value.match(
      /\bcomment\s+(?:on\s+)?(?:the\s+)?[^:]*:?\s*(.+)$/i,
    )?.[1];
    return {
      intent: "GOVERNED_COMMENT_CREATE",
      confidence: 0.95,
      arguments: { targetId: id, targetType, body, visibility: "INTERNAL" },
      missing: [!targetType && "targetType", !id && "targetId", !body && "body"]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(preview|validate)\b.*\b(import|file|csv|xlsx)\b/i.test(value))
    return {
      intent: "IMPORT_PREVIEW",
      confidence: 0.9,
      arguments: {},
      missing: [],
    };
  if (/\b(commit|apply)\b.*\b(import|file|csv|xlsx)\b/i.test(value)) {
    const jobId = value.match(/\b(?:job|import)\s+([0-9a-f-]{36})\b/i)?.[1];
    const attachmentId = value.match(/\battachment\s+([0-9a-f-]{36})\b/i)?.[1];
    const expectedVersion = integerField(value, "version");
    return {
      intent: "IMPORT_COMMIT",
      confidence: 0.95,
      arguments: {
        jobId,
        attachmentId,
        expectedVersion,
      },
      missing: [
        !jobId && "jobId",
        !attachmentId && "attachmentId",
        !expectedVersion && "version",
      ]
        .filter(Boolean)
        .map(String),
    };
  }
  if (
    /\b(upload|attach)\b.*\b(document|pod|invoice|receipt|file)\b/i.test(value)
  ) {
    const targetType = value.match(
      /\b(indent|allocation|trip|pod|invoice|receipt|vendor bill|client|vendor|vehicle|driver)\b/i,
    )?.[1];
    const category = field(value, "category") ?? "SUPPORTING_DOCUMENT";
    return {
      intent: "DOCUMENT_UPLOAD",
      confidence: 0.92,
      arguments: {
        targetType: targetType?.toUpperCase().replace(" ", "_"),
        targetId: id,
        category,
        confidentiality:
          field(value, "confidentiality")?.toUpperCase() ?? "INTERNAL",
      },
      missing: [!targetType && "targetType", !id && "targetId"]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(create|add)\s+(?:a\s+|new\s+)?\b(client|customer)\b/i.test(value)) {
    const codeValue = field(value, "code");
    const legalName = field(value, "legal name", "name");
    const billingEntity = field(value, "billing entity");
    return {
      intent: "CLIENT_CREATE",
      confidence: 0.94,
      arguments: {
        code: codeValue?.toUpperCase(),
        legalName,
        billingEntity,
        industry: field(value, "industry"),
        creditDays: integerField(value, "credit days") ?? 0,
        podMode: (field(value, "pod mode") ?? "DIGITAL").toUpperCase(),
        taxIdentifier: field(value, "tax identifier", "gstin"),
        escalationEmail: field(value, "email"),
        escalationMobile: field(value, "mobile"),
      },
      missing: [
        !codeValue && "code",
        !legalName && "legalName",
        !billingEntity && "billingEntity",
      ]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(create|add)\s+(?:a\s+|new\s+)?\b(vendor|carrier)\b/i.test(value)) {
    const codeValue = field(value, "code");
    const legalName = field(value, "legal name", "name");
    return {
      intent: "VENDOR_CREATE",
      confidence: 0.94,
      arguments: {
        code: codeValue?.toUpperCase(),
        legalName,
        pan: field(value, "pan"),
        gstin: field(value, "gstin"),
        tdsBasisPoints: integerField(value, "tds basis points", "tds bps") ?? 0,
        paymentTermsDays:
          integerField(value, "payment terms days", "payment days") ?? 0,
      },
      missing: [!codeValue && "code", !legalName && "legalName"]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(record|create|add)\b.*\b(receipt|payment received)\b/i.test(value)) {
    const receiptRef = field(value, "receipt ref", "reference");
    const client = field(value, "client", "customer");
    const amount = field(value, "amount");
    const amountMinor = amount ? decimalToMinor(amount) : undefined;
    const paymentDate = field(value, "payment date", "date");
    return {
      intent: "RECORD_RECEIPT",
      confidence: 0.94,
      arguments: {
        receiptRef,
        client,
        paymentDate,
        amountMinor,
        mode: (field(value, "mode") ?? "BANK_TRANSFER").toUpperCase(),
        instrumentNo: field(value, "instrument", "utr"),
        bankReference: field(value, "bank reference"),
      },
      missing: [
        !receiptRef && "receiptRef",
        !client && "client",
        !paymentDate && "paymentDate",
        amountMinor === undefined && "amount",
      ]
        .filter(Boolean)
        .map(String),
    };
  }
  const statusMatch = value.match(
    /\b(?:set|update|change|mark|move)\b.*\b(indent|allocation|trip|pod|invoice|receipt|vendor bill)\b.*\b(?:to|as)\s+([a-z][a-z _-]*?)(?=\s*(?:,|;|\bversion\b|\breason\b|$))/i,
  );
  if (statusMatch) {
    const resource = statusMatch[1]!.toLowerCase().replace(" ", "_");
    const targetRef =
      id ??
      field(value, "reference", "ref", "number") ??
      value.match(
        new RegExp(
          `\\b${statusMatch[1]!.replace(" ", "\\s+")}\\s+([A-Za-z0-9_-]{2,80})\\b`,
          "i",
        ),
      )?.[1];
    const expectedVersion = integerField(value, "version");
    const args = {
      resource,
      targetRef,
      expectedVersion,
      toState: statusMatch[2]!.trim().toUpperCase().replace(/[ -]+/g, "_"),
      reason: field(value, "reason"),
    };
    return {
      intent: ["invoice", "receipt", "vendor_bill"].includes(resource)
        ? "FINANCE_STATUS_UPDATE"
        : "OPERATIONS_STATUS_UPDATE",
      confidence: 0.93,
      arguments: args,
      missing: [!targetRef && "record reference", !expectedVersion && "version"]
        .filter(Boolean)
        .map(String),
    };
  }
  if (/\b(approve|reject)\b.*\b(approval|request)\b/i.test(value)) {
    const decision = /\breject\b/i.test(value) ? "REJECT" : "APPROVE";
    return {
      intent: "APPROVAL_DECIDE",
      confidence: 0.98,
      arguments: {
        instanceRef: id ?? field(value, "approval", "reference", "ref"),
        expectedVersion: integerField(value, "version"),
        decision,
        comment: field(value, "comment", "reason"),
      },
      missing: [
        !(id ?? field(value, "approval", "reference", "ref")) &&
          "approval reference",
        !integerField(value, "version") && "version",
        !field(value, "comment", "reason") && "comment",
      ]
        .filter(Boolean)
        .map(String),
    };
  }
  const search = value.match(
    /\b(?:find|search|lookup|select)\s+(?:for\s+)?(client|vendor|vehicle|driver|lane|indent|allocation|trip|invoice|receipt|vendor bill|approval)\s+(.+)$/i,
  );
  if (search)
    return {
      intent: "REFERENCE_SEARCH",
      confidence: 0.98,
      arguments: {
        resource: search[1]!.toLowerCase().replace(" ", "_"),
        search: search[2]!.trim(),
      },
      missing: [],
    };
  const report = value.match(
    /\b(?:show|list|report|count)\b.*\b(clients|vendors|vehicles|drivers|indents|allocations|trips|pods|invoices|receipts|vendor bills|approvals)\b/i,
  );
  if (report) {
    const state = value.match(
      /\bstate\s+([a-z_-]+)|\b(open|pending|active|posted|overdue|in transit|delivered)\b/i,
    );
    return {
      intent: "STATUS_REPORT",
      confidence: 0.92,
      arguments: {
        resource: report[1]!.toLowerCase().replace(" ", "_"),
        state: (state?.[1] ?? state?.[2])?.toUpperCase().replace(" ", "_"),
        limit: integerField(value, "limit") ?? 20,
      },
      missing: [],
    };
  }
  if (/\b(summary|insight|attention|risk|what needs attention)\b/i.test(value))
    return {
      intent: "OPERATIONAL_INSIGHT",
      confidence: 0.85,
      arguments: {},
      missing: [],
    };
  return { intent: null, confidence: 0, arguments: {}, missing: [] };
}

function normalizeConversationalEnglish(text: string) {
  return text
    .trim()
    .replace(/^(.+)\s+dikhao$/i, "show $1")
    .replace(/\bdikhao\b/gi, "show")
    .replace(/\bdhoondo\b|\bdhundho\b/gi, "find")
    .replace(/\bbanao\b/gi, "create")
    .replace(/\bmanzoor karo\b/gi, "approve")
    .replace(/\bkharej karo\b/gi, "reject");
}

function field(value: string, ...labels: string[]) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = value
      .match(
        new RegExp(`\\b${escaped}\\s*(?:is|=|:)?\\s*["']?([^,;"']+)`, "i"),
      )?.[1]
      ?.trim();
    if (found) return found;
  }
  return undefined;
}

function integerField(value: string, ...labels: string[]) {
  const raw = field(value, ...labels)?.match(/^-?\d+/)?.[0];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Convert a user-entered two-decimal currency amount to integer minor units. */
export function decimalToMinor(value: string): string | undefined {
  const normalized = value
    .replace(/[,\s]/g, "")
    .replace(/^(?:INR|Rs\.?|₹)/i, "");
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return undefined;
  return (
    BigInt(match[1]!) * 100n +
    BigInt((match[2] ?? "").padEnd(2, "0"))
  ).toString();
}
