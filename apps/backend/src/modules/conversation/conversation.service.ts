import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { SessionActor } from "@logistics/auth";
import { Prisma, withPlatform, withTenant } from "@logistics/db";
import {
  conversationMessageCreateSchema,
  conversationThreadCreateSchema,
  extractConfiguredConversationIntent,
  type ConversationInboundAttachment,
  type ConversationIntent,
} from "@logistics/domain";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import {
  approvalConversationSchema,
  clientConversationSchema,
  executeConversationRead,
  prepareConversationWrite,
  receiptConversationSchema,
  referenceSearchSchema,
  statusConversationSchema,
  statusReportSchema,
  vendorConversationSchema,
} from "./conversation-commands.js";
import { ConversationFileService } from "./conversation-file.service.js";
import { CanonicalService } from "../canonical/canonical.service.js";

type Row = Record<string, unknown>;
type Actor = SessionActor & { membershipId?: string | null };
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid();
const probeCreate = z
  .object({
    label: z.string().trim().min(1).max(100),
    note: z.string().trim().max(2000).default(""),
  })
  .strict();
const probeUpdate = z
  .object({
    id: uuid,
    expectedVersion: z.number().int().positive(),
    label: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
const commentCreate = z
  .object({
    targetType: z.enum([
      "indent",
      "allocation",
      "trip",
      "pod",
      "invoice",
      "vendor_bill",
    ]),
    targetId: uuid,
    body: z.string().trim().min(1).max(4000),
    visibility: z
      .enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"])
      .default("INTERNAL"),
  })
  .strict();

const commandCatalog = [
  {
    intent: "PROBE_CREATE",
    label: "Create test record",
    risk: "LOW",
    capability: "probe.create",
    action: "CREATE",
  },
  {
    intent: "PROBE_UPDATE",
    label: "Update test record",
    risk: "MEDIUM",
    capability: "probe.update",
    action: "UPDATE",
  },
  {
    intent: "GOVERNED_COMMENT_CREATE",
    label: "Add governed comment",
    risk: "LOW",
    capability: "governance.admin",
    action: "CREATE",
  },
  {
    intent: "IMPORT_PREVIEW",
    label: "Preview data import",
    risk: "MEDIUM",
    capability: "data.import.admin",
    action: "CREATE",
  },
  {
    intent: "IMPORT_COMMIT",
    label: "Commit data import",
    risk: "HIGH",
    capability: "data.import.admin",
    action: "CREATE",
    stepUp: true,
  },
  {
    intent: "DOCUMENT_UPLOAD",
    label: "Attach governed document",
    risk: "MEDIUM",
    capability: "governance.admin",
    action: "CREATE",
  },
  {
    intent: "CLIENT_CREATE",
    label: "Create client",
    risk: "MEDIUM",
    capability: "masters.admin",
    action: "CREATE",
  },
  {
    intent: "VENDOR_CREATE",
    label: "Create vendor",
    risk: "MEDIUM",
    capability: "masters.admin",
    action: "CREATE",
  },
  {
    intent: "RECORD_RECEIPT",
    label: "Record client receipt",
    risk: "HIGH",
    capability: "finance.admin",
    action: "CREATE",
    stepUp: true,
  },
  {
    intent: "OPERATIONS_STATUS_UPDATE",
    label: "Update operations status",
    risk: "MEDIUM",
    capability: "operations.admin",
    action: "UPDATE",
  },
  {
    intent: "FINANCE_STATUS_UPDATE",
    label: "Update finance status",
    risk: "HIGH",
    capability: "finance.admin",
    action: "UPDATE",
    stepUp: true,
  },
  {
    intent: "APPROVAL_DECIDE",
    label: "Decide approval",
    risk: "HIGH",
    capability: "governance.admin",
    action: "APPROVE",
    stepUp: true,
  },
  {
    intent: "REFERENCE_SEARCH",
    label: "Search permitted references",
    risk: "LOW",
    capability: "conversation.use",
    action: "READ",
    readOnly: true,
  },
  {
    intent: "STATUS_REPORT",
    label: "Show scoped status report",
    risk: "LOW",
    capability: "conversation.use",
    action: "READ",
    readOnly: true,
  },
  {
    intent: "OPERATIONAL_INSIGHT",
    label: "Show operational attention summary",
    risk: "LOW",
    capability: "conversation.use",
    action: "READ",
    readOnly: true,
  },
] as const;

@Injectable()
export class ConversationService {
  constructor(
    private readonly app: AppService,
    private readonly files: ConversationFileService,
    private readonly canonical: CanonicalService,
  ) {}

  catalog() {
    return {
      commands: commandCatalog.map(
        ({ capability: _capability, action: _action, ...command }) => ({
          ...command,
          channels: ["WEB", "WHATSAPP"],
          requiresConfirmation: !("readOnly" in command && command.readOnly),
        }),
      ),
      attachments: {
        maxFiles: 1,
        maxBytesEach: 5_000_000,
        acceptedMediaTypes: [
          "text/csv",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/pdf",
          "image/png",
          "image/jpeg",
        ],
      },
      whatsapp: { enabled: this.app.config.WHATSAPP_PROVIDER !== "disabled" },
    };
  }

  async catalogFor(actor: Actor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      return this.catalog();
    });
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

  private async capability(
    tx: Prisma.TransactionClient,
    actor: Actor,
    code: string,
    action: string,
    tenantWide = false,
  ) {
    if (!(await this.hasCapability(tx, actor, code, action, tenantWide)))
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  private async hasCapability(
    tx: Prisma.TransactionClient,
    actor: Actor,
    code: string,
    action: string,
    tenantWide = false,
  ) {
    const allowed = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 1 FROM app.membership_role_assignments a
       JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$4
       JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ($5,'ADMIN')
       JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE'
       WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND EXISTS(
         SELECT 1 FROM app.tenant_memberships m WHERE m.tenant_id=a.tenant_id AND m.id=a.membership_id AND m.user_id=$3::uuid AND m.status='ACTIVE')
       AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
       AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND ($6::boolean=false OR n.scope_type='TENANT') LIMIT 1`,
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
      code,
      action,
      tenantWide,
    );
    return allowed.length > 0;
  }

  private async conversationAccess(tx: Prisma.TransactionClient, actor: Actor) {
    await this.capability(tx, actor, "conversation.use", "READ");
  }

  async list(actor: Actor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,title,channel,created_at AS "createdAt",updated_at AS "updatedAt"
         FROM app.conversation_threads WHERE tenant_id=$1::uuid AND membership_id=$2::uuid ORDER BY updated_at DESC LIMIT 100`,
        tenant,
        actor.membershipId,
      );
      return { items, total: items.length };
    });
  }

  async create(actor: Actor, body: unknown, idempotencyKey: string) {
    const input = conversationThreadCreateSchema.parse(body),
      tenant = this.tenant(actor);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify(input));
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:${actor.userId}:conversation.create:${keyHash}`,
      );
      const prior = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,title,channel,created_at AS "createdAt",request_hash AS "requestHash" FROM app.conversation_threads WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND idempotency_key_hash=$3`,
          tenant,
          actor.userId,
          keyHash,
        )
      )[0];
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for different input",
          );
        return { ...prior, replayed: true };
      }
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.conversation_threads(tenant_id,membership_id,actor_id,channel,title,idempotency_key_hash,request_hash)
         VALUES($1::uuid,$2::uuid,$3::uuid,'WEB',$4,$5,$6) RETURNING id,title,channel,created_at AS "createdAt"`,
          tenant,
          actor.membershipId,
          actor.userId,
          input.title ?? "New conversation",
          keyHash,
          requestHash,
        )
      )[0]!;
    });
  }

  async detail(actor: Actor, threadId: string) {
    uuid.parse(threadId);
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      const thread = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,title,channel,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM app.conversation_threads
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND membership_id=$3::uuid`,
          tenant,
          threadId,
          actor.membershipId,
        )
      )[0];
      if (!thread)
        throw new AppError(404, "NOT_FOUND", "Conversation not found");
      const messages = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,direction,kind,text,created_at AS "createdAt" FROM app.conversation_messages WHERE tenant_id=$1::uuid AND thread_id=$2::uuid ORDER BY created_at,id`,
        tenant,
        threadId,
      );
      const proposals = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,intent,summary,arguments,state,risk,requires_step_up AS "requiresStepUp",version,created_at AS "createdAt",expires_at AS "expiresAt" FROM app.conversation_proposals WHERE tenant_id=$1::uuid AND thread_id=$2::uuid ORDER BY created_at`,
        tenant,
        threadId,
      );
      const attachments = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT a.id,a.message_id AS "messageId",a.filename,a.media_type AS "mediaType",a.byte_size AS "byteSize",a.checksum_sha256 AS "checksumSha256",a.scan_state AS "scanState",a.created_at AS "createdAt"
         FROM app.conversation_attachments a JOIN app.conversation_messages m ON m.tenant_id=a.tenant_id AND m.id=a.message_id WHERE a.tenant_id=$1::uuid AND m.thread_id=$2::uuid ORDER BY a.created_at`,
        tenant,
        threadId,
      );
      return { thread, messages, proposals, attachments };
    });
  }

  private proposalSchema(intent: ConversationIntent, args: unknown) {
    if (intent === "PROBE_CREATE") return probeCreate.parse(args);
    if (intent === "PROBE_UPDATE") return probeUpdate.parse(args);
    if (intent === "GOVERNED_COMMENT_CREATE") return commentCreate.parse(args);
    if (intent === "CLIENT_CREATE") return clientConversationSchema.parse(args);
    if (intent === "VENDOR_CREATE") return vendorConversationSchema.parse(args);
    if (intent === "RECORD_RECEIPT")
      return receiptConversationSchema.parse(args);
    if (
      intent === "OPERATIONS_STATUS_UPDATE" ||
      intent === "FINANCE_STATUS_UPDATE"
    )
      return statusConversationSchema.parse(args);
    if (intent === "APPROVAL_DECIDE")
      return approvalConversationSchema.parse(args);
    if (intent === "REFERENCE_SEARCH") return referenceSearchSchema.parse(args);
    if (intent === "STATUS_REPORT") return statusReportSchema.parse(args);
    if (intent === "OPERATIONAL_INSIGHT")
      return z.object({}).strict().parse(args);
    if (intent === "IMPORT_COMMIT")
      return z
        .object({
          attachmentId: uuid,
          jobId: uuid,
          expectedVersion: z.number().int().positive(),
        })
        .strict()
        .parse(args);
    if (intent === "DOCUMENT_UPLOAD")
      return z
        .object({
          attachmentId: uuid,
          targetType: z.string().min(2).max(80),
          targetId: uuid,
          category: z.string().min(2).max(80),
          confidentiality: z.enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"]),
          issueDate: z.string().date().optional(),
          expiryDate: z.string().date().optional(),
          documentId: uuid.optional(),
        })
        .strict()
        .parse(args);
    return z.object({ attachmentId: uuid }).strict().parse(args);
  }

  async submit(
    actor: Actor,
    threadId: string,
    body: unknown,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const input = conversationMessageCreateSchema.parse(body);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    return this.submitWithProvider(
      actor,
      threadId,
      input,
      correlationId,
      undefined,
      idempotencyKey,
    );
  }

  private async submitWithProvider(
    actor: Actor,
    threadId: string,
    input: z.infer<typeof conversationMessageCreateSchema>,
    correlationId: string,
    providerEventId?: string,
    idempotencyKey?: string,
    providerBodyHash?: string,
  ) {
    const tenant = this.tenant(actor);
    const normalizedThreadId = uuid.parse(threadId);
    const extraction = extractConfiguredConversationIntent(
      this.app.config.CONVERSATION_INTENT_PROVIDER,
      input.text,
    );
    const keyHash = idempotencyKey ? hash(idempotencyKey) : null;
    const requestHash = keyHash
      ? hash(JSON.stringify({ threadId: normalizedThreadId, input }))
      : null;
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      if (keyHash) {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `${tenant}:${actor.userId}:conversation.message:${keyHash}`,
        );
        const prior = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,direction,kind,text,created_at AS "createdAt",request_hash AS "requestHash" FROM app.conversation_messages WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND idempotency_key_hash=$3`,
            tenant,
            actor.userId,
            keyHash,
          )
        )[0];
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This key was used for different input",
            );
          const assistantMessage = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,direction,kind,text,created_at AS "createdAt" FROM app.conversation_messages WHERE tenant_id=$1::uuid AND in_reply_to_id=$2::uuid`,
              tenant,
              prior.id,
            )
          )[0];
          const proposal = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,intent,summary,arguments,state,risk,requires_step_up AS "requiresStepUp",version,created_at AS "createdAt",expires_at AS "expiresAt" FROM app.conversation_proposals WHERE tenant_id=$1::uuid AND source_message_id=$2::uuid`,
              tenant,
              prior.id,
            )
          )[0];
          return { message: prior, assistantMessage, proposal, replayed: true };
        }
      }
      const thread = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,channel FROM app.conversation_threads WHERE tenant_id=$1::uuid AND id=$2::uuid AND membership_id=$3::uuid AND state='OPEN'`,
          tenant,
          normalizedThreadId,
          actor.membershipId,
        )
      )[0];
      if (!thread)
        throw new AppError(404, "NOT_FOUND", "Conversation not found");
      const message = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.conversation_messages(tenant_id,thread_id,actor_id,direction,kind,text,provider_event_id,idempotency_key_hash,request_hash,correlation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,'INBOUND','USER',$4,$5,$6,$7,$8) RETURNING id,direction,kind,text,created_at AS "createdAt"`,
          tenant,
          threadId,
          actor.userId,
          input.text,
          providerEventId ?? null,
          keyHash,
          requestHash,
          correlationId,
        )
      )[0]!;
      const stored: Row[] = [];
      for (const attachment of input.attachments) {
        const prepared = this.files.validateAttachment(attachment);
        stored.push(
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.conversation_attachments(tenant_id,message_id,filename,media_type,byte_size,checksum_sha256,content,scan_state,dataset,import_metadata)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id,filename,media_type AS "mediaType",byte_size AS "byteSize",checksum_sha256 AS "checksumSha256",scan_state AS "scanState"`,
              tenant,
              message.id,
              prepared.filename,
              prepared.mediaType,
              prepared.byteSize,
              prepared.checksumSha256,
              prepared.content,
              prepared.scanState,
              prepared.dataset,
              JSON.stringify(prepared.importMetadata),
            )
          )[0]!,
        );
      }
      let proposal: Row | undefined;
      let assistantText =
        "I could not safely match that request to an available action. Please state the action and required record identifiers.";
      if (extraction.intent && extraction.missing.length === 0) {
        const command = commandCatalog.find(
          (item) => item.intent === extraction.intent,
        );
        if (!command) {
          assistantText =
            "That action is not available through conversation. Use the governed application workflow.";
        } else {
          const tenantWide =
            command.intent === "PROBE_CREATE" ||
            command.intent === "PROBE_UPDATE";
          if (
            !(await this.hasCapability(
              tx,
              actor,
              command.capability,
              command.action,
              tenantWide,
            ))
          ) {
            assistantText =
              "You do not have permission to perform that action in this conversation.";
          } else {
            let args: Record<string, unknown> = extraction.arguments;
            if (
              ["IMPORT_PREVIEW", "DOCUMENT_UPLOAD"].includes(extraction.intent)
            )
              args = { ...args, attachmentId: stored[0]?.id };
            try {
              const validated = this.proposalSchema(extraction.intent, args);
              if ("readOnly" in command && command.readOnly) {
                const result = await executeConversationRead(
                  tx,
                  actor,
                  extraction.intent,
                  validated,
                );
                assistantText = this.readResultText(command.label, result);
              } else {
                const prepared = await prepareConversationWrite(
                  tx,
                  actor,
                  extraction.intent,
                  validated,
                );
                proposal = (
                  await tx.$queryRawUnsafe<Array<Row>>(
                    `INSERT INTO app.conversation_proposals(tenant_id,thread_id,source_message_id,actor_id,membership_id,intent,arguments,summary,risk,requires_step_up)
             VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::jsonb,$8,$9,$10) RETURNING id,intent,summary,arguments,state,risk,requires_step_up AS "requiresStepUp",version,created_at AS "createdAt",expires_at AS "expiresAt"`,
                    tenant,
                    threadId,
                    message.id,
                    actor.userId,
                    actor.membershipId,
                    extraction.intent,
                    JSON.stringify(prepared),
                    command.label,
                    command.risk,
                    "stepUp" in command && command.stepUp,
                  )
                )[0]!;
                assistantText = `${command.label} is ready for review. Confirm to execute it or cancel it.`;
              }
            } catch (error) {
              if (
                error instanceof AppError &&
                ["REFERENCE_AMBIGUOUS", "REFERENCE_NOT_FOUND"].includes(
                  error.code,
                )
              )
                assistantText = `${error.message}. Use “find ${String(args.resource ?? "record")} <name or code>” to select the exact permitted record.`;
              else if (error instanceof z.ZodError)
                assistantText = `I need valid ${error.issues
                  .map((issue) => issue.path.join(".") || "input")
                  .join(", ")} before I can prepare that request.`;
              else throw error;
            }
          }
        }
      } else if (extraction.missing.length)
        assistantText = `I need ${extraction.missing.join(" and ")} before I can prepare that action.`;
      const assistantMessage = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.conversation_messages(tenant_id,thread_id,direction,kind,text,in_reply_to_id,correlation_id)
         VALUES($1::uuid,$2::uuid,'OUTBOUND','ASSISTANT',$3,$4::uuid,$5) RETURNING id,direction,kind,text,created_at AS "createdAt"`,
          tenant,
          threadId,
          assistantText,
          message.id,
          correlationId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `UPDATE app.conversation_threads SET updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        tenant,
        threadId,
      );
      if (providerEventId && providerBodyHash)
        await this.receipt(tx, providerEventId, providerBodyHash, "ACCEPTED");
      return { message, assistantMessage, proposal };
    });
  }

  private readResultText(label: string, result: unknown) {
    const body = JSON.stringify(result, null, 2);
    return `${label}\n${body.length > 6000 ? `${body.slice(0, 6000)}\n…` : body}`;
  }

  async cancel(
    actor: Actor,
    proposalId: string,
    expectedVersion: number,
    providerReceipt?: { eventId: string; bodyHash: string },
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      const proposal = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.conversation_proposals SET state='CANCELLED',cancelled_at=now(),updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND membership_id=$3::uuid AND state='PENDING' AND version=$4 AND expires_at>now()
         RETURNING id,intent,summary,state,risk,version`,
          tenant,
          uuid.parse(proposalId),
          actor.membershipId,
          expectedVersion,
        )
      )[0];
      if (!proposal)
        throw new AppError(
          409,
          "PROPOSAL_NOT_ACTIONABLE",
          "Proposal changed, expired, or is unavailable",
        );
      if (providerReceipt)
        await this.receipt(
          tx,
          providerReceipt.eventId,
          providerReceipt.bodyHash,
          "ACCEPTED",
        );
      return { proposal };
    });
  }

  async confirm(
    actor: Actor,
    proposalId: string,
    expectedVersion: number,
    idempotencyKey: string,
    correlationId: string,
    providerReceipt?: { eventId: string; bodyHash: string },
  ) {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const tenant = this.tenant(actor),
      keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify({ proposalId, expectedVersion }));
    const confirmation = withTenant(this.app.db, tenant, async (tx) => {
      await this.conversationAccess(tx, actor);
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:${actor.membershipId}:${keyHash}`,
      );
      const replay = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT e.id,e.state,e.result,e.request_hash AS "requestHash",e.created_at AS "createdAt",p.id AS "proposalId",p.state AS "proposalState",p.version
         FROM app.conversation_executions e JOIN app.conversation_proposals p ON p.tenant_id=e.tenant_id AND p.id=e.proposal_id
         WHERE e.tenant_id=$1::uuid AND e.membership_id=$2::uuid AND e.idempotency_key_hash=$3`,
          tenant,
          actor.membershipId,
          keyHash,
        )
      )[0];
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for a different proposal or request",
          );
        await this.recordConfirmationAttempt(
          tx,
          actor,
          proposalId,
          keyHash,
          requestHash,
          "SUCCEEDED",
          correlationId,
        );
        if (providerReceipt)
          await this.receipt(
            tx,
            providerReceipt.eventId,
            providerReceipt.bodyHash,
            "ACCEPTED",
          );
        return {
          replayed: true,
          proposal: {
            id: replay.proposalId,
            state: replay.proposalState,
            version: replay.version,
          },
          execution: replay,
        };
      }
      const proposal = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT p.*,t.channel FROM app.conversation_proposals p JOIN app.conversation_threads t ON t.tenant_id=p.tenant_id AND t.id=p.thread_id
         WHERE p.tenant_id=$1::uuid AND p.id=$2::uuid AND p.membership_id=$3::uuid FOR UPDATE`,
          tenant,
          uuid.parse(proposalId),
          actor.membershipId,
        )
      )[0];
      if (
        !proposal ||
        proposal.state !== "PENDING" ||
        Number(proposal.version) !== expectedVersion ||
        new Date(String(proposal.expires_at)) <= new Date()
      )
        throw new AppError(
          409,
          "PROPOSAL_NOT_ACTIONABLE",
          "Proposal changed, expired, or is unavailable",
        );
      if (proposal.requires_step_up && actor.assuranceLevel !== "MFA")
        throw new AppError(
          403,
          "IN_APP_STEP_UP_REQUIRED",
          "This action requires a current multi-factor authenticated session",
        );
      const command = commandCatalog.find(
        (item) => item.intent === proposal.intent,
      );
      if (!command)
        throw new AppError(
          400,
          "INTENT_UNSUPPORTED",
          "Action is not supported",
        );
      await this.capability(
        tx,
        actor,
        command.capability,
        command.action,
        command.intent === "PROBE_CREATE" || command.intent === "PROBE_UPDATE",
      );
      const result = await this.execute(
        tx,
        actor,
        proposal.intent as ConversationIntent,
        proposal.arguments as Record<string, unknown>,
        correlationId,
        proposalId,
      );
      const execution = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.conversation_executions(tenant_id,proposal_id,actor_id,membership_id,idempotency_key_hash,request_hash,state,result,correlation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'SUCCEEDED',$7::jsonb,$8) RETURNING id,state,result,created_at AS "createdAt"`,
          tenant,
          proposalId,
          actor.userId,
          actor.membershipId,
          keyHash,
          requestHash,
          JSON.stringify(result),
          correlationId,
        )
      )[0]!;
      const updated = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.conversation_proposals SET state='EXECUTED',confirmed_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,intent,summary,state,risk,version`,
          tenant,
          proposalId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'conversation.command.executed','conversation_proposal',$3::uuid,$4,$5::jsonb)`,
        tenant,
        actor.userId,
        proposalId,
        correlationId,
        JSON.stringify({ intent: proposal.intent, executionId: execution.id }),
      );
      await this.recordConfirmationAttempt(
        tx,
        actor,
        proposalId,
        keyHash,
        requestHash,
        "SUCCEEDED",
        correlationId,
      );
      if (providerReceipt)
        await this.receipt(
          tx,
          providerReceipt.eventId,
          providerReceipt.bodyHash,
          "ACCEPTED",
        );
      return { proposal: updated, execution };
    });
    return confirmation.catch(async (error: unknown) => {
      const outcome =
        error instanceof AppError && error.status < 500 ? "DENIED" : "FAILED";
      const errorCode =
        error instanceof AppError ? error.code : "INTERNAL_ERROR";
      await withTenant(this.app.db, tenant, (tx) =>
        this.recordConfirmationAttempt(
          tx,
          actor,
          null,
          keyHash,
          requestHash,
          outcome,
          correlationId,
          errorCode,
        ),
      ).catch(() => undefined);
      throw error;
    });
  }

  private async recordConfirmationAttempt(
    tx: Prisma.TransactionClient,
    actor: Actor,
    proposalId: string | null,
    keyHash: string,
    requestHash: string,
    outcome: "SUCCEEDED" | "DENIED" | "FAILED",
    correlationId: string,
    errorCode?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.conversation_confirmation_attempts
       (tenant_id,proposal_id,actor_id,membership_id,idempotency_key_hash,request_hash,outcome,error_code,correlation_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9)`,
      this.tenant(actor),
      proposalId,
      actor.userId,
      actor.membershipId,
      keyHash,
      requestHash,
      outcome,
      errorCode ?? null,
      correlationId,
    );
  }

  private async execute(
    tx: Prisma.TransactionClient,
    actor: Actor,
    intent: ConversationIntent,
    raw: Record<string, unknown>,
    correlationId: string,
    proposalId: string,
  ) {
    const tenant = this.tenant(actor);
    if (intent === "PROBE_CREATE") {
      const input = probeCreate.parse(raw);
      return this.app.createProbeInTransaction(
        tx,
        actor,
        input.label,
        input.note,
        correlationId,
        `conversation:${proposalId}`,
      );
    }
    if (intent === "PROBE_UPDATE") {
      const input = probeUpdate.parse(raw);
      return this.app.updateProbeInTransaction(
        tx,
        actor,
        input.id,
        input,
        correlationId,
      );
    }
    if (intent === "GOVERNED_COMMENT_CREATE") {
      const input = commentCreate.parse(raw);
      const resources = {
        indent: "indents",
        allocation: "allocations",
        trip: "trips",
        pod: "pod-tasks",
        invoice: "invoices",
        vendor_bill: "vendor-bills",
      } as const;
      const authorized = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'governance.admin','CREATE',$4,$5::uuid) AS allowed`,
          tenant,
          actor.membershipId,
          actor.userId,
          resources[input.targetType],
          input.targetId,
        )
      )[0];
      if (!(authorized?.allowed === true || authorized?.allowed === "true"))
        throw new AppError(
          404,
          "RESOURCE_NOT_FOUND",
          "Comment target is unavailable",
        );
      const membership = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT portal_audience AS audience FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid AND user_id=$3::uuid AND status='ACTIVE'`,
          tenant,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (
        membership?.audience !== "INTERNAL" &&
        input.visibility !== membership?.audience
      )
        throw new AppError(
          403,
          "VISIBILITY_DENIED",
          "External comments may only use their own audience",
        );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.governed_comments(tenant_id,target_type,target_id,body,visibility,author_id) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::uuid) RETURNING id,target_type AS "targetType",target_id AS "targetId",body,visibility,version`,
          tenant,
          input.targetType.toUpperCase(),
          input.targetId,
          input.body,
          input.visibility,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.governed_comment_history(tenant_id,comment_id,version,body,edited_by) VALUES($1::uuid,$2::uuid,1,$3,$4::uuid)`,
        tenant,
        row.id,
        input.body,
        actor.userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'comment.created','comment',$3::uuid,$4,$5::jsonb)`,
        tenant,
        actor.userId,
        row.id,
        correlationId,
        JSON.stringify(row),
      );
      return row;
    }
    if (intent === "IMPORT_PREVIEW") {
      const input = z.object({ attachmentId: uuid }).parse(raw);
      return this.files.previewImportInTransaction(tx, actor, {
        attachmentId: input.attachmentId,
        idempotencyKey: `conversation:${proposalId}`,
        correlationId,
      });
    }
    if (intent === "IMPORT_COMMIT") {
      const input = z
        .object({
          attachmentId: uuid,
          jobId: uuid,
          expectedVersion: z.number().int().positive(),
        })
        .parse(raw);
      return this.files.commitImportInTransaction(tx, actor, {
        ...input,
        idempotencyKey: `conversation:${proposalId}`,
        correlationId,
      });
    }
    if (intent === "DOCUMENT_UPLOAD") {
      const input = z
        .object({
          attachmentId: uuid,
          targetType: z.enum([
            "ORGANIZATION_NODE",
            "EMPLOYEE",
            "CLIENT",
            "VENDOR",
            "VEHICLE",
            "DRIVER",
            "INDENT",
            "ALLOCATION",
            "TRIP",
            "POD",
            "INVOICE",
            "RECEIPT",
            "VENDOR_BILL",
          ]),
          targetId: uuid,
          category: z.string(),
          confidentiality: z.enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"]),
          issueDate: z.string().date().optional(),
          expiryDate: z.string().date().optional(),
          documentId: uuid.optional(),
        })
        .parse(raw);
      return this.files.createGovernedDocumentInTransaction(tx, actor, {
        ...input,
        idempotencyKey: `conversation:${proposalId}`,
        correlationId,
      });
    }
    const idempotencyKey = `conversation:${proposalId}`;
    if (intent === "CLIENT_CREATE") {
      const input = clientConversationSchema.parse(raw);
      return this.canonical.createInTransaction(
        tx,
        actor,
        "clients",
        {
          code: input.code,
          legalName: input.legalName,
          billingEntityId: input.billingEntity,
          industry: input.industry,
          creditDays: input.creditDays,
          podMode: input.podMode,
          taxIdentifier: input.taxIdentifier,
          escalationEmail: input.escalationEmail,
          escalationMobile: input.escalationMobile,
        },
        idempotencyKey,
        correlationId,
      );
    }
    if (intent === "VENDOR_CREATE")
      return this.canonical.createInTransaction(
        tx,
        actor,
        "vendors",
        vendorConversationSchema.parse(raw),
        idempotencyKey,
        correlationId,
      );
    if (intent === "RECORD_RECEIPT") {
      const input = receiptConversationSchema.parse(raw);
      return this.canonical.createInTransaction(
        tx,
        actor,
        "receipts",
        {
          receiptRef: input.receiptRef,
          clientId: input.client,
          paymentDate: input.paymentDate,
          amountMinor: input.amountMinor,
          mode: input.mode,
          instrumentNo: input.instrumentNo ?? `CONV-${proposalId}`,
          bankReference: input.bankReference,
        },
        idempotencyKey,
        correlationId,
      );
    }
    if (
      intent === "OPERATIONS_STATUS_UPDATE" ||
      intent === "FINANCE_STATUS_UPDATE"
    ) {
      const input = statusConversationSchema.parse(raw);
      if (input.toState === "REVERSED")
        throw new AppError(
          409,
          "COMPENSATING_ENTRY_REQUIRED",
          "Financial reversals require the dedicated compensating-entry workflow",
        );
      const resources = {
        indent: "indents",
        allocation: "allocations",
        trip: "trips",
        pod: "pod-tasks",
        invoice: "invoices",
        receipt: "receipts",
        vendor_bill: "vendor-bills",
      } as const;
      return this.canonical.transition(
        actor,
        resources[input.resource],
        input.targetRef,
        {
          expectedVersion: input.expectedVersion,
          toState: input.toState,
          reason: input.reason,
        },
        idempotencyKey,
        correlationId,
        tx,
      );
    }
    if (intent === "APPROVAL_DECIDE") {
      const input = approvalConversationSchema
        .extend({ roleId: uuid })
        .parse(raw);
      return this.canonical.decideApproval(
        actor,
        input.instanceRef,
        {
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          roleId: input.roleId,
          comment: input.comment,
        },
        idempotencyKey,
        correlationId,
        tx,
      );
    }
    throw new AppError(400, "INTENT_UNSUPPORTED", "Action is not supported");
  }

  async createWhatsappChallenge(actor: Actor) {
    if (this.app.config.WHATSAPP_PROVIDER === "disabled")
      throw new AppError(
        409,
        "WHATSAPP_DISABLED",
        "WhatsApp integration is not enabled",
      );
    const tenant = this.tenant(actor),
      code = randomBytes(6).toString("base64url").toUpperCase();
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "conversation.admin", "ADMIN");
      await tx.$executeRawUnsafe(
        `UPDATE app.whatsapp_link_challenges SET consumed_at=now() WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND consumed_at IS NULL`,
        tenant,
        actor.membershipId,
      );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.whatsapp_link_challenges(tenant_id,membership_id,actor_id,code_hash,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,now()+interval '10 minutes') RETURNING id,expires_at AS "expiresAt"`,
          tenant,
          actor.membershipId,
          actor.userId,
          hash(`${tenant}:${actor.membershipId}:${code}`),
        )
      )[0]!;
      return {
        ...row,
        code,
        instruction: `Send LINK ${code} from the WhatsApp number you want to bind.`,
      };
    });
  }

  async acceptWhatsapp(
    providerEventId: string,
    mobileE164: string,
    text: string,
    bodyHash: string,
    correlationId: string,
    attachments: ConversationInboundAttachment[] = [],
  ) {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta")
      throw new AppError(
        404,
        "WHATSAPP_DISABLED",
        "WhatsApp integration is not enabled",
      );
    const linkCode = text
      .match(/^LINK\s+([A-Z0-9_-]{8,32})$/i)?.[1]
      ?.toUpperCase();
    if (linkCode)
      return withPlatform(this.app.db, async (tx) => {
        const challenges = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT * FROM app.whatsapp_link_challenges WHERE consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        );
        const challenge = challenges.find(
          (item) =>
            item.code_hash ===
            hash(`${item.tenant_id}:${item.membership_id}:${linkCode}`),
        );
        if (!challenge)
          throw new AppError(
            400,
            "LINK_CODE_INVALID",
            "Link code is invalid or expired",
          );
        const addressHash = this.addressHash(mobileE164),
          encrypted = this.encryptAddress(mobileE164);
        await tx.$executeRawUnsafe(
          `UPDATE app.whatsapp_bindings SET state='REVOKED',revoked_at=now()
           WHERE tenant_id=$1::uuid AND state='ACTIVE' AND (address_hash=$2 OR membership_id=$3::uuid)`,
          challenge.tenant_id,
          addressHash,
          challenge.membership_id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.whatsapp_bindings(tenant_id,membership_id,actor_id,address_hash,address_ciphertext,address_last4,provider) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'meta')`,
          challenge.tenant_id,
          challenge.membership_id,
          challenge.actor_id,
          addressHash,
          encrypted,
          mobileE164.slice(-4),
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.whatsapp_link_challenges SET consumed_at=now() WHERE id=$1::uuid`,
          challenge.id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'conversation.whatsapp.linked','whatsapp_binding',$3,$4::jsonb)`,
          challenge.tenant_id,
          challenge.actor_id,
          correlationId,
          JSON.stringify({
            provider: "meta",
            addressLast4: mobileE164.slice(-4),
          }),
        );
        await this.receipt(tx, providerEventId, bodyHash, "ACCEPTED");
        return { accepted: true, linked: true };
      });
    const addressHash = this.addressHash(mobileE164);
    const bindings = await withPlatform(this.app.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.*,m.status AS membership_status,u.email FROM app.whatsapp_bindings b JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.id=b.membership_id JOIN app.users u ON u.id=b.actor_id WHERE b.provider='meta' AND b.address_hash=$1 AND b.state='ACTIVE' AND m.status='ACTIVE'`,
        addressHash,
      ),
    );
    if (bindings.length !== 1) {
      await withPlatform(this.app.db, (tx) =>
        this.receipt(
          tx,
          providerEventId,
          bodyHash,
          bindings.length ? "AMBIGUOUS" : "UNBOUND",
        ),
      );
      throw new AppError(
        403,
        bindings.length ? "WHATSAPP_TENANT_AMBIGUOUS" : "WHATSAPP_NOT_LINKED",
        "WhatsApp identity is not uniquely linked",
      );
    }
    const binding = bindings[0]!;
    const actor: Actor = {
      userId: String(binding.actor_id),
      email: String(binding.email ?? ""),
      platformAdmin: false,
      activeTenantId: String(binding.tenant_id),
      membershipId: String(binding.membership_id),
      contextVersion: 1,
      csrfToken: "",
    };
    let thread = await withTenant(
      this.app.db,
      String(binding.tenant_id),
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.conversation_threads WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND channel='WHATSAPP' AND state='OPEN' ORDER BY updated_at DESC LIMIT 1`,
            binding.tenant_id,
            binding.membership_id,
          )
        )[0],
    );
    if (!thread)
      thread = await withTenant(
        this.app.db,
        String(binding.tenant_id),
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.conversation_threads(tenant_id,membership_id,actor_id,channel,title) VALUES($1::uuid,$2::uuid,$3::uuid,'WHATSAPP','WhatsApp conversation') RETURNING id`,
              binding.tenant_id,
              binding.membership_id,
              binding.actor_id,
            )
          )[0]!,
      );
    const response = await this.submitWithProvider(
      actor,
      String(thread.id),
      conversationMessageCreateSchema.parse({ text, attachments }),
      correlationId,
      providerEventId,
      undefined,
      bodyHash,
    );
    return { accepted: true, response };
  }

  async actOnWhatsappProposal(
    providerEventId: string,
    mobileE164: string,
    action: "CONFIRM" | "CANCEL",
    proposalId: string | undefined,
    bodyHash: string,
    correlationId: string,
  ) {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta")
      throw new AppError(
        404,
        "WHATSAPP_DISABLED",
        "WhatsApp integration is not enabled",
      );
    const bindings = await withPlatform(this.app.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.tenant_id,b.membership_id,b.actor_id,u.email FROM app.whatsapp_bindings b
         JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.id=b.membership_id AND m.status='ACTIVE'
         JOIN app.users u ON u.id=b.actor_id
         WHERE b.provider='meta' AND b.address_hash=$1 AND b.state='ACTIVE'`,
        this.addressHash(mobileE164),
      ),
    );
    if (bindings.length !== 1)
      throw new AppError(
        403,
        bindings.length ? "WHATSAPP_TENANT_AMBIGUOUS" : "WHATSAPP_NOT_LINKED",
        "WhatsApp identity is not uniquely linked",
      );
    const binding = bindings[0]!;
    const actor: Actor = {
      userId: String(binding.actor_id),
      email: String(binding.email ?? ""),
      platformAdmin: false,
      activeTenantId: String(binding.tenant_id),
      membershipId: String(binding.membership_id),
      contextVersion: 1,
      csrfToken: "",
    };
    const proposal = await withTenant(
      this.app.db,
      String(binding.tenant_id),
      async (tx) => {
        await this.conversationAccess(tx, actor);
        const rows = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT p.id,p.version,p.risk,p.requires_step_up AS "requiresStepUp",p.state,p.expires_at AS "expiresAt"
         FROM app.conversation_proposals p JOIN app.conversation_threads t ON t.tenant_id=p.tenant_id AND t.id=p.thread_id
         WHERE p.tenant_id=$1::uuid AND p.membership_id=$2::uuid AND p.actor_id=$3::uuid AND t.channel='WHATSAPP'
           AND p.state='PENDING' AND p.expires_at>now() AND ($4::uuid IS NULL OR p.id=$4::uuid)
         ORDER BY p.created_at DESC LIMIT 2`,
          binding.tenant_id,
          binding.membership_id,
          binding.actor_id,
          proposalId ? uuid.parse(proposalId) : null,
        );
        if (!rows.length)
          throw new AppError(
            404,
            "PROPOSAL_NOT_FOUND",
            "No pending WhatsApp proposal matches",
          );
        if (!proposalId && rows.length > 1)
          throw new AppError(
            409,
            "PROPOSAL_AMBIGUOUS",
            "Reply with the proposal ID to choose one pending action",
          );
        return rows[0]!;
      },
    );
    if (proposal.risk === "HIGH" || proposal.requiresStepUp === true)
      throw new AppError(
        403,
        "IN_APP_STEP_UP_REQUIRED",
        "High-risk actions must be confirmed in the authenticated application",
      );
    const result =
      action === "CONFIRM"
        ? await this.confirm(
            actor,
            String(proposal.id),
            Number(proposal.version),
            `whatsapp:${providerEventId}`,
            correlationId,
            { eventId: providerEventId, bodyHash },
          )
        : await this.cancel(
            actor,
            String(proposal.id),
            Number(proposal.version),
            { eventId: providerEventId, bodyHash },
          );
    return { accepted: true, action, result };
  }

  private receipt(
    tx: Prisma.TransactionClient,
    eventId: string,
    bodyHash: string,
    disposition: string,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO app.conversation_provider_receipts(provider,provider_event_id,body_sha256,signature_verified,disposition) VALUES('meta',$1,$2,true,$3) ON CONFLICT(provider,provider_event_id) DO NOTHING`,
      eventId,
      bodyHash,
      disposition,
    );
  }

  async providerEventReceived(eventId: string) {
    return withPlatform(this.app.db, async (tx) =>
      Boolean(
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT 1 FROM app.conversation_provider_receipts WHERE provider='meta' AND provider_event_id=$1`,
            eventId,
          )
        )[0],
      ),
    );
  }

  private addressHash(mobileE164: string) {
    return createHmac("sha256", this.app.config.WHATSAPP_ADDRESS_PEPPER)
      .update(mobileE164)
      .digest("hex");
  }

  private encryptAddress(mobileE164: string) {
    const key = Buffer.from(
        this.app.config.WHATSAPP_ADDRESS_ENCRYPTION_KEY,
        "base64",
      ),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(mobileE164, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
  }
}
