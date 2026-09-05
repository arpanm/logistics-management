import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { SessionActor } from "@logistics/auth";
import { withPlatform, withTenant, type Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { ConversationService } from "./conversation.service.js";
import {
  MetaWhatsappAdapter,
  type DownloadedWhatsappAttachment,
  type MetaInboundMedia,
} from "./conversation-whatsapp.adapter.js";

type Row = Record<string, unknown>;
type Actor = SessionActor & { membershipId?: string | null };

export type WhatsappInboundMessage = {
  id: string;
  from: string;
  text: string;
  media?: MetaInboundMedia;
};

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

@Injectable()
export class ConversationWhatsappService {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(ConversationService)
    private readonly conversation: ConversationService,
    @Inject(MetaWhatsappAdapter)
    private readonly adapter: MetaWhatsappAdapter,
  ) {}

  verifySignature(raw: Buffer, supplied: string): boolean {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta") return false;
    const expected = `sha256=${createHmac(
      "sha256",
      this.app.config.WHATSAPP_APP_SECRET,
    )
      .update(raw)
      .digest("hex")}`;
    return (
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    );
  }

  verifyToken(supplied: string): boolean {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta") return false;
    const expected = this.app.config.WHATSAPP_VERIFY_TOKEN;
    return (
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    );
  }

  async receive(
    message: WhatsappInboundMessage,
    _rawBody: Buffer,
    correlationId: string,
  ) {
    // The raw envelope is used only for the signature check in the controller.
    // Meta may redeliver the same message in a differently grouped webhook, so
    // deduplication must bind to the stable individual message instead.
    const bodyHash = digest(
      JSON.stringify({
        id: message.id,
        from: message.from,
        text: message.text,
        media: message.media
          ? {
              id: message.media.id,
              filename: message.media.filename ?? null,
              mediaType: message.media.mediaType ?? null,
              caption: message.media.caption ?? null,
            }
          : null,
      }),
    );
    const claim = await this.claimProviderEvent(message.id, bodyHash);
    if (!claim) return { accepted: true, duplicate: true };
    const mobile = message.from.startsWith("+")
      ? message.from
      : `+${message.from}`;
    try {
      if (await this.conversation.providerEventReceived(message.id)) {
        await this.recoverProviderReply(
          claim,
          mobile,
          message.id,
          message.text,
        );
        await this.completeProviderEvent(claim, "ACCEPTED");
        return { accepted: true, duplicate: true };
      }
      let result: unknown;
      const proposalAction = message.text.match(
        /^\s*(CONFIRM|CANCEL)(?:\s+([0-9a-f-]{36}))?\s*$/i,
      );
      if (proposalAction) {
        result = await this.conversation.actOnWhatsappProposal(
          message.id,
          mobile,
          proposalAction[1]!.toUpperCase() as "CONFIRM" | "CANCEL",
          proposalAction[2],
          bodyHash,
          correlationId,
        );
      } else {
        const optIn = /^\s*START ALERTS\s*$/i.test(message.text);
        const optOut = /^\s*(STOP|UNSUBSCRIBE|STOP ALERTS)\s*$/i.test(
          message.text,
        );
        if (optIn || optOut) {
          await this.setConsentByMobile(
            mobile,
            optIn,
            message.id,
            bodyHash,
            correlationId,
          );
          result = {
            response: {
              assistantMessage: {
                text: optIn
                  ? "Proactive WhatsApp alerts are enabled. Quiet hours configured in the app still apply."
                  : "Proactive WhatsApp alerts are disabled.",
              },
            },
          };
        } else {
          const attachments: DownloadedWhatsappAttachment[] = message.media
            ? [await this.adapter.downloadMedia(message.media)]
            : [];
          result = await this.conversation.acceptWhatsapp(
            message.id,
            mobile,
            message.text,
            bodyHash,
            correlationId,
            attachments,
          );
        }
      }
      const reply = this.replyText(result);
      await this.persistAndQueueProviderReply(claim, mobile, message.id, reply);
      await this.completeProviderEvent(claim, "ACCEPTED");
      return { accepted: true };
    } catch (error) {
      const retryable = !(error instanceof AppError) || error.status >= 500;
      if (retryable)
        await this.retryProviderEvent(
          claim,
          error instanceof AppError ? error.code : "PROVIDER_EVENT_FAILED",
        );
      else
        await this.completeProviderEvent(
          claim,
          this.providerDisposition(error),
          error.code,
        );
      throw error;
    }
  }

  private async claimProviderEvent(providerEventId: string, bodyHash: string) {
    const leaseTokenHash = digest(randomBytes(32));
    return withPlatform(this.app.db, async (tx) => {
      const inserted = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.conversation_provider_event_claims(provider,provider_event_id,body_sha256,state,lease_token_hash,lease_expires_at)
           VALUES('meta',$1,$2,'PROCESSING',$3,now()+interval '2 minutes')
           ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id,attempts`,
          providerEventId,
          bodyHash,
          leaseTokenHash,
        )
      )[0];
      if (inserted) {
        await tx.$executeRawUnsafe(
          `INSERT INTO app.conversation_provider_event_claim_attempts(claim_id,attempt_no,outcome)
           VALUES($1::uuid,$2,'CLAIMED')`,
          inserted.id,
          inserted.attempts,
        );
        return { id: String(inserted.id), leaseTokenHash };
      }
      const current = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,body_sha256,state,attempts,lease_expires_at
           FROM app.conversation_provider_event_claims
           WHERE provider='meta' AND provider_event_id=$1 FOR UPDATE`,
          providerEventId,
        )
      )[0]!;
      if (current.body_sha256 !== bodyHash)
        throw new AppError(
          409,
          "PROVIDER_EVENT_BODY_CONFLICT",
          "Provider event identifier was reused with different content",
        );
      if (
        current.state === "COMPLETED" ||
        (current.state === "PROCESSING" &&
          new Date(String(current.lease_expires_at)) > new Date())
      )
        return null;
      const attempt = Number(current.attempts) + 1;
      await tx.$executeRawUnsafe(
        `UPDATE app.conversation_provider_event_claims
         SET state='PROCESSING',attempts=$1,lease_token_hash=$2,lease_expires_at=now()+interval '2 minutes',safe_error_code=null,updated_at=now()
         WHERE id=$3::uuid`,
        attempt,
        leaseTokenHash,
        current.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.conversation_provider_event_claim_attempts(claim_id,attempt_no,outcome)
         VALUES($1::uuid,$2,'CLAIMED')`,
        current.id,
        attempt,
      );
      return { id: String(current.id), leaseTokenHash };
    });
  }

  private async completeProviderEvent(
    claim: { id: string; leaseTokenHash: string },
    disposition: "ACCEPTED" | "UNBOUND" | "AMBIGUOUS" | "INVALID",
    safeErrorCode?: string,
  ) {
    return withPlatform(this.app.db, async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.conversation_provider_event_claims
           SET state='COMPLETED',disposition=$1,safe_error_code=$2,lease_token_hash=null,lease_expires_at=null,completed_at=now(),updated_at=now()
           WHERE id=$3::uuid AND state='PROCESSING' AND lease_token_hash=$4 RETURNING attempts`,
          disposition,
          safeErrorCode ?? null,
          claim.id,
          claim.leaseTokenHash,
        )
      )[0];
      if (row)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.conversation_provider_event_claim_attempts(claim_id,attempt_no,outcome,safe_error_code)
           VALUES($1::uuid,$2,'COMPLETED',$3)`,
          claim.id,
          row.attempts,
          safeErrorCode ?? null,
        );
    });
  }

  private async retryProviderEvent(
    claim: { id: string; leaseTokenHash: string },
    safeErrorCode: string,
  ) {
    return withPlatform(this.app.db, async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.conversation_provider_event_claims
           SET state='RETRY',safe_error_code=$1,lease_token_hash=null,lease_expires_at=null,updated_at=now()
           WHERE id=$2::uuid AND state='PROCESSING' AND lease_token_hash=$3 RETURNING attempts`,
          safeErrorCode,
          claim.id,
          claim.leaseTokenHash,
        )
      )[0];
      if (row)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.conversation_provider_event_claim_attempts(claim_id,attempt_no,outcome,safe_error_code)
           VALUES($1::uuid,$2,'RETRY',$3)`,
          claim.id,
          row.attempts,
          safeErrorCode,
        );
    });
  }

  private providerDisposition(error: AppError) {
    if (error.code === "WHATSAPP_NOT_LINKED") return "UNBOUND" as const;
    if (error.code === "WHATSAPP_TENANT_AMBIGUOUS") return "AMBIGUOUS" as const;
    return "INVALID" as const;
  }

  private async persistAndQueueProviderReply(
    claim: { id: string; leaseTokenHash: string },
    mobile: string,
    providerEventId: string,
    reply: string,
  ) {
    const ciphertext = this.encryptPayload(reply);
    await withPlatform(this.app.db, async (tx) => {
      const bindings = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.tenant_id,b.membership_id FROM app.whatsapp_bindings b
         JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.id=b.membership_id
         WHERE b.provider='meta' AND b.address_hash=$1 AND b.state='ACTIVE' AND m.status='ACTIVE'`,
        this.addressHash(mobile),
      );
      if (bindings.length !== 1)
        throw new AppError(
          409,
          bindings.length ? "WHATSAPP_TENANT_AMBIGUOUS" : "WHATSAPP_NOT_LINKED",
          "WhatsApp identity is not uniquely linked",
        );
      const binding = bindings[0]!;
      await tx.$executeRawUnsafe(
        `UPDATE app.conversation_provider_event_claims SET reply_ciphertext=$1,updated_at=now()
         WHERE id=$2::uuid AND state='PROCESSING' AND lease_token_hash=$3`,
        ciphertext,
        claim.id,
        claim.leaseTokenHash,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.conversation_channel_deliveries(tenant_id,membership_id,category,rendered_body,deduplication_key)
         VALUES($1::uuid,$2::uuid,'TRANSACTIONAL',$3,$4)
         ON CONFLICT(tenant_id,deduplication_key) DO NOTHING`,
        binding.tenant_id,
        binding.membership_id,
        reply,
        `whatsapp-reply:${providerEventId}`,
      );
    });
  }

  private async recoverProviderReply(
    claim: { id: string; leaseTokenHash: string },
    mobile: string,
    providerEventId: string,
    inboundText: string,
  ) {
    const evidence = await withPlatform(this.app.db, async (tx) => {
      const stored = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT reply_ciphertext FROM app.conversation_provider_event_claims WHERE id=$1::uuid`,
          claim.id,
        )
      )[0];
      if (stored?.reply_ciphertext)
        return this.decryptPayload(
          Buffer.from(stored.reply_ciphertext as Uint8Array),
        );
      const conversational = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT reply.text FROM app.conversation_messages inbound
           JOIN app.conversation_messages reply ON reply.tenant_id=inbound.tenant_id AND reply.in_reply_to_id=inbound.id
           WHERE inbound.provider_event_id=$1 ORDER BY reply.created_at DESC LIMIT 1`,
          providerEventId,
        )
      )[0];
      if (typeof conversational?.text === "string") return conversational.text;
      const execution = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT 1 FROM app.conversation_executions WHERE idempotency_key_hash=$1 LIMIT 1`,
          digest(`whatsapp:${providerEventId}`),
        )
      )[0];
      if (execution) return "The requested action was completed.";
      if (/^\s*(CONFIRM|CANCEL)(?:\s|$)/i.test(inboundText))
        return "The requested proposal action was processed.";
      if (/^\s*LINK\s+/i.test(inboundText))
        return "WhatsApp is linked. Send a supported request in English. Reply START ALERTS to opt in to proactive alerts.";
      if (/^\s*START ALERTS\s*$/i.test(inboundText))
        return "Proactive WhatsApp alerts are enabled. Quiet hours configured in the app still apply.";
      if (/^\s*(STOP|UNSUBSCRIBE|STOP ALERTS)\s*$/i.test(inboundText))
        return "Proactive WhatsApp alerts are disabled.";
      return null;
    });
    if (evidence) await this.queueReply(mobile, providerEventId, evidence);
  }

  private encryptPayload(value: string) {
    const key = Buffer.from(
      this.app.config.WHATSAPP_ADDRESS_ENCRYPTION_KEY,
      "base64",
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
  }

  private decryptPayload(envelope: Buffer) {
    if (envelope.length < 30 || envelope[0] !== 1)
      throw new AppError(
        500,
        "PROVIDER_REPLY_INVALID",
        "Provider reply is unavailable",
      );
    const key = Buffer.from(
      this.app.config.WHATSAPP_ADDRESS_ENCRYPTION_KEY,
      "base64",
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      envelope.subarray(1, 13),
    );
    decipher.setAuthTag(envelope.subarray(13, 29));
    return Buffer.concat([
      decipher.update(envelope.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  }

  async preference(actor: Actor) {
    const { tenantId, membershipId } = await this.assertMember(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const preference = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT proactive_state AS "proactiveState",quiet_start AS "quietStart",quiet_end AS "quietEnd",consented_at AS "consentedAt",unsubscribed_at AS "unsubscribedAt",version
           FROM app.whatsapp_channel_preferences WHERE tenant_id=$1::uuid AND membership_id=$2::uuid`,
          tenantId,
          membershipId,
        )
      )[0];
      return (
        preference ?? {
          proactiveState: "OPTED_OUT",
          quietStart: null,
          quietEnd: null,
          version: 0,
        }
      );
    });
  }

  async status(actor: Actor) {
    const { tenantId, membershipId } = await this.assertMember(actor);
    const [binding, preference] = await Promise.all([
      withTenant(
        this.app.db,
        tenantId,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT linked_at AS "linkedAt",address_last4 AS "addressLast4"
             FROM app.whatsapp_bindings WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND provider='meta' AND state='ACTIVE'
             ORDER BY linked_at DESC LIMIT 1`,
              tenantId,
              membershipId,
            )
          )[0] ?? null,
      ),
      this.preference(actor),
    ]);
    return {
      enabled: this.app.config.WHATSAPP_PROVIDER === "meta",
      binding,
      preference,
    };
  }

  async unlink(actor: Actor, correlationId: string, idempotencyKey: string) {
    const { tenantId, membershipId } = await this.assertMember(actor);
    return withTenant(this.app.db, tenantId, (tx) =>
      this.idempotent(
        tx,
        actor,
        "conversation.whatsapp.unlink",
        idempotencyKey,
        {},
        async () => {
          const revoked = await tx.$executeRawUnsafe(
            `UPDATE app.whatsapp_bindings SET state='REVOKED',revoked_at=now()
         WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND provider='meta' AND state='ACTIVE'`,
            tenantId,
            membershipId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.whatsapp_channel_preferences(tenant_id,membership_id,proactive_state,consent_source,unsubscribed_at)
         VALUES($1::uuid,$2::uuid,'OPTED_OUT','WEB_ADMIN',now())
         ON CONFLICT(tenant_id,membership_id) DO UPDATE SET proactive_state='OPTED_OUT',consent_source='WEB_ADMIN',unsubscribed_at=now(),updated_at=now(),version=app.whatsapp_channel_preferences.version+1`,
            tenantId,
            membershipId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'conversation.whatsapp.unlinked','whatsapp_binding',$3,$4::jsonb)`,
            tenantId,
            actor.userId,
            correlationId,
            JSON.stringify({ revoked }),
          );
          return { unlinked: revoked > 0 };
        },
      ),
    );
  }

  async deliveries(actor: Actor) {
    const { tenantId, membershipId } = await this.assertMember(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,category,template_code AS "templateCode",state,attempts,safe_error_code AS "safeErrorCode",created_at AS "createdAt",delivered_at AS "deliveredAt"
         FROM app.conversation_channel_deliveries
         WHERE tenant_id=$1::uuid AND membership_id=$2::uuid
         ORDER BY created_at DESC LIMIT 100`,
        tenantId,
        membershipId,
      );
      return { items, total: items.length };
    });
  }

  async updatePreference(
    actor: Actor,
    input: {
      proactive: boolean;
      quietStart?: string | null;
      quietEnd?: string | null;
      expectedVersion: number;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    const { tenantId, membershipId } = await this.assertMember(actor);
    if ((input.quietStart == null) !== (input.quietEnd == null))
      throw new AppError(
        400,
        "QUIET_HOURS_INVALID",
        "Quiet start and end must be provided together",
      );
    return withTenant(this.app.db, tenantId, (tx) =>
      this.idempotent(
        tx,
        actor,
        "conversation.whatsapp.preference",
        idempotencyKey,
        input,
        async () => {
          const existing = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT version FROM app.whatsapp_channel_preferences WHERE tenant_id=$1::uuid AND membership_id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (Number(existing?.version ?? 0) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Preference changed; refresh and retry",
            );
          const row = existing
            ? (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `UPDATE app.whatsapp_channel_preferences SET proactive_state=$1,quiet_start=$2::time,quiet_end=$3::time,consent_source='WEB_ADMIN',consented_at=CASE WHEN $1='OPTED_IN' THEN coalesce(consented_at,now()) ELSE consented_at END,unsubscribed_at=CASE WHEN $1='OPTED_OUT' THEN now() ELSE null END,updated_at=now(),version=version+1
               WHERE tenant_id=$4::uuid AND membership_id=$5::uuid RETURNING proactive_state AS "proactiveState",quiet_start AS "quietStart",quiet_end AS "quietEnd",version`,
                  input.proactive ? "OPTED_IN" : "OPTED_OUT",
                  input.quietStart ?? null,
                  input.quietEnd ?? null,
                  tenantId,
                  membershipId,
                )
              )[0]!
            : (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `INSERT INTO app.whatsapp_channel_preferences(tenant_id,membership_id,proactive_state,quiet_start,quiet_end,consent_source,consented_at,unsubscribed_at)
               VALUES($1::uuid,$2::uuid,$3,$4::time,$5::time,'WEB_ADMIN',CASE WHEN $3='OPTED_IN' THEN now() END,CASE WHEN $3='OPTED_OUT' THEN now() END)
               RETURNING proactive_state AS "proactiveState",quiet_start AS "quietStart",quiet_end AS "quietEnd",version`,
                  tenantId,
                  membershipId,
                  input.proactive ? "OPTED_IN" : "OPTED_OUT",
                  input.quietStart ?? null,
                  input.quietEnd ?? null,
                )
              )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'conversation.whatsapp.preference.changed','whatsapp_preference',$3,$4::jsonb)`,
            tenantId,
            actor.userId,
            correlationId,
            JSON.stringify({
              proactiveState: row.proactiveState,
              quietStart: row.quietStart,
              quietEnd: row.quietEnd,
            }),
          );
          return row;
        },
      ),
    );
  }

  private async assertMember(actor: Actor) {
    if (!actor.activeTenantId || !actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    const allowed = await withTenant(
      this.app.db,
      actor.activeTenantId,
      async (tx) =>
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT 1 FROM app.tenant_memberships m
         WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid AND m.user_id=$3::uuid AND m.status='ACTIVE'
         AND EXISTS(SELECT 1 FROM app.membership_role_assignments a
           JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='conversation.use'
           WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
             AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()))`,
          actor.activeTenantId,
          actor.membershipId,
          actor.userId,
        ),
    );
    if (!allowed[0])
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    return { tenantId: actor.activeTenantId, membershipId: actor.membershipId };
  }

  private async idempotent<T extends Record<string, unknown>>(
    tx: Prisma.TransactionClient,
    actor: Actor,
    operation: string,
    key: string,
    input: unknown,
    mutate: () => Promise<T>,
  ): Promise<T> {
    if (key.length < 8 || key.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const tenantId = String(actor.activeTenantId);
    const keyHash = digest(`${tenantId}:${key}`);
    const requestHash = digest(JSON.stringify(input));
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:${actor.userId}:${operation}:${keyHash}`,
    );
    const prior = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash,response_json FROM app.idempotency_records
         WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key was used for different input",
        );
      return { ...(prior.response_json as T), replayed: true };
    }
    const result = await mutate();
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)`,
      tenantId,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      JSON.stringify(result),
    );
    return result;
  }

  private addressHash(mobile: string) {
    return createHmac("sha256", this.app.config.WHATSAPP_ADDRESS_PEPPER)
      .update(mobile)
      .digest("hex");
  }

  private async setConsentByMobile(
    mobile: string,
    optedIn: boolean,
    providerEventId: string,
    bodyHash: string,
    correlationId: string,
  ) {
    const addressHash = this.addressHash(mobile);
    return withPlatform(this.app.db, async (tx) => {
      const bindings = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.tenant_id,b.membership_id,b.actor_id,p.consent_provider_event_id FROM app.whatsapp_bindings b
         JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.id=b.membership_id
         LEFT JOIN app.whatsapp_channel_preferences p ON p.tenant_id=b.tenant_id AND p.membership_id=b.membership_id
         WHERE b.provider='meta' AND b.address_hash=$1 AND b.state='ACTIVE' AND m.status='ACTIVE' FOR UPDATE OF b`,
        addressHash,
      );
      if (bindings.length !== 1)
        throw new AppError(
          403,
          bindings.length ? "WHATSAPP_TENANT_AMBIGUOUS" : "WHATSAPP_NOT_LINKED",
          "WhatsApp identity is not uniquely linked",
        );
      const binding = bindings[0]!;
      if (binding.consent_provider_event_id === providerEventId) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.whatsapp_channel_preferences(tenant_id,membership_id,proactive_state,consent_source,consent_provider_event_id,consented_at,unsubscribed_at)
         VALUES($1::uuid,$2::uuid,$3,'WHATSAPP',$4,CASE WHEN $3='OPTED_IN' THEN now() END,CASE WHEN $3='OPTED_OUT' THEN now() END)
         ON CONFLICT(tenant_id,membership_id) DO UPDATE SET proactive_state=EXCLUDED.proactive_state,consent_source='WHATSAPP',consent_provider_event_id=EXCLUDED.consent_provider_event_id,consented_at=CASE WHEN EXCLUDED.proactive_state='OPTED_IN' THEN now() ELSE app.whatsapp_channel_preferences.consented_at END,unsubscribed_at=CASE WHEN EXCLUDED.proactive_state='OPTED_OUT' THEN now() ELSE null END,updated_at=now(),version=app.whatsapp_channel_preferences.version+1`,
        binding.tenant_id,
        binding.membership_id,
        optedIn ? "OPTED_IN" : "OPTED_OUT",
        providerEventId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,$3,'whatsapp_preference',$4,$5::jsonb)`,
        binding.tenant_id,
        binding.actor_id,
        optedIn
          ? "conversation.whatsapp.proactive.opted_in"
          : "conversation.whatsapp.proactive.opted_out",
        correlationId,
        JSON.stringify({
          provider: "meta",
          proactiveState: optedIn ? "OPTED_IN" : "OPTED_OUT",
        }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.conversation_provider_receipts(provider,provider_event_id,body_sha256,signature_verified,disposition)
         VALUES('meta',$1,$2,true,'ACCEPTED') ON CONFLICT(provider,provider_event_id) DO NOTHING`,
        providerEventId,
        bodyHash,
      );
    });
  }

  private replyText(result: unknown): string {
    const value = (result ?? {}) as Record<string, unknown>;
    if (value.linked)
      return "WhatsApp is linked. Send a supported request in English. Reply START ALERTS to opt in to proactive alerts.";
    const response = (value.response ?? value) as Record<string, unknown>;
    const assistant = response.assistantMessage as
      | Record<string, unknown>
      | undefined;
    const proposal = response.proposal as Record<string, unknown> | undefined;
    let text =
      typeof assistant?.text === "string"
        ? assistant.text
        : "Request received.";
    if (proposal?.id) {
      if (proposal.requiresStepUp)
        text += " Open the authenticated app to confirm this high-risk action.";
      else
        text += ` Reply CONFIRM ${String(proposal.id)} or CANCEL ${String(proposal.id)}.`;
    }
    return text.slice(0, 4096);
  }

  private async queueReply(
    mobile: string,
    providerEventId: string,
    body: string,
  ) {
    const bindings = await withPlatform(this.app.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.tenant_id,b.membership_id FROM app.whatsapp_bindings b
         JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.id=b.membership_id
         WHERE b.provider='meta' AND b.address_hash=$1 AND b.state='ACTIVE' AND m.status='ACTIVE'`,
        this.addressHash(mobile),
      ),
    );
    if (bindings.length !== 1) return;
    const binding = bindings[0]!;
    await withTenant(this.app.db, String(binding.tenant_id), (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app.conversation_channel_deliveries(tenant_id,membership_id,category,rendered_body,deduplication_key)
         VALUES($1::uuid,$2::uuid,'TRANSACTIONAL',$3,$4) ON CONFLICT(tenant_id,deduplication_key) DO NOTHING`,
        binding.tenant_id,
        binding.membership_id,
        body,
        `whatsapp-reply:${providerEventId}`,
      ),
    );
  }

  async processPending(limit = 25) {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta") return 0;
    await this.enqueueAlerts(limit);
    let processed = 0;
    for (let index = 0; index < limit; index++) {
      const lease = await this.leaseOne();
      if (!lease) break;
      await this.deliver(lease);
      processed++;
    }
    return processed;
  }

  private async enqueueAlerts(limit: number) {
    return withPlatform(this.app.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT d.id,d.tenant_id,d.membership_id,a.title,a.summary,a.severity,a.state AS alert_state,p.proactive_state,
           app.operational_alert_authorized(d.tenant_id,d.membership_id,m.user_id,'alerts.read',a.id) AS authorized
         FROM app.notification_deliveries d
         JOIN app.operational_alerts a ON a.tenant_id=d.tenant_id AND a.id=d.alert_id
         JOIN app.tenant_memberships m ON m.tenant_id=d.tenant_id AND m.id=d.membership_id AND m.status='ACTIVE'
         LEFT JOIN app.whatsapp_channel_preferences p ON p.tenant_id=d.tenant_id AND p.membership_id=d.membership_id
         WHERE d.channel='WHATSAPP' AND d.state IN ('PENDING','FAILED') AND d.available_at<=now()
         ORDER BY d.available_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1`,
        limit,
      );
      for (const row of rows) {
        const suppression =
          row.authorized !== true && row.authorized !== "t"
            ? "ACCESS_CHANGED"
            : row.alert_state === "RESOLVED"
              ? "ALERT_NO_LONGER_ACTIVE"
              : row.proactive_state !== "OPTED_IN"
                ? "WHATSAPP_NOT_OPTED_IN"
                : null;
        if (suppression) {
          const attempt = await this.nextNotificationAttempt(tx, row);
          await tx.$executeRawUnsafe(
            `INSERT INTO app.notification_delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,safe_error_code)
             VALUES($1::uuid,$2::uuid,$3,'SUPPRESSED',$4)`,
            row.tenant_id,
            row.id,
            attempt,
            suppression,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.notification_deliveries SET state='SUPPRESSED',attempts=$1,safe_error_code=$4 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
            attempt,
            row.tenant_id,
            row.id,
            suppression,
          );
          continue;
        }
        const parameters = [
          String(row.severity),
          String(row.title),
          String(row.summary),
        ];
        const delivery = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.conversation_channel_deliveries(tenant_id,membership_id,notification_delivery_id,category,template_code,template_parameters,rendered_body,deduplication_key)
           VALUES($1::uuid,$2::uuid,$3::uuid,'PROACTIVE',$4,$5::jsonb,$6,$7)
           ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET deduplication_key=EXCLUDED.deduplication_key
           RETURNING state,safe_error_code AS "safeErrorCode",delivered_at AS "deliveredAt"`,
            row.tenant_id,
            row.membership_id,
            row.id,
            this.app.config.WHATSAPP_ALERT_TEMPLATE_NAME,
            JSON.stringify(parameters),
            `[${parameters[0]}] ${parameters[1]}: ${parameters[2]}`,
            `whatsapp-alert:${String(row.id)}`,
          )
        )[0]!;
        const sourceState =
          delivery.state === "DELIVERED"
            ? "DELIVERED"
            : delivery.state === "DEAD_LETTER"
              ? "SUPPRESSED"
              : delivery.state === "SUPPRESSED"
                ? "SUPPRESSED"
                : "LEASED";
        await tx.$executeRawUnsafe(
          `UPDATE app.notification_deliveries SET state=$1,leased_at=CASE WHEN $1='LEASED' THEN now() ELSE leased_at END,delivered_at=CASE WHEN $1='DELIVERED' THEN coalesce(delivered_at,$2::timestamptz,now()) ELSE delivered_at END,safe_error_code=$3
           WHERE tenant_id=$4::uuid AND id=$5::uuid`,
          sourceState,
          delivery.deliveredAt ?? null,
          delivery.safeErrorCode ?? null,
          row.tenant_id,
          row.id,
        );
      }
    });
  }

  private async nextNotificationAttempt(
    tx: Prisma.TransactionClient,
    row: Row,
  ) {
    const current = (
      await tx.$queryRawUnsafe<Array<{ attempts: number }>>(
        `SELECT attempts FROM app.notification_deliveries WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        row.tenant_id,
        row.id,
      )
    )[0];
    return Number(current?.attempts ?? 0) + 1;
  }

  private async leaseOne() {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digest(token);
    const row = await withPlatform(this.app.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE app.conversation_channel_deliveries SET state='RETRY',lease_token_hash=null,leased_at=null,lease_expires_at=null,safe_error_code='LEASE_EXPIRED',available_at=now(),updated_at=now(),version=version+1
         WHERE state='LEASED' AND lease_expires_at<=now()`,
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `WITH candidate AS (
             SELECT id FROM app.conversation_channel_deliveries
             WHERE state IN ('PENDING','RETRY') AND available_at<=now()
             ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE app.conversation_channel_deliveries d SET state='LEASED',lease_token_hash=$1,leased_at=now(),lease_expires_at=now()+interval '2 minutes',updated_at=now(),version=version+1
           FROM candidate c WHERE d.id=c.id
           RETURNING d.*`,
          tokenHash,
        )
      )[0];
    });
    return row ? { row, tokenHash } : null;
  }

  private async deliver(lease: { row: Row; tokenHash: string }) {
    const row = lease.row;
    const destination = await withPlatform(this.app.db, async (tx) => {
      const candidates = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT b.address_ciphertext,t.timezone,p.proactive_state,p.quiet_start,p.quiet_end
         FROM app.whatsapp_bindings b
         JOIN app.tenants t ON t.id=b.tenant_id
         LEFT JOIN app.whatsapp_channel_preferences p ON p.tenant_id=b.tenant_id AND p.membership_id=b.membership_id
         WHERE b.tenant_id=$1::uuid AND b.membership_id=$2::uuid AND b.provider='meta' AND b.state='ACTIVE'`,
        row.tenant_id,
        row.membership_id,
      );
      return candidates.length === 1 ? candidates[0] : null;
    });
    if (!destination)
      return this.complete(
        lease,
        "SUPPRESSED",
        undefined,
        "WHATSAPP_BINDING_UNAVAILABLE",
        0,
      );
    if (row.category === "PROACTIVE") {
      if (destination.proactive_state !== "OPTED_IN")
        return this.complete(
          lease,
          "SUPPRESSED",
          undefined,
          "WHATSAPP_NOT_OPTED_IN",
          0,
        );
      const authorization = await withPlatform(
        this.app.db,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT a.state,app.operational_alert_authorized(d.tenant_id,d.membership_id,m.user_id,'alerts.read',a.id) AS allowed
             FROM app.notification_deliveries d
             JOIN app.operational_alerts a ON a.tenant_id=d.tenant_id AND a.id=d.alert_id
             JOIN app.tenant_memberships m ON m.tenant_id=d.tenant_id AND m.id=d.membership_id AND m.status='ACTIVE'
             WHERE d.tenant_id=$1::uuid AND d.id=$2::uuid`,
              row.tenant_id,
              row.notification_delivery_id,
            )
          )[0],
      );
      if (
        !authorization ||
        (authorization.allowed !== true && authorization.allowed !== "t")
      )
        return this.complete(
          lease,
          "SUPPRESSED",
          undefined,
          "ACCESS_CHANGED",
          0,
        );
      if (authorization.state === "RESOLVED")
        return this.complete(
          lease,
          "SUPPRESSED",
          undefined,
          "ALERT_NO_LONGER_ACTIVE",
          0,
        );
      if (this.inQuietHours(destination)) {
        await withPlatform(this.app.db, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE app.conversation_channel_deliveries SET state='RETRY',available_at=now()+interval '15 minutes',lease_token_hash=null,leased_at=null,lease_expires_at=null,updated_at=now(),version=version+1
             WHERE id=$1::uuid AND lease_token_hash=$2`,
            row.id,
            lease.tokenHash,
          ),
        );
        return;
      }
    }
    const started = Date.now();
    try {
      const address = this.decryptAddress(
        Buffer.from(destination.address_ciphertext as Uint8Array),
      );
      const providerId =
        row.category === "PROACTIVE"
          ? await this.adapter.sendTemplate(
              address,
              row.template_parameters as string[],
            )
          : await this.adapter.sendText(address, String(row.rendered_body));
      await this.complete(
        lease,
        "DELIVERED",
        providerId,
        undefined,
        Date.now() - started,
      );
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : "WHATSAPP_DELIVERY_ERROR";
      const retryable = !(error instanceof AppError) || error.status >= 500;
      const nextAttempt = Number(row.attempts) + 1;
      const terminal =
        !retryable ||
        nextAttempt >= this.app.config.WHATSAPP_DELIVERY_MAX_ATTEMPTS;
      await this.complete(
        lease,
        terminal ? "DEAD_LETTER" : "RETRY",
        undefined,
        code,
        Date.now() - started,
      );
    }
  }

  private inQuietHours(row: Row) {
    if (!row.quiet_start || !row.quiet_end) return false;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: String(row.timezone),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(
      parts.find((part) => part.type === "minute")?.value ?? 0,
    );
    const current = hour * 60 + minute;
    const minutes = (value: unknown) => {
      const [h, m] = String(value).split(":").map(Number);
      return h! * 60 + m!;
    };
    const start = minutes(row.quiet_start),
      end = minutes(row.quiet_end);
    return start <= end
      ? current >= start && current < end
      : current >= start || current < end;
  }

  private async complete(
    lease: { row: Row; tokenHash: string },
    outcome: "DELIVERED" | "RETRY" | "DEAD_LETTER" | "SUPPRESSED",
    providerMessageId?: string,
    safeErrorCode?: string,
    latencyMs?: number,
  ) {
    const row = lease.row;
    return withPlatform(this.app.db, async (tx) => {
      const attempt = Number(row.attempts) + 1;
      const updated = await tx.$executeRawUnsafe(
        `UPDATE app.conversation_channel_deliveries SET state=$1,attempts=$2,available_at=CASE WHEN $1='RETRY' THEN now()+make_interval(secs=>least(3600,power(2,$2)::int*15)) ELSE available_at END,lease_token_hash=null,leased_at=null,lease_expires_at=null,delivered_at=CASE WHEN $1='DELIVERED' THEN now() ELSE delivered_at END,provider_message_id=$3,safe_error_code=$4,updated_at=now(),version=version+1
         WHERE id=$5::uuid AND lease_token_hash=$6`,
        outcome,
        attempt,
        providerMessageId ?? null,
        safeErrorCode ?? null,
        row.id,
        lease.tokenHash,
      );
      if (!updated) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.conversation_channel_delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,provider_message_id,safe_error_code,latency_ms)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`,
        row.tenant_id,
        row.id,
        attempt,
        outcome,
        providerMessageId ?? null,
        safeErrorCode ?? null,
        latencyMs ?? null,
      );
      if (row.notification_delivery_id) {
        const notificationState =
          outcome === "DELIVERED"
            ? "DELIVERED"
            : outcome === "RETRY"
              ? "FAILED"
              : "SUPPRESSED";
        const notificationAttempt = await this.nextNotificationAttempt(tx, {
          tenant_id: row.tenant_id,
          id: row.notification_delivery_id,
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO app.notification_delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,provider_reference,safe_error_code)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)`,
          row.tenant_id,
          row.notification_delivery_id,
          notificationAttempt,
          outcome === "DEAD_LETTER" ? "FAILED" : outcome,
          providerMessageId ?? null,
          safeErrorCode ?? null,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.notification_deliveries SET state=$1,attempts=$2,available_at=CASE WHEN $1='FAILED' THEN now()+interval '1 hour' ELSE available_at END,delivered_at=CASE WHEN $1='DELIVERED' THEN now() ELSE delivered_at END,safe_error_code=$3 WHERE tenant_id=$4::uuid AND id=$5::uuid`,
          notificationState,
          notificationAttempt,
          safeErrorCode ?? null,
          row.tenant_id,
          row.notification_delivery_id,
        );
      }
    });
  }

  private decryptAddress(envelope: Buffer) {
    if (envelope.length < 30 || envelope[0] !== 1)
      throw new AppError(
        500,
        "WHATSAPP_ADDRESS_INVALID",
        "WhatsApp destination is unavailable",
      );
    const key = Buffer.from(
      this.app.config.WHATSAPP_ADDRESS_ENCRYPTION_KEY,
      "base64",
    );
    const iv = envelope.subarray(1, 13);
    const tag = envelope.subarray(13, 29);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(envelope.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  }
}

@Injectable()
export class ConversationWhatsappScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConversationWhatsappScheduler.name);
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(
    @Inject(ConversationWhatsappService)
    private readonly delivery: ConversationWhatsappService,
    @Inject(AppService) private readonly app: AppService,
  ) {}

  onModuleInit() {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta") return;
    this.timer = setInterval(
      () => void this.poll(),
      this.app.config.WHATSAPP_DELIVERY_POLL_SECONDS * 1000,
    );
    this.timer.unref();
    this.startupTimer = setTimeout(() => void this.poll(), 1_000);
    this.startupTimer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    await this.active;
  }

  private poll() {
    if (this.active) return this.active;
    this.active = this.delivery
      .processPending()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error(
          "WhatsApp delivery poll failed; the next poll will retry",
          error instanceof Error ? error.stack : undefined,
        );
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}
