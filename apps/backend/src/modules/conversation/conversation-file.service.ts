import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { SessionActor } from "@logistics/auth";
import { toJsonSafe } from "@logistics/domain";
import type { Prisma } from "@logistics/db";
import { z } from "zod";
import { AppError } from "../../app.service.js";
import { DataProvider, type Dataset } from "../data/data.provider.js";
import { importProfiles } from "../data/manifest.js";

type Tx = Prisma.TransactionClient;
type Actor = SessionActor & { membershipId?: string | null };
type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const importModes = ["APPEND", "UPSERT", "FULL_FILE"] as const;
const conversationCommitBlockedDatasets = new Set<Dataset>([
  "INVOICE_COLLECTION",
  "PAYMENT_RECEIPT",
]);
const governedTargets = {
  ORGANIZATION_NODE: "organization-nodes",
  EMPLOYEE: "employees",
  CLIENT: "clients",
  VENDOR: "vendors",
  VEHICLE: "vehicles",
  DRIVER: "drivers",
  INDENT: "indents",
  ALLOCATION: "allocations",
  TRIP: "trips",
  POD: "pod-tasks",
  INVOICE: "invoices",
  RECEIPT: "receipts",
  VENDOR_BILL: "vendor-bills",
} as const;

export type ConversationAttachmentInput = {
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  contentBase64: string;
  dataset?: string;
  sourceTimezone?: string;
  importMode?: string;
};

export type PreparedConversationAttachment = {
  filename: string;
  mediaType:
    | "text/csv"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/pdf"
    | "image/jpeg"
    | "image/png";
  byteSize: number;
  checksumSha256: string;
  content: Buffer;
  scanState: "PENDING" | "QUARANTINED";
  dataset: Dataset | null;
  importMetadata: {
    sourceTimezone: string;
    importMode: (typeof importModes)[number];
  } | null;
};

const documentInputSchema = z
  .object({
    attachmentId: uuid,
    targetType: z.enum(
      Object.keys(governedTargets) as [
        keyof typeof governedTargets,
        ...(keyof typeof governedTargets)[],
      ],
    ),
    targetId: uuid,
    category: z.string().trim().min(1).max(80),
    confidentiality: z.enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"]),
    issueDate: z.string().date().nullish(),
    expiryDate: z.string().date().nullish(),
    documentId: uuid.optional(),
    idempotencyKey: z.string().min(8).max(200),
    correlationId: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    ({ issueDate, expiryDate }) =>
      !issueDate || !expiryDate || expiryDate >= issueDate,
    {
      path: ["expiryDate"],
      message: "Expiry date must not precede issue date",
    },
  );

@Injectable()
export class ConversationFileService {
  constructor(private readonly data: DataProvider) {}

  commitPolicy(dataset: Dataset) {
    const allowed = !conversationCommitBlockedDatasets.has(dataset);
    return {
      allowed,
      reason: allowed
        ? null
        : "Financial imports require their canonical draft, approval and ledger workflow.",
    };
  }

  validateAttachment(
    input: ConversationAttachmentInput,
  ): PreparedConversationAttachment {
    const filename = input.filename.trim();
    if (!filename || filename.length > 255 || /[\\/\0]/.test(filename))
      throw new AppError(
        400,
        "ATTACHMENT_FILENAME_INVALID",
        "Attachment filename is invalid",
      );
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1)
      throw new AppError(
        400,
        "ATTACHMENT_SIZE_INVALID",
        "Attachment size is invalid",
      );
    if (input.byteSize > 5_000_000)
      throw new AppError(
        413,
        "ATTACHMENT_TOO_LARGE",
        "Attachment exceeds the 5 MB conversation limit",
      );
    const compact = input.contentBase64.replace(/\s/g, "");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        compact,
      )
    )
      throw new AppError(
        400,
        "ATTACHMENT_BASE64_INVALID",
        "Attachment content is not valid base64",
      );
    const content = Buffer.from(compact, "base64");
    if (
      content.length !== input.byteSize ||
      !/^[a-f0-9]{64}$/.test(input.checksumSha256) ||
      sha256(content) !== input.checksumSha256
    )
      throw new AppError(
        400,
        "ATTACHMENT_INTEGRITY_INVALID",
        "Attachment size or checksum does not match",
      );

    const mediaType = input.mediaType.toLowerCase();
    const extension = filename.toLowerCase().split(".").pop() ?? "";
    const isCsv =
      mediaType === "text/csv" &&
      extension === "csv" &&
      !content.includes(0) &&
      !content.toString("utf8").includes("\uFFFD");
    const isXlsx =
      mediaType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
      extension === "xlsx" &&
      content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const isPdf =
      mediaType === "application/pdf" &&
      extension === "pdf" &&
      content.subarray(0, 5).toString() === "%PDF-";
    const isJpeg =
      mediaType === "image/jpeg" &&
      ["jpg", "jpeg"].includes(extension) &&
      content[0] === 0xff &&
      content[1] === 0xd8 &&
      content[content.length - 2] === 0xff &&
      content[content.length - 1] === 0xd9;
    const isPng =
      mediaType === "image/png" &&
      extension === "png" &&
      content
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!(isCsv || isXlsx || isPdf || isJpeg || isPng))
      throw new AppError(
        415,
        "ATTACHMENT_MEDIA_MISMATCH",
        "Attachment extension, declared type and content do not match",
      );

    const dataFile = isCsv || isXlsx;
    const dataset = input.dataset as Dataset | undefined;
    if (dataFile && (!dataset || !(dataset in importProfiles)))
      throw new AppError(
        400,
        "IMPORT_METADATA_REQUIRED",
        "Select a supported dataset for CSV/XLSX imports",
      );
    if (!dataFile && input.dataset)
      throw new AppError(
        400,
        "IMPORT_METADATA_INVALID",
        "Dataset metadata is only valid for CSV/XLSX imports",
      );
    const importMode = input.importMode ?? "APPEND";
    if (!importModes.includes(importMode as (typeof importModes)[number]))
      throw new AppError(400, "IMPORT_MODE_INVALID", "Import mode is invalid");
    const sourceTimezone = input.sourceTimezone?.trim() || "Asia/Kolkata";
    try {
      new Intl.DateTimeFormat("en", { timeZone: sourceTimezone });
    } catch {
      throw new AppError(
        400,
        "SOURCE_TIMEZONE_INVALID",
        "Source timezone is invalid",
      );
    }

    return {
      filename,
      mediaType: mediaType as PreparedConversationAttachment["mediaType"],
      byteSize: content.length,
      checksumSha256: input.checksumSha256,
      content,
      scanState: dataFile ? "PENDING" : "QUARANTINED",
      dataset: dataFile ? dataset! : null,
      importMetadata: dataFile
        ? {
            sourceTimezone,
            importMode: importMode as (typeof importModes)[number],
          }
        : null,
    };
  }

  async previewImportInTransaction(
    tx: Tx,
    actor: Actor,
    raw: {
      attachmentId: string;
      idempotencyKey: string;
      correlationId: string;
    },
  ) {
    const input = z
      .object({
        attachmentId: uuid,
        idempotencyKey: z.string().min(8).max(200),
        correlationId: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(raw);
    const attachment = await this.ownedAttachment(
      tx,
      actor,
      input.attachmentId,
    );
    if (
      !attachment.dataset ||
      attachment.scanState !== "PENDING" ||
      ![
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ].includes(String(attachment.mediaType))
    )
      throw new AppError(
        409,
        "IMPORT_ATTACHMENT_UNAVAILABLE",
        "A validated CSV/XLSX attachment is required",
      );
    const metadata = (attachment.metadata ?? {}) as Record<string, unknown>;
    const request = {
      attachmentId: input.attachmentId,
      dataset: String(attachment.dataset),
      checksumSha256: String(attachment.checksum),
      importMetadata: metadata,
      operation: "IMPORT_PREVIEW",
    };
    return this.idempotentHandoff(
      tx,
      actor,
      "IMPORT_PREVIEW",
      input.attachmentId,
      input.idempotencyKey,
      request,
      async () => {
        const content = Buffer.from(attachment.content as Uint8Array);
        this.assertStoredIntegrity(attachment, content);
        const parsed = await this.data.parseFile(
          String(attachment.filename),
          String(attachment.mediaType),
          content.toString("base64"),
        );
        const result = (await this.data.previewInTransaction(tx, actor, {
          dataset: String(attachment.dataset) as Dataset,
          filename: String(attachment.filename),
          mediaType: String(attachment.mediaType),
          byteSize: Number(attachment.byteSize),
          checksum: String(attachment.checksum),
          sourceTimezone: String(metadata.sourceTimezone ?? "Asia/Kolkata"),
          importMode: (metadata.importMode ?? "APPEND") as
            | "APPEND"
            | "UPSERT"
            | "FULL_FILE",
          headers: parsed.headers,
          rows: parsed.rows,
          idempotencyKey: `conversation:${input.idempotencyKey}`,
        })) as Row;
        const commitPolicy = this.commitPolicy(
          String(attachment.dataset) as Dataset,
        );
        return {
          attachmentId: input.attachmentId,
          importJobId: String(result.id),
          dataset: String(attachment.dataset),
          state: result.state,
          version: Number(result.version),
          summary: result.summary,
          commitAllowed: commitPolicy.allowed,
          commitBlockedReason: commitPolicy.reason,
          nextStep:
            result.state === "VALIDATED" && commitPolicy.allowed
              ? "Confirm the import commit after reviewing the validation summary."
              : result.state === "VALIDATED"
                ? "Use the canonical finance workflow to create drafts, approvals and ledger entries from this validated file."
                : "Correct the reported import errors before committing.",
        };
      },
      input.correlationId,
    );
  }

  async commitImportInTransaction(
    tx: Tx,
    actor: Actor,
    raw: {
      attachmentId: string;
      jobId: string;
      expectedVersion: number;
      idempotencyKey: string;
      correlationId: string;
    },
  ) {
    const input = z
      .object({
        attachmentId: uuid,
        jobId: uuid,
        expectedVersion: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(200),
        correlationId: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(raw);
    const attachment = await this.ownedAttachment(
      tx,
      actor,
      input.attachmentId,
    );
    const dataset = String(attachment.dataset) as Dataset;
    if (!(dataset in importProfiles))
      throw new AppError(
        409,
        "IMPORT_ATTACHMENT_UNAVAILABLE",
        "A validated CSV/XLSX attachment is required",
      );
    const commitPolicy = this.commitPolicy(dataset);
    if (!commitPolicy.allowed)
      throw new AppError(
        409,
        "FINANCIAL_IMPORT_REQUIRES_CANONICAL_WORKFLOW",
        commitPolicy.reason!,
      );
    const preview = await this.handoffFor(
      tx,
      actor,
      "IMPORT_PREVIEW",
      input.attachmentId,
    );
    if (String(preview.importJobId) !== input.jobId)
      throw new AppError(
        404,
        "IMPORT_JOB_NOT_FOUND",
        "Import job is unavailable",
      );
    return this.idempotentHandoff(
      tx,
      actor,
      "IMPORT_COMMIT",
      input.attachmentId,
      input.idempotencyKey,
      {
        attachmentId: input.attachmentId,
        jobId: input.jobId,
        expectedVersion: input.expectedVersion,
      },
      async () => {
        const result = await this.data.commitInTransaction(
          tx,
          actor,
          input.jobId,
          input.expectedVersion,
        );
        return {
          attachmentId: input.attachmentId,
          importJobId: input.jobId,
          state: result.state,
          version: Number(result.version),
          summary: result.summary,
        };
      },
      input.correlationId,
    );
  }

  async createGovernedDocumentInTransaction(
    tx: Tx,
    actor: Actor,
    raw: z.input<typeof documentInputSchema>,
  ) {
    const input = documentInputSchema.parse(raw);
    const attachment = await this.ownedAttachment(
      tx,
      actor,
      input.attachmentId,
    );
    if (
      attachment.scanState !== "QUARANTINED" ||
      !["application/pdf", "image/jpeg", "image/png"].includes(
        String(attachment.mediaType),
      )
    )
      throw new AppError(
        409,
        "DOCUMENT_ATTACHMENT_UNAVAILABLE",
        "A quarantined PDF, JPEG or PNG attachment is required",
      );
    await this.authorizeResource(
      tx,
      actor,
      governedTargets[input.targetType],
      input.targetId,
    );
    return this.idempotentHandoff(
      tx,
      actor,
      "GOVERNED_DOCUMENT",
      input.attachmentId,
      input.idempotencyKey,
      {
        attachmentId: input.attachmentId,
        checksumSha256: String(attachment.checksum),
        targetType: input.targetType,
        targetId: input.targetId,
        category: input.category,
        confidentiality: input.confidentiality,
        issueDate: input.issueDate,
        expiryDate: input.expiryDate,
        documentId: input.documentId,
      },
      async () => {
        const content = Buffer.from(attachment.content as Uint8Array);
        this.assertStoredDocumentIntegrity(attachment, content);
        const document = input.documentId
          ? (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT id,current_version AS "currentVersion",category,confidentiality,issue_date::text AS "issueDate",expiry_date::text AS "expiryDate" FROM app.governed_documents
                 WHERE tenant_id=$1::uuid AND id=$2::uuid AND target_type=$3 AND target_id=$4::uuid FOR UPDATE`,
                this.tenant(actor),
                input.documentId,
                input.targetType,
                input.targetId,
              )
            )[0]
          : (
              await tx.$queryRawUnsafe<Row[]>(
                `INSERT INTO app.governed_documents(tenant_id,target_type,target_id,category,confidentiality,issue_date,expiry_date,created_by)
                 VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::date,$7::date,$8::uuid)
                 RETURNING id,current_version AS "currentVersion"`,
                this.tenant(actor),
                input.targetType,
                input.targetId,
                input.category,
                input.confidentiality,
                input.issueDate ?? null,
                input.expiryDate ?? null,
                actor.userId,
              )
            )[0];
        if (!document)
          throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
        if (
          input.documentId &&
          (document.category !== input.category ||
            document.confidentiality !== input.confidentiality ||
            (document.issueDate ?? null) !== (input.issueDate ?? null) ||
            (document.expiryDate ?? null) !== (input.expiryDate ?? null))
        )
          throw new AppError(
            409,
            "DOCUMENT_METADATA_CONFLICT",
            "A new version must retain the governed document metadata",
          );
        const nextVersion = input.documentId
          ? Number(document.currentVersion) + 1
          : 1;
        const version = (
          await tx.$queryRawUnsafe<Row[]>(
            `INSERT INTO app.governed_document_versions(tenant_id,document_id,version,file_name,media_type,byte_size,checksum_sha256,content,malware_state,source,uploaded_by)
             VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,'PENDING','UPLOAD',$9::uuid)
             RETURNING id,document_id AS "documentId",version,file_name AS "fileName",media_type AS "mediaType",byte_size::text AS "byteSize",checksum_sha256 AS "checksumSha256",malware_state AS "malwareState"`,
            this.tenant(actor),
            document.id,
            nextVersion,
            attachment.filename,
            attachment.mediaType,
            content.length,
            attachment.checksum,
            content,
            actor.userId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `UPDATE app.governed_documents SET current_version=$1,verification_state='PENDING',updated_at=now()
           WHERE tenant_id=$2::uuid AND id=$3::uuid`,
          nextVersion,
          this.tenant(actor),
          document.id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json)
           VALUES($1::uuid,$2::uuid,'document.uploaded.via_conversation','document',$3::uuid,$4,$5::jsonb)`,
          this.tenant(actor),
          actor.userId,
          document.id,
          input.correlationId,
          JSON.stringify(toJsonSafe(version)),
        );
        return {
          attachmentId: input.attachmentId,
          documentId: String(document.id),
          documentVersionId: String(version.id),
          version: nextVersion,
          malwareState: "PENDING",
          verificationState: "PENDING",
          nextStep:
            "The document remains quarantined until a scanner records a result.",
        };
      },
      input.correlationId,
    );
  }

  private tenant(actor: Actor) {
    if (!actor.activeTenantId || !actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    return actor.activeTenantId;
  }

  private async ownedAttachment(tx: Tx, actor: Actor, attachmentId: string) {
    const attachment = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT a.id,a.filename,a.media_type AS "mediaType",a.byte_size AS "byteSize",a.checksum_sha256 AS checksum,
                a.content,a.scan_state AS "scanState",a.dataset,a.import_metadata AS metadata
         FROM app.conversation_attachments a
         JOIN app.conversation_messages m ON m.tenant_id=a.tenant_id AND m.id=a.message_id
         JOIN app.conversation_threads t ON t.tenant_id=m.tenant_id AND t.id=m.thread_id
         WHERE a.tenant_id=$1::uuid AND a.id=$2::uuid AND t.membership_id=$3::uuid AND t.actor_id=$4::uuid`,
        this.tenant(actor),
        uuid.parse(attachmentId),
        actor.membershipId,
        actor.userId,
      )
    )[0];
    if (!attachment)
      throw new AppError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
    return attachment;
  }

  private async authorizeResource(
    tx: Tx,
    actor: Actor,
    resource: string,
    resourceId: string,
  ) {
    const allowed = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'governance.admin','CREATE',$4,$5::uuid) AS allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        resource,
        resourceId,
      )
    )[0]?.allowed;
    if (!(allowed === true || allowed === "true"))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private assertStoredDocumentIntegrity(attachment: Row, content: Buffer) {
    this.assertStoredIntegrity(attachment, content);
    const mediaType = String(attachment.mediaType);
    const valid =
      (mediaType === "application/pdf" &&
        content.subarray(0, 5).toString() === "%PDF-") ||
      (mediaType === "image/png" &&
        content
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )) ||
      (mediaType === "image/jpeg" &&
        content[0] === 0xff &&
        content[1] === 0xd8 &&
        content[content.length - 2] === 0xff &&
        content[content.length - 1] === 0xd9);
    if (!valid)
      throw new AppError(
        409,
        "ATTACHMENT_MEDIA_MISMATCH",
        "Attachment content no longer matches its media type",
      );
  }

  private assertStoredIntegrity(attachment: Row, content: Buffer) {
    if (
      Number(attachment.byteSize) !== content.length ||
      sha256(content) !== attachment.checksum
    )
      throw new AppError(
        409,
        "ATTACHMENT_INTEGRITY_CHANGED",
        "Attachment integrity validation failed",
      );
  }

  private async handoffFor(
    tx: Tx,
    actor: Actor,
    operation: "IMPORT_PREVIEW" | "IMPORT_COMMIT" | "GOVERNED_DOCUMENT",
    attachmentId: string,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT result FROM app.conversation_file_handoffs
         WHERE tenant_id=$1::uuid AND attachment_id=$2::uuid AND operation=$3`,
        this.tenant(actor),
        attachmentId,
        operation,
      )
    )[0];
    if (!row)
      throw new AppError(
        409,
        "FILE_HANDOFF_REQUIRED",
        "Complete the preceding governed file step first",
      );
    return row.result as Record<string, unknown>;
  }

  private async idempotentHandoff<T extends Record<string, unknown>>(
    tx: Tx,
    actor: Actor,
    operation: "IMPORT_PREVIEW" | "IMPORT_COMMIT" | "GOVERNED_DOCUMENT",
    attachmentId: string,
    idempotencyKey: string,
    request: Record<string, unknown>,
    execute: () => Promise<T>,
    correlationId: string,
  ): Promise<T & { replayed?: boolean }> {
    const tenantId = this.tenant(actor);
    const keyHash = sha256(`${tenantId}:${actor.userId}:${idempotencyKey}`);
    const requestHash = sha256(JSON.stringify(toJsonSafe(request)));
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:${attachmentId}:${operation}`,
    );
    const existing = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT actor_id AS "actorId",membership_id AS "membershipId",idempotency_key_hash AS "keyHash",request_hash AS "requestHash",result
         FROM app.conversation_file_handoffs
         WHERE tenant_id=$1::uuid AND attachment_id=$2::uuid AND operation=$3`,
        tenantId,
        attachmentId,
        operation,
      )
    )[0];
    if (existing) {
      if (
        existing.actorId !== actor.userId ||
        existing.membershipId !== actor.membershipId ||
        existing.keyHash !== keyHash ||
        existing.requestHash !== requestHash
      )
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This file action was already completed with different input",
        );
      return { ...(existing.result as T), replayed: true };
    }
    const result = toJsonSafe(await execute()) as T;
    await tx.$executeRawUnsafe(
      `INSERT INTO app.conversation_file_handoffs(
         tenant_id,attachment_id,operation,actor_id,membership_id,idempotency_key_hash,request_hash,
         import_job_id,document_version_id,result,correlation_id)
       VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10::jsonb,$11)`,
      tenantId,
      attachmentId,
      operation,
      actor.userId,
      actor.membershipId,
      keyHash,
      requestHash,
      operation === "GOVERNED_DOCUMENT" ? null : String(result.importJobId),
      operation === "GOVERNED_DOCUMENT"
        ? String(result.documentVersionId)
        : null,
      JSON.stringify(result),
      correlationId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json)
       VALUES($1::uuid,$2::uuid,$3,'conversation_attachment',$4::uuid,$5,$6::jsonb)`,
      tenantId,
      actor.userId,
      `conversation.file.${operation.toLowerCase()}`,
      attachmentId,
      correlationId,
      JSON.stringify({ operation, result }),
    );
    return result;
  }
}
