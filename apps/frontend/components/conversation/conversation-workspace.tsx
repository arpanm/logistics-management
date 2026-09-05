"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, type ApiError } from "../api";
import { Modal } from "../modal";
import { DialogActions, DialogBody, DialogHeader } from "../ui/primitives";
import styles from "./conversation-workspace.module.css";
import {
  type ConversationCapabilities,
  type ConversationMessage,
  type ConversationProposal,
  type ConversationResult,
  type ConversationThread,
  type ConversationThreadDetail,
  effectiveConversationLimits,
  formatFileLimit,
  mediaTypeForFile,
  type PendingAttachment,
  stableIdempotencySlot,
  type IdempotencySlot,
} from "./types";

const importDatasets = [
  ["CLIENT", "Clients"],
  ["LOCATION", "Locations"],
  ["VENDOR", "Vendors"],
  ["INDENT_PLACEMENT", "Indent placement"],
  ["POD", "POD"],
  ["INVOICE_COLLECTION", "Invoice collection"],
  ["PAYMENT_RECEIPT", "Payment receipts"],
] as const;

const confirmationCopy = {
  en: {
    eyebrow: "Confirm proposed action",
    back: "Back",
    confirm: "Confirm and execute",
    executing: "Executing…",
  },
  hi: {
    eyebrow: "प्रस्तावित कार्रवाई की पुष्टि करें",
    back: "वापस",
    confirm: "पुष्टि करें और लागू करें",
    executing: "लागू हो रहा है…",
  },
  "hi-Latn": {
    eyebrow: "Proposed action confirm karein",
    back: "Wapas",
    confirm: "Confirm karke execute karein",
    executing: "Execute ho raha hai…",
  },
} as const;

type ConfirmationLanguage = keyof typeof confirmationCopy;

type Me = {
  user: { email: string };
  memberships: Array<{ id: string; name: string }>;
  activeTenantId: string | null;
};

type Effective = { capabilities: string[]; portalAudience?: string };

type MessageResult = {
  message: ConversationMessage;
  assistantMessage: ConversationMessage;
  proposal?: ConversationProposal;
};

type WhatsappChallenge = {
  id: string;
  code: string;
  instruction: string;
  expiresAt: string;
};

type WhatsappStatus = {
  enabled: boolean;
  binding: { linkedAt: string; addressLast4: string } | null;
  preference: {
    proactiveState: string;
    quietStart: string | null;
    quietEnd: string | null;
    consentedAt?: string | null;
    unsubscribedAt?: string | null;
    version: number;
  };
};

type WhatsappDelivery = {
  id: string;
  category: string;
  templateCode: string | null;
  state: string;
  attempts: number;
  safeErrorCode?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
};

function roleOf(message: ConversationMessage) {
  const value = (
    message.role ??
    message.actorType ??
    message.direction ??
    "SYSTEM"
  ).toUpperCase();
  if (value === "INBOUND") return "USER";
  if (value === "OUTBOUND") return "ASSISTANT";
  return value;
}

function messageText(message: ConversationMessage) {
  return message.text ?? message.body ?? "Update recorded.";
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${valueText(item)}`)
      .join("\n");
  return String(value);
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function proposalKind(intent: string) {
  if (intent.includes("APPROVAL")) return "approval";
  if (/(FINANCE|INVOICE|RECEIPT|PAYMENT|VENDOR_BILL)/.test(intent))
    return "finance";
  if (/(STATUS|TRIP|POD|ALLOCATION)/.test(intent)) return "status";
  return "standard";
}

function safeConversationHref(href: string) {
  return href.startsWith("/api/v1/conversations/") &&
    !href.includes("://") &&
    !/[\u0000-\u001f]/.test(href)
    ? href
    : null;
}

function resultKind(label: string) {
  if (/reference|search/i.test(label)) return "REFERENCE_SEARCH";
  if (/insight|attention/i.test(label)) return "INSIGHT";
  if (/report|status/i.test(label)) return "REPORT";
  return "DATA";
}

function parsedMessageResult(
  message: ConversationMessage,
): ConversationResult | null {
  if (message.result) return message.result;
  if (roleOf(message) !== "ASSISTANT") return null;
  const text = messageText(message);
  const separator = text.indexOf("\n");
  if (separator < 1) return null;
  const title = text.slice(0, separator).trim();
  try {
    const parsed = JSON.parse(text.slice(separator + 1)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const sourceRows = Array.isArray(record.rows)
      ? record.rows
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(parsed)
          ? parsed
          : [];
    const rows = sourceRows.filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
    const columnKeys = [
      ...new Set(rows.slice(0, 25).flatMap((row) => Object.keys(row))),
    ].slice(0, 12);
    const metrics = Object.entries(record)
      .filter(
        ([key, value]) =>
          !["rows", "items", "title", "note"].includes(key) &&
          ["string", "number"].includes(typeof value),
      )
      .slice(0, 8)
      .map(([key, value]) => ({ label: humanize(key), value: String(value) }));
    return {
      kind: resultKind(title),
      title:
        typeof record.title === "string" && record.title ? record.title : title,
      summary: typeof record.note === "string" ? record.note : undefined,
      metrics,
      columns: columnKeys.map((key) => ({ key, label: humanize(key) })),
      rows,
    };
  } catch {
    return null;
  }
}

function executionConversationResult(
  title: string,
  raw: unknown,
): ConversationResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rowValues = Array.isArray(record.sampleRows)
    ? record.sampleRows
    : Array.isArray(record.rows)
      ? record.rows
      : [];
  const rows = rowValues.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
  const columnKeys = [
    ...new Set(rows.slice(0, 20).flatMap((row) => Object.keys(row))),
  ].slice(0, 12);
  return {
    kind: proposalKind(title.toUpperCase()),
    title,
    summary:
      typeof record.summary === "string"
        ? record.summary
        : typeof record.nextStep === "string"
          ? record.nextStep
          : "The authorized action completed successfully.",
    metrics: Object.entries(record)
      .filter(
        ([key, value]) =>
          !["sampleRows", "rows", "summary", "nextStep"].includes(key) &&
          ["string", "number"].includes(typeof value),
      )
      .slice(0, 8)
      .map(([key, value]) => ({ label: humanize(key), value: String(value) })),
    columns: columnKeys.map((key) => ({ key, label: humanize(key) })),
    rows,
  };
}

function ResultView({
  result,
  onChooseReference,
}: {
  result: ConversationResult;
  onChooseReference?: (record: Record<string, unknown>) => void;
}) {
  const columns = result.columns ?? [];
  const rows = result.rows ?? [];
  return (
    <section className={styles.result} aria-label={result.title}>
      <div className={styles.resultHeader}>
        <div>
          <p className="eyebrow">{humanize(result.kind ?? "RESULT")}</p>
          <h3>{result.title}</h3>
        </div>
      </div>
      {result.summary && <p>{result.summary}</p>}
      {result.metrics?.length ? (
        <dl className={styles.resultMetrics}>
          {result.metrics.map((metric) => (
            <div key={metric.label} data-tone={metric.tone ?? "neutral"}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {columns.length && rows.length ? (
        <div className={styles.resultTableWrap}>
          <table className={styles.resultTable}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th scope="col" key={column.key}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td data-label={column.label} key={column.key}>
                      {valueText(row[column.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.kind === "REFERENCE_SEARCH" && onChooseReference ? (
        <div className={styles.choiceGrid} aria-label="Permitted references">
          {rows.map((row, index) => (
            <button
              type="button"
              key={String(row.id ?? index)}
              onClick={() => onChooseReference(row)}
            >
              <strong>
                {valueText(row.name ?? row.legalName ?? row.code ?? row.id)}
              </strong>
              <small>Use this permitted reference</small>
            </button>
          ))}
        </div>
      ) : null}
      {result.links?.length ? (
        <div className={styles.resultLinks}>
          {result.links.map((link) => {
            const href = safeConversationHref(link.href);
            return href ? (
              <a
                className="button"
                href={href}
                download={link.download || undefined}
                key={`${link.label}-${href}`}
              >
                {link.label}
              </a>
            ) : null;
          })}
        </div>
      ) : null}
    </section>
  );
}

async function encodeFile(file: File): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const checksumSha256 = Array.from(digest)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return {
    filename: file.name,
    mediaType: mediaTypeForFile(file.name, file.type),
    byteSize: file.size,
    checksumSha256,
    contentBase64: btoa(binary),
  };
}

function ProposalPreview({ proposal }: { proposal: ConversationProposal }) {
  return (
    <dl
      className={styles.preview}
      aria-label={`${humanize(proposalKind(proposal.intent))} structured change preview`}
    >
      {Object.entries(proposal.arguments).map(([key, value]) => (
        <div key={key}>
          <dt>{humanize(key)}</dt>
          <dd
            data-format={
              /minor$/i.test(key)
                ? "minor"
                : /(status|state|decision|approval)/i.test(key)
                  ? "state"
                  : "text"
            }
          >
            {valueText(value)}
            {/minor$/i.test(key) ? " minor units" : ""}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ConversationWorkspace() {
  const [capabilities, setCapabilities] =
    useState<ConversationCapabilities | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [detail, setDetail] = useState<ConversationThreadDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dataset, setDataset] = useState("CLIENT");
  const [language, setLanguage] = useState<ConfirmationLanguage>("en");
  const [attachmentStage, setAttachmentStage] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<ConversationProposal | null>(
    null,
  );
  const [whatsappChallenge, setWhatsappChallenge] =
    useState<WhatsappChallenge | null>(null);
  const [executionResult, setExecutionResult] =
    useState<ConversationResult | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsappStatus | null>(
    null,
  );
  const [whatsappDeliveries, setWhatsappDeliveries] = useState<
    WhatsappDelivery[]
  >([]);
  const [proactiveWhatsapp, setProactiveWhatsapp] = useState(false);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const timelineEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messageIdempotency = useRef<IdempotencySlot | null>(null);
  const confirmationIdempotency = useRef<IdempotencySlot | null>(null);
  const threadIdempotency = useRef<IdempotencySlot | null>(null);
  const whatsappIdempotency = useRef<IdempotencySlot | null>(null);

  const limits = useMemo(
    () => effectiveConversationLimits(capabilities?.attachments),
    [capabilities],
  );
  const activeTenant = me?.memberships.find(
    (membership) => membership.id === me.activeTenantId,
  );
  const accessContext = effective?.portalAudience
    ? `${humanize(effective.portalAudience)} member`
    : "Tenant member";
  const hasDataAttachment = attachments.some(
    (attachment) =>
      attachment.mediaType === "text/csv" ||
      attachment.mediaType.includes("spreadsheetml"),
  );

  const loadThread = useCallback(
    async (threadId: string, preserveExecution = false) => {
      setThreadLoading(true);
      setError(null);
      if (!preserveExecution) setExecutionResult(null);
      try {
        setDetail(
          await api<ConversationThreadDetail>(
            `/conversations/threads/${threadId}`,
          ),
        );
      } catch (value) {
        setError(value as ApiError);
      } finally {
        setThreadLoading(false);
      }
    },
    [],
  );

  const refreshThreads = useCallback(async () => {
    const result = await api<
      ConversationThread[] | { items: ConversationThread[] }
    >("/conversations/threads");
    const items = Array.isArray(result) ? result : result.items;
    setThreads(items);
    return items;
  }, []);

  const loadWhatsapp = useCallback(async () => {
    try {
      const [status, deliveries] = await Promise.all([
        api<WhatsappStatus>("/conversations/whatsapp/status"),
        api<{ items: WhatsappDelivery[]; total: number }>(
          "/conversations/whatsapp/deliveries",
        ),
      ]);
      setWhatsappStatus(status);
      setWhatsappDeliveries(deliveries.items);
      setProactiveWhatsapp(status.preference.proactiveState === "OPTED_IN");
      setQuietStart(status.preference.quietStart?.slice(0, 5) ?? "");
      setQuietEnd(status.preference.quietEnd?.slice(0, 5) ?? "");
    } catch (value) {
      setError(value as ApiError);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<ConversationCapabilities>("/conversations/capabilities"),
      api<ConversationThread[] | { items: ConversationThread[] }>(
        "/conversations/threads",
      ),
      api<Me>("/auth/me"),
      api<Effective>("/tenant/access/effective"),
    ])
      .then(([catalog, threadResult, identity, access]) => {
        if (!active) return;
        const items = Array.isArray(threadResult)
          ? threadResult
          : threadResult.items;
        setCapabilities(catalog);
        setThreads(items);
        setMe(identity);
        setEffective(access);
        if (items[0]) void loadThread(items[0].id);
      })
      .catch((value) => active && setError(value as ApiError))
      .finally(() => active && setInitialLoading(false));
    return () => {
      active = false;
    };
  }, [loadThread]);

  useEffect(() => {
    if (capabilities?.whatsapp?.enabled) void loadWhatsapp();
  }, [capabilities?.whatsapp?.enabled, loadWhatsapp]);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, detail?.proposals.length, busy]);

  async function newThread() {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      threadIdempotency.current = stableIdempotencySlot(
        threadIdempotency.current,
        "WEB:New conversation",
        () => crypto.randomUUID(),
      );
      const thread = await api<ConversationThread>("/conversations/threads", {
        method: "POST",
        headers: { "Idempotency-Key": threadIdempotency.current.key },
        body: JSON.stringify({ title: "New conversation" }),
      });
      threadIdempotency.current = null;
      await refreshThreads();
      await loadThread(thread.id);
      composer.current?.focus();
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setError(null);
    if (!files.length) return;
    if (attachments.length + files.length > limits.maxAttachments) {
      setError({
        code: "ATTACHMENT_LIMIT",
        message: `Attach no more than ${limits.maxAttachments} files per message.`,
      });
      return;
    }
    for (const file of files) {
      if (file.size > limits.maxAttachmentBytes) {
        setError({
          code: "ATTACHMENT_TOO_LARGE",
          message: `${file.name} exceeds the ${formatFileLimit(limits.maxAttachmentBytes)} limit.`,
        });
        return;
      }
      if (
        limits.acceptedMediaTypes.length &&
        !limits.acceptedMediaTypes.includes(
          mediaTypeForFile(file.name, file.type),
        )
      ) {
        setError({
          code: "ATTACHMENT_TYPE_INVALID",
          message: `${file.name} is not an accepted file type.`,
        });
        return;
      }
    }
    setBusy(true);
    setAttachmentStage(
      `Preparing ${files.length === 1 ? files[0]?.name : `${files.length} files`}…`,
    );
    try {
      const encoded = await Promise.all(files.map(encodeFile));
      setAttachments((current) => [...current, ...encoded]);
      setAttachmentStage("Attachment ready to send.");
    } catch {
      setAttachmentStage("");
      setError({
        code: "ATTACHMENT_READ_FAILED",
        message: "One of the selected files could not be read safely.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || (!draft.trim() && !attachments.length)) return;
    setBusy(true);
    setError(null);
    setNotice("");
    if (attachments.length) setAttachmentStage("Uploading and validating…");
    try {
      const messageText =
        draft.trim() || "Preview the attached file for import";
      const operationIdentity = JSON.stringify({
        threadId: detail.thread.id,
        text: messageText,
        dataset: hasDataAttachment ? dataset : null,
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          byteSize: attachment.byteSize,
          checksumSha256: attachment.checksumSha256,
        })),
      });
      messageIdempotency.current = stableIdempotencySlot(
        messageIdempotency.current,
        operationIdentity,
        () => crypto.randomUUID(),
      );
      await api<MessageResult>(
        `/conversations/threads/${detail.thread.id}/messages`,
        {
          method: "POST",
          headers: { "Idempotency-Key": messageIdempotency.current.key },
          body: JSON.stringify({
            text: messageText,
            attachments: attachments.map((attachment) => ({
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              byteSize: attachment.byteSize,
              checksumSha256: attachment.checksumSha256,
              contentBase64: attachment.contentBase64,
              ...(attachment.mediaType === "text/csv" ||
              attachment.mediaType.includes("spreadsheetml")
                ? {
                    dataset,
                    sourceTimezone:
                      Intl.DateTimeFormat().resolvedOptions().timeZone ||
                      "Asia/Kolkata",
                    importMode: "APPEND",
                  }
                : {}),
            })),
          }),
        },
      );
      messageIdempotency.current = null;
      setDraft("");
      setAttachments([]);
      setAttachmentStage("");
      await Promise.all([loadThread(detail.thread.id), refreshThreads()]);
      setNotice(
        "Message processed. Review any proposed change before confirming.",
      );
    } catch (value) {
      if (attachments.length)
        setAttachmentStage(
          "Upload needs attention. Correct the error and retry.",
        );
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function transitionProposal(
    proposal: ConversationProposal,
    action: "confirm" | "cancel",
  ) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const operationIdentity = `${proposal.id}:${proposal.version}:${action}`;
      confirmationIdempotency.current = stableIdempotencySlot(
        confirmationIdempotency.current,
        operationIdentity,
        () => crypto.randomUUID(),
      );
      const outcome = await api<{
        execution?: { result?: unknown };
      }>(`/conversations/proposals/${proposal.id}/${action}`, {
        method: "POST",
        headers: {
          "Idempotency-Key": confirmationIdempotency.current.key,
        },
        body: JSON.stringify({ expectedVersion: proposal.version }),
      });
      confirmationIdempotency.current = null;
      if (action === "confirm")
        setExecutionResult(
          executionConversationResult(
            `${proposal.summary} result`,
            outcome.execution?.result,
          ),
        );
      setConfirming(null);
      if (detail) await loadThread(detail.thread.id, action === "confirm");
      setNotice(
        action === "confirm"
          ? "The approved action was executed and audited."
          : "The proposed action was cancelled.",
      );
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function linkWhatsapp() {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      setWhatsappChallenge(
        await api<WhatsappChallenge>(
          "/conversations/whatsapp/link-challenges",
          {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: "{}",
          },
        ),
      );
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function saveWhatsappPreferences() {
    if (!whatsappStatus) return;
    if (Boolean(quietStart) !== Boolean(quietEnd)) {
      setError({
        code: "QUIET_HOURS_INVALID",
        message: "Set both quiet-hours times, or clear both.",
      });
      return;
    }
    setBusy(true);
    setError(null);
    setNotice("");
    const identity = JSON.stringify({
      proactiveWhatsapp,
      quietStart,
      quietEnd,
      version: whatsappStatus.preference.version,
    });
    try {
      whatsappIdempotency.current = stableIdempotencySlot(
        whatsappIdempotency.current,
        `preference:${identity}`,
        () => crypto.randomUUID(),
      );
      await api("/conversations/whatsapp/preferences", {
        method: "PATCH",
        headers: { "Idempotency-Key": whatsappIdempotency.current.key },
        body: JSON.stringify({
          proactive: proactiveWhatsapp,
          quietStart: quietStart || null,
          quietEnd: quietEnd || null,
          expectedVersion: whatsappStatus.preference.version,
        }),
      });
      whatsappIdempotency.current = null;
      await loadWhatsapp();
      setNotice("WhatsApp consent and quiet hours were updated.");
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function unlinkWhatsapp() {
    if (!whatsappStatus?.binding) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      whatsappIdempotency.current = stableIdempotencySlot(
        whatsappIdempotency.current,
        `unlink:${whatsappStatus.binding.linkedAt}`,
        () => crypto.randomUUID(),
      );
      await api("/conversations/whatsapp/unlink", {
        method: "POST",
        headers: { "Idempotency-Key": whatsappIdempotency.current.key },
        body: "{}",
      });
      whatsappIdempotency.current = null;
      await loadWhatsapp();
      setNotice("WhatsApp was unlinked and proactive alerts were stopped.");
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const canUse = Boolean(
    effective?.capabilities.some(
      (entry) =>
        entry === "conversation.use" || entry.startsWith("conversation."),
    ),
  );
  const canLinkWhatsapp = Boolean(
    capabilities?.whatsapp?.enabled &&
      effective?.capabilities.includes("conversation.admin"),
  );
  const languageOptions = useMemo(() => {
    const advertised = new Map(
      capabilities?.languages?.map((item) => [item.code, item]) ?? [],
    );
    return [
      { code: "en", label: "English", enabled: true },
      {
        code: "hi",
        label: "हिन्दी (ready when enabled)",
        enabled: advertised.get("hi")?.enabled ?? false,
      },
      {
        code: "hi-Latn",
        label: "Hinglish (ready when enabled)",
        enabled: advertised.get("hi-Latn")?.enabled ?? false,
      },
    ] as Array<{
      code: ConfirmationLanguage;
      label: string;
      enabled: boolean;
    }>;
  }, [capabilities?.languages]);
  const localizedConfirmation = confirmationCopy[language];

  return (
    <div className={styles.workspace} aria-busy={initialLoading || busy}>
      <aside className={styles.threads} aria-label="Conversation threads">
        <div className={styles.threadsHeader}>
          <h2>Assistant</h2>
          <button
            className={styles.newThread}
            type="button"
            onClick={() => void newThread()}
            disabled={busy || !canUse}
          >
            New
          </button>
        </div>
        {threads.length ? (
          <ul className={styles.threadList}>
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  className={styles.threadButton}
                  type="button"
                  aria-current={detail?.thread.id === thread.id}
                  onClick={() => void loadThread(thread.id)}
                  disabled={threadLoading}
                >
                  <span>{thread.title || "Conversation"}</span>
                  <time dateTime={thread.updatedAt ?? thread.createdAt}>
                    {new Date(
                      thread.updatedAt ?? thread.createdAt,
                    ).toLocaleString()}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>Start a private tenant conversation.</p>
        )}
        <details className={styles.discovery}>
          <summary>What can I ask?</summary>
          <p className={styles.hint}>
            Available actions follow your current role and active tenant.
          </p>
          <ul>
            {capabilities?.commands?.map((command) => (
              <li key={command.intent}>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(command.label);
                    composer.current?.focus();
                  }}
                  disabled={!detail || busy}
                >
                  <strong>{command.label}</strong>
                  <small>
                    {humanize(command.risk)} risk ·{" "}
                    {command.channels.join(" / ")}
                    {command.requiresConfirmation
                      ? " · confirmation required"
                      : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </details>
        <section className={styles.channelStatus} aria-label="WhatsApp status">
          <div>
            <strong>WhatsApp</strong>
            <span className={styles.stateChip}>
              {whatsappStatus?.binding
                ? "Linked"
                : capabilities?.whatsapp?.enabled
                  ? "Not linked"
                  : "Disabled"}
            </span>
          </div>
          {whatsappStatus?.binding && (
            <dl>
              <div>
                <dt>Number</dt>
                <dd>•••• {whatsappStatus.binding.addressLast4}</dd>
              </div>
              <div>
                <dt>Proactive alerts</dt>
                <dd>{humanize(whatsappStatus.preference.proactiveState)}</dd>
              </div>
              <div>
                <dt>Quiet hours</dt>
                <dd>
                  {whatsappStatus.preference.quietStart &&
                  whatsappStatus.preference.quietEnd
                    ? `${whatsappStatus.preference.quietStart.slice(0, 5)}–${whatsappStatus.preference.quietEnd.slice(0, 5)}`
                    : "Not configured"}
                </dd>
              </div>
            </dl>
          )}
          {whatsappStatus?.binding && (
            <div className={styles.preferenceForm}>
              <label className={styles.checkboxField}>
                <input
                  type="checkbox"
                  checked={proactiveWhatsapp}
                  onChange={(event) =>
                    setProactiveWhatsapp(event.target.checked)
                  }
                  disabled={busy}
                />
                Receive proactive alerts
              </label>
              <div className={styles.quietHours}>
                <label>
                  Quiet from
                  <input
                    type="time"
                    value={quietStart}
                    onChange={(event) => setQuietStart(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  Quiet until
                  <input
                    type="time"
                    value={quietEnd}
                    onChange={(event) => setQuietEnd(event.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>
              <div className={styles.channelActions}>
                <button
                  type="button"
                  onClick={() => void saveWhatsappPreferences()}
                  disabled={busy}
                >
                  Save preferences
                </button>
                <button
                  type="button"
                  onClick={() => void unlinkWhatsapp()}
                  disabled={busy}
                >
                  Unlink &amp; stop
                </button>
              </div>
            </div>
          )}
          {whatsappDeliveries.length > 0 && (
            <details className={styles.deliveryStatus}>
              <summary>Recent delivery status</summary>
              <ul>
                {whatsappDeliveries.slice(0, 5).map((delivery) => (
                  <li key={delivery.id}>
                    <span>{humanize(delivery.category)}</span>
                    <strong>{humanize(delivery.state)}</strong>
                    {delivery.safeErrorCode && (
                      <small>{humanize(delivery.safeErrorCode)}</small>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {capabilities?.whatsapp?.enabled && (
            <button
              type="button"
              onClick={() => void loadWhatsapp()}
              disabled={busy}
            >
              Refresh channel status
            </button>
          )}
          <p className={styles.hint}>
            Linking does not subscribe you to alerts. Consent, quiet hours and
            unsubscribe remain explicit channel settings.
          </p>
        </section>
      </aside>

      <section className={styles.main} aria-label="Assistant workspace">
        <header className={styles.conversationHeader}>
          <div>
            <h1>{detail?.thread.title || "Conversational operations"}</h1>
            <div className={styles.actorMeta}>
              <span>{me?.user.email ?? "Signed-in user"}</span>
              <span aria-hidden="true">·</span>
              <span>{activeTenant?.name ?? "Active tenant"}</span>
              <span className={styles.roleChip}>{accessContext}</span>
            </div>
          </div>
          <div className={styles.headerActions}>
            <label>
              <span className="sr-only">Conversation language</span>
              <select
                aria-label="Conversation language"
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value as ConfirmationLanguage)
                }
              >
                {languageOptions.map((option) => (
                  <option
                    value={option.code}
                    disabled={!option.enabled}
                    key={option.code}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {canLinkWhatsapp && (
              <button
                type="button"
                onClick={() => void linkWhatsapp()}
                disabled={busy}
              >
                Link WhatsApp
              </button>
            )}
          </div>
        </header>

        <div
          className={styles.timeline}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {initialLoading || threadLoading ? (
            <p className={styles.loading} role="status">
              Loading your secure conversation…
            </p>
          ) : !detail ? (
            <div className={styles.empty}>
              <h2>Tell me what changed</h2>
              <p>
                Use normal English to enter data, upload a supported file,
                report a status update, or request an approval. Every write is
                previewed before it is executed.
              </p>
              <button
                type="button"
                className={styles.newThread}
                onClick={() => void newThread()}
                disabled={busy || !canUse}
              >
                Start conversation
              </button>
            </div>
          ) : (
            <>
              <ol className={styles.messageList} aria-label="Message timeline">
                {detail.messages.map((message) => {
                  const role = roleOf(message);
                  const result = parsedMessageResult(message);
                  return (
                    <li
                      key={message.id}
                      className={`${styles.message} ${
                        role === "USER"
                          ? styles.messageUser
                          : role === "ASSISTANT"
                            ? styles.messageAssistant
                            : styles.messageSystem
                      }`}
                    >
                      <div className={styles.messageMeta}>
                        <span>
                          {humanize(
                            message.kind && role !== "USER"
                              ? message.kind
                              : role,
                          )}
                        </span>
                        <time dateTime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <p>
                        {result
                          ? messageText(message).split("\n", 1)[0]
                          : messageText(message)}
                      </p>
                      {message.clarification && (
                        <section
                          className={styles.clarification}
                          aria-label="Required information"
                        >
                          {message.clarification.prompt && (
                            <strong>{message.clarification.prompt}</strong>
                          )}
                          {message.clarification.missingFields?.length ? (
                            <p>
                              Needed:{" "}
                              {message.clarification.missingFields
                                .map(humanize)
                                .join(", ")}
                            </p>
                          ) : null}
                          {message.clarification.choices?.length ? (
                            <div className={styles.choiceGrid}>
                              {message.clarification.choices.map((choice) => (
                                <button
                                  type="button"
                                  key={choice.id}
                                  onClick={() => {
                                    setDraft(
                                      `Use ${choice.label} (${choice.id}) for the requested ${choice.resourceType ?? "reference"}.`,
                                    );
                                    composer.current?.focus();
                                  }}
                                >
                                  <strong>{choice.label}</strong>
                                  {choice.description && (
                                    <small>{choice.description}</small>
                                  )}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </section>
                      )}
                      {result && (
                        <ResultView
                          result={result}
                          onChooseReference={(record) => {
                            const id = valueText(record.id);
                            const label = valueText(
                              record.name ??
                                record.legalName ??
                                record.code ??
                                record.id,
                            );
                            setDraft(`Use ${label} (${id}) for this request.`);
                            composer.current?.focus();
                          }}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
              {detail.attachments.length > 0 && (
                <ul
                  className={styles.attachments}
                  aria-label="Conversation attachment status"
                >
                  {detail.attachments.map((attachment) => (
                    <li className={styles.attachmentRow} key={attachment.id}>
                      <span title={attachment.filename}>
                        {attachment.filename}
                      </span>
                      <small>
                        {attachment.byteSize
                          ? formatFileLimit(attachment.byteSize)
                          : "Attached"}
                        {attachment.scanState || attachment.state
                          ? ` · ${humanize(
                              attachment.scanState ?? attachment.state ?? "",
                            )}`
                          : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {detail.proposals.map((proposal) => (
                <article
                  className={styles.proposal}
                  data-kind={proposalKind(proposal.intent)}
                  key={proposal.id}
                >
                  <div className={styles.proposalHeader}>
                    <div>
                      <p className="eyebrow">
                        Proposed {humanize(proposalKind(proposal.intent))}{" "}
                        action
                      </p>
                      <h3>{proposal.summary}</h3>
                    </div>
                    <span className={styles.stateChip}>
                      {humanize(proposal.state)}
                    </span>
                  </div>
                  <div className={styles.proposalMeta}>
                    <span>{humanize(proposal.risk ?? "standard")} risk</span>
                    {proposal.expiresAt && (
                      <time dateTime={proposal.expiresAt}>
                        Review by{" "}
                        {new Date(proposal.expiresAt).toLocaleString()}
                      </time>
                    )}
                  </div>
                  <ProposalPreview proposal={proposal} />
                  {proposal.requiresStepUp && (
                    <p className={styles.hint}>
                      This sensitive action may require fresh MFA verification.
                    </p>
                  )}
                  {proposal.state === "PENDING" ||
                  proposal.state === "PROPOSED" ? (
                    <div className={styles.proposalActions}>
                      <button
                        type="button"
                        className={styles.confirm}
                        onClick={() => setConfirming(proposal)}
                        disabled={busy}
                      >
                        Review and confirm
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void transitionProposal(proposal, "cancel")
                        }
                        disabled={busy}
                      >
                        Cancel proposal
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
              {executionResult && <ResultView result={executionResult} />}
              <div ref={timelineEnd} />
            </>
          )}
        </div>

        <form
          className={styles.composer}
          onSubmit={(event) => void send(event)}
        >
          {error && (
            <p className={styles.error} role="alert">
              {error.message}
              {error.correlationId && (
                <>
                  {" "}
                  Reference <code>{error.correlationId}</code>
                </>
              )}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}
          <label htmlFor="assistant-message" className="sr-only">
            Message the assistant
          </label>
          <textarea
            ref={composer}
            id="assistant-message"
            value={draft}
            placeholder="Example: Mark trip DEMO-TRIP-014 as arrived at the destination"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                event.currentTarget.form?.requestSubmit();
            }}
            disabled={!detail || busy || !canUse}
          />
          {attachments.length > 0 && (
            <ul
              className={styles.attachments}
              aria-label="Selected attachments"
            >
              {attachments.map((attachment) => (
                <li
                  className={styles.attachmentRow}
                  key={`${attachment.filename}-${attachment.checksumSha256}`}
                >
                  <span title={attachment.filename}>{attachment.filename}</span>
                  <small>{formatFileLimit(attachment.byteSize)}</small>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() => {
                      const next = attachments.filter(
                        (item) =>
                          item.checksumSha256 !== attachment.checksumSha256,
                      );
                      setAttachments(next);
                      if (!next.length) setAttachmentStage("");
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachmentStage && (
            <p className={styles.hint} role="status">
              {attachmentStage}
            </p>
          )}
          {hasDataAttachment && (
            <label className={styles.importDataset}>
              File contains
              <select
                value={dataset}
                onChange={(event) => setDataset(event.target.value)}
                disabled={busy}
              >
                {importDatasets.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
              <small>
                Used to validate the spreadsheet against the correct import
                format. The data is still previewed before commit.
              </small>
            </label>
          )}
          <div className={styles.composerActions}>
            <div>
              <label className={styles.fileButton}>
                Attach files
                <input
                  className={styles.fileInput}
                  type="file"
                  multiple
                  accept={limits.acceptedMediaTypes.join(",")}
                  onChange={(event) => void chooseFiles(event)}
                  disabled={!detail || busy || !canUse}
                />
              </label>
              <span className={styles.hint}>
                Up to {limits.maxAttachments} files,{" "}
                {formatFileLimit(limits.maxAttachmentBytes)} each
              </span>
            </div>
            <button
              className={styles.newThread}
              type="submit"
              disabled={
                !detail ||
                busy ||
                !canUse ||
                (!draft.trim() && !attachments.length)
              }
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
          <p className={styles.hint}>
            Ctrl/⌘ + Enter to send. The assistant can only propose commands
            allowed for your current role; the server rechecks access before
            execution.
          </p>
        </form>
      </section>

      {confirming && (
        <Modal
          titleId="assistant-confirm-title"
          onClose={() => !busy && setConfirming(null)}
        >
          <div className="ui-dialog-layout">
            <DialogHeader
              titleId="assistant-confirm-title"
              eyebrow={localizedConfirmation.eyebrow}
              title={confirming.summary}
              onClose={() => setConfirming(null)}
              closeDisabled={busy}
            />
            <DialogBody>
              <p className={styles.dialogCopy}>
                Review the exact structured values below. Confirmation executes
                one authorized, audited command; it does not grant the assistant
                broader access.
              </p>
              <ProposalPreview proposal={confirming} />
            </DialogBody>
            <DialogActions>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={busy}
              >
                {localizedConfirmation.back}
              </button>
              <button
                type="button"
                className={styles.confirm}
                onClick={() => void transitionProposal(confirming, "confirm")}
                disabled={busy}
              >
                {busy
                  ? localizedConfirmation.executing
                  : localizedConfirmation.confirm}
              </button>
            </DialogActions>
          </div>
        </Modal>
      )}
      {whatsappChallenge && (
        <Modal
          titleId="whatsapp-link-title"
          onClose={() => setWhatsappChallenge(null)}
        >
          <div className="ui-dialog-layout">
            <DialogHeader
              titleId="whatsapp-link-title"
              eyebrow="Verified channel"
              title="Link your WhatsApp number"
              onClose={() => setWhatsappChallenge(null)}
            />
            <DialogBody>
              <p className={styles.dialogCopy}>
                {whatsappChallenge.instruction} The sender number becomes linked
                only after the signed provider message arrives. Never share this
                one-time code with another person.
              </p>
              <p className={styles.linkCode} aria-label="WhatsApp link code">
                {whatsappChallenge.code}
              </p>
              <p className={styles.hint}>
                Expires {new Date(whatsappChallenge.expiresAt).toLocaleString()}
                .
              </p>
            </DialogBody>
            <DialogActions>
              <button type="button" onClick={() => setWhatsappChallenge(null)}>
                Done
              </button>
            </DialogActions>
          </div>
        </Modal>
      )}
    </div>
  );
}
