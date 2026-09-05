export type ConversationLimits = {
  maxAttachments: number;
  maxAttachmentBytes: number;
  acceptedMediaTypes: string[];
};

export type ConversationCapabilities = {
  commands?: Array<{
    intent: string;
    label: string;
    risk: string;
    channels: string[];
    requiresConfirmation: boolean;
  }>;
  attachments?: {
    maxFiles: number;
    maxBytesEach: number;
    acceptedMediaTypes: string[];
  };
  whatsapp?: { enabled: boolean };
  languages?: Array<{
    code: "en" | "hi" | "hi-Latn" | string;
    label: string;
    enabled: boolean;
  }>;
};

export type ConversationThread = {
  id: string;
  title: string;
  channel?: string;
  createdAt: string;
  updatedAt?: string;
};

export type ConversationMessage = {
  id: string;
  role?: "USER" | "ASSISTANT" | "SYSTEM" | string;
  actorType?: string;
  direction?: "INBOUND" | "OUTBOUND" | string;
  kind?: string;
  text?: string;
  body?: string;
  state?: string;
  correlationId?: string;
  createdAt: string;
  clarification?: {
    prompt?: string;
    missingFields?: string[];
    choices?: Array<{
      id: string;
      label: string;
      description?: string;
      resourceType?: string;
    }>;
  };
  result?: ConversationResult;
};

export type ConversationResult = {
  kind?: "STATUS" | "APPROVAL" | "FINANCE" | "REPORT" | "INSIGHT" | string;
  title: string;
  summary?: string;
  metrics?: Array<{ label: string; value: string; tone?: string }>;
  columns?: Array<{ key: string; label: string }>;
  rows?: Array<Record<string, unknown>>;
  links?: Array<{ label: string; href: string; download?: boolean }>;
};

export type ConversationProposal = {
  id: string;
  intent: string;
  summary: string;
  arguments: Record<string, unknown>;
  state: string;
  risk?: string;
  requiresStepUp?: boolean;
  version: number;
  createdAt: string;
  expiresAt?: string;
};

export type ConversationAttachment = {
  id?: string;
  filename: string;
  mediaType: string;
  byteSize?: number;
  checksumSha256?: string;
  state?: string;
  scanState?: string;
};

export type ConversationThreadDetail = {
  thread: ConversationThread;
  messages: ConversationMessage[];
  proposals: ConversationProposal[];
  attachments: ConversationAttachment[];
};

export type PendingAttachment = ConversationAttachment & {
  byteSize: number;
  checksumSha256: string;
  contentBase64: string;
};

export type IdempotencySlot = { identity: string; key: string };

export function stableIdempotencySlot(
  current: IdempotencySlot | null,
  identity: string,
  createKey: () => string,
): IdempotencySlot {
  return current?.identity === identity
    ? current
    : { identity, key: createKey() };
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  maxAttachments: 1,
  maxAttachmentBytes: 5 * 1024 * 1024,
  acceptedMediaTypes: [
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ],
};

export function effectiveConversationLimits(
  value?: ConversationCapabilities["attachments"],
): ConversationLimits {
  return {
    maxAttachments:
      value?.maxFiles ?? DEFAULT_CONVERSATION_LIMITS.maxAttachments,
    maxAttachmentBytes:
      value?.maxBytesEach ?? DEFAULT_CONVERSATION_LIMITS.maxAttachmentBytes,
    acceptedMediaTypes: value?.acceptedMediaTypes?.length
      ? value.acceptedMediaTypes
      : DEFAULT_CONVERSATION_LIMITS.acceptedMediaTypes,
  };
}

export function formatFileLimit(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function mediaTypeForFile(filename: string, reportedType: string) {
  if (reportedType) return reportedType;
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "csv") return "text/csv";
  if (extension === "xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "application/octet-stream";
}
