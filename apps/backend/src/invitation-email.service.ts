import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import { withPlatform } from "@logistics/db";
import { AppService } from "./app.service.js";
import { openOwnerInvitationToken } from "./invitation-token-envelope.js";

type LeasedInvitation = {
  attemptId: string;
  tenantId: string;
  invitationId: string;
  secretEnvelope: string;
  email: string;
  tenantName: string;
  expiresAt: Date;
  attempts: number;
};

export type InvitationEmailClient = {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
};

export function classifySesFailure(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "UNKNOWN";
  const details =
    error && typeof error === "object"
      ? (error as {
          $retryable?: unknown;
          $metadata?: { requestId?: unknown; httpStatusCode?: unknown };
        })
      : undefined;
  const normalized = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  const knownPreAcceptance = new Set([
    "THROTTLINGEXCEPTION",
    "TOOMANYREQUESTSEXCEPTION",
    "SERVICEUNAVAILABLEEXCEPTION",
  ]);
  const ambiguousTransport = new Set([
    "TIMEOUTERROR",
    "REQUESTTIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "NETWORKINGERROR",
  ]);
  if (ambiguousTransport.has(normalized))
    return { code: "DELIVERY_OUTCOME_UNKNOWN", retryable: false };
  const retryable =
    knownPreAcceptance.has(normalized) ||
    [429, 503].includes(Number(details?.$metadata?.httpStatusCode ?? 0));
  return {
    code: `SES_${normalized}`.slice(0, 100),
    retryable,
  };
}

const htmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

export function ownerInvitationEmail(input: {
  from: string;
  to: string;
  tenantName: string;
  activationUrl: string;
  expiresAt: Date;
}) {
  const tenantName =
    input.tenantName.replace(/[\r\n\t]+/g, " ").trim() || "your organization";
  const expiry = input.expiresAt.toISOString();
  const subject = `Activate your ${tenantName} logistics account`;
  const text = [
    `You have been invited to manage ${tenantName}.`,
    "Activate your account using this one-time link:",
    input.activationUrl,
    `This link expires at ${expiry}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n\n");
  const html = `<p>You have been invited to manage <strong>${htmlEscape(tenantName)}</strong>.</p><p><a href="${htmlEscape(input.activationUrl)}">Activate your account</a></p><p>This one-time link expires at ${htmlEscape(expiry)}.</p><p>If you were not expecting this invitation, you can ignore this email.</p>`;
  return new SendEmailCommand({
    FromEmailAddress: input.from,
    Destination: { ToAddresses: [input.to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: text, Charset: "UTF-8" },
          Html: { Data: html, Charset: "UTF-8" },
        },
      },
    },
    EmailTags: [{ Name: "message_type", Value: "owner_invitation" }],
  });
}

@Injectable()
export class InvitationEmailDeliveryService {
  private readonly logger = new Logger(InvitationEmailDeliveryService.name);
  private readonly client: InvitationEmailClient;

  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Optional()
    @Inject("INVITATION_EMAIL_CLIENT")
    suppliedClient?: InvitationEmailClient,
  ) {
    this.client =
      suppliedClient ??
      new SESv2Client({ region: app.config.AWS_REGION, maxAttempts: 1 });
  }

  async processPending(limit = 25): Promise<number> {
    if (this.app.config.EMAIL_DELIVERY_PROVIDER !== "ses") return 0;
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await withPlatform(this.app.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `WITH candidates AS (
           SELECT id FROM app.invitation_delivery_attempts
           WHERE channel='EMAIL' AND state='PENDING' AND secret_envelope IS NULL
           ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $1
         ), legacy AS (
           UPDATE app.invitation_delivery_attempts a
           SET state='FAILED',failure_code='TOKEN_MATERIAL_UNAVAILABLE',updated_at=now()
           FROM candidates c WHERE a.id=c.id
           RETURNING a.tenant_id,a.invitation_id
         ), invitations AS (
           UPDATE app.owner_invitations i
           SET delivery_state='FAILED',updated_at=now(),version=version+1
           FROM legacy l WHERE i.tenant_id=l.tenant_id AND i.id=l.invitation_id
             AND i.accepted_at IS NULL
           RETURNING i.tenant_id,i.id
         ), events AS (
           UPDATE app.outbox_events o SET state='FAILED',error_class='TOKEN_MATERIAL_UNAVAILABLE',
             updated_at=now(),version=version+1
           FROM legacy l WHERE o.tenant_id=l.tenant_id AND o.aggregate_id=l.invitation_id
             AND o.event_type='owner_invitation.requested.v1' AND o.state='PENDING'
         ), audits AS (
           INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
           SELECT tenant_id,'owner.invitation.delivery.failed','owner_invitation',invitation_id,
             'WORKER',jsonb_build_object('failureCode','TOKEN_MATERIAL_UNAVAILABLE'),
             'invitation-delivery-legacy:'||invitation_id::text FROM legacy
         )
         INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,correlation_id)
         SELECT tenant_id,'OWNER_INVITATION_DELIVERY_FAILED','ERROR',
           'owner-invitation-delivery:'||id::text,
           'An owner activation invitation requires an audited reissue before email delivery',
           'invitation-delivery-legacy:'||id::text FROM invitations
         ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,
           last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1`,
        boundedLimit,
      );
      // A crashed send is deliberately not replayed: SES SendEmail has no
      // idempotency key. An administrator can explicitly reissue a fresh link.
      await tx.$executeRawUnsafe(
        `WITH candidates AS (
           SELECT id FROM app.invitation_delivery_attempts
           WHERE state='LEASED' AND leased_at<now()-interval '15 minutes'
           ORDER BY leased_at,id FOR UPDATE SKIP LOCKED LIMIT $1
         ), stale AS (
           UPDATE app.invitation_delivery_attempts a
           SET state='FAILED',failure_code='LEASE_EXPIRED',secret_envelope=null,updated_at=now()
           FROM candidates c WHERE a.id=c.id
           RETURNING a.tenant_id,a.invitation_id
         ), invitations AS (
           UPDATE app.owner_invitations i
           SET delivery_state='FAILED',updated_at=now(),version=version+1
           FROM stale s WHERE i.tenant_id=s.tenant_id AND i.id=s.invitation_id
             AND i.accepted_at IS NULL
         ), alerts AS (
           INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,correlation_id)
           SELECT tenant_id,'OWNER_INVITATION_DELIVERY_FAILED','ERROR',
             'owner-invitation-delivery:'||invitation_id::text,
             'An owner activation delivery lease expired with an unknown provider outcome',
             'invitation-delivery-stale:'||invitation_id::text FROM stale
           ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,
             last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1
         ), audits AS (
           INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
           SELECT tenant_id,'owner.invitation.delivery.failed','owner_invitation',invitation_id,
             'WORKER',jsonb_build_object('failureCode','LEASE_EXPIRED'),
             'invitation-delivery-stale:'||invitation_id::text FROM stale
         )
         UPDATE app.outbox_events o SET state='FAILED',error_class='LEASE_EXPIRED',
           updated_at=now(),version=version+1
         FROM stale s WHERE o.tenant_id=s.tenant_id AND o.aggregate_id=s.invitation_id
           AND o.event_type='owner_invitation.requested.v1' AND o.state='PENDING'`,
        boundedLimit,
      );
      await tx.$executeRawUnsafe(
        `WITH candidates AS (
           SELECT a.id FROM app.invitation_delivery_attempts a
           WHERE a.state='PENDING' AND a.secret_envelope IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM app.owner_invitations i
               WHERE i.tenant_id=a.tenant_id AND i.id=a.invitation_id
                 AND (i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at<=now())
             )
           ORDER BY a.available_at,a.id FOR UPDATE SKIP LOCKED LIMIT $1
         ), invalid AS (
           UPDATE app.invitation_delivery_attempts a
           SET state='FAILED',failure_code='INVITATION_NO_LONGER_ACTIVE',secret_envelope=null,updated_at=now()
           FROM candidates c WHERE a.id=c.id
           RETURNING a.tenant_id,a.invitation_id
         ), alerts AS (
           INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,correlation_id)
           SELECT tenant_id,'OWNER_INVITATION_DELIVERY_FAILED','ERROR',
             'owner-invitation-delivery:'||invitation_id::text,
             'An owner activation invitation became ineligible before delivery',
             'invitation-delivery-ineligible:'||invitation_id::text FROM invalid
           ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,
             last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1
         ), audits AS (
           INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
           SELECT tenant_id,'owner.invitation.delivery.failed','owner_invitation',invitation_id,
             'WORKER',jsonb_build_object('failureCode','INVITATION_NO_LONGER_ACTIVE'),
             'invitation-delivery-ineligible:'||invitation_id::text FROM invalid
         )
         UPDATE app.outbox_events o SET state='FAILED',error_class='INVITATION_NO_LONGER_ACTIVE',
           updated_at=now(),version=version+1
         FROM invalid i WHERE o.tenant_id=i.tenant_id AND o.aggregate_id=i.invitation_id
           AND o.event_type='owner_invitation.requested.v1' AND o.state='PENDING'`,
        boundedLimit,
      );
      return tx.$queryRawUnsafe<Array<LeasedInvitation>>(
        `WITH candidates AS (
           SELECT a.id
           FROM app.invitation_delivery_attempts a
           JOIN app.owner_invitations i ON i.tenant_id=a.tenant_id AND i.id=a.invitation_id
           JOIN app.tenants t ON t.id=a.tenant_id
           WHERE a.channel='EMAIL' AND a.state='PENDING' AND a.available_at<=now()
             AND a.secret_envelope IS NOT NULL AND i.accepted_at IS NULL
             AND i.revoked_at IS NULL AND i.expires_at>now() AND t.status='ACTIVE'
           ORDER BY a.available_at,a.id
           FOR UPDATE OF a SKIP LOCKED LIMIT $1
         )
         UPDATE app.invitation_delivery_attempts a
         SET state='LEASED',leased_at=now(),attempts=a.attempts+1,updated_at=now()
         FROM candidates c,app.owner_invitations i,app.tenants t
         WHERE a.id=c.id AND i.tenant_id=a.tenant_id AND i.id=a.invitation_id
             AND t.id=a.tenant_id AND t.status='ACTIVE'
         RETURNING a.id AS "attemptId",a.tenant_id AS "tenantId",
           a.invitation_id AS "invitationId",a.secret_envelope AS "secretEnvelope",
           i.email,t.name AS "tenantName",i.expires_at AS "expiresAt",a.attempts`,
        boundedLimit,
      );
    });
    for (const row of rows) await this.deliver(row);
    return rows.length;
  }

  private async deliver(row: LeasedInvitation) {
    try {
      if (!(await this.isStillEligible(row))) {
        await this.fail(row, "INVITATION_NO_LONGER_ACTIVE", false);
        return;
      }
      const envelope = openOwnerInvitationToken(
        row.secretEnvelope,
        row.tenantId,
        row.invitationId,
        this.app.config.EMAIL_TOKEN_ENCRYPTION_KEY,
      );
      if (Date.parse(envelope.expiresAt) !== new Date(row.expiresAt).getTime())
        throw new Error("Invitation token expiry does not match the record");
      const origin = new URL(this.app.config.FRONTEND_URL).origin;
      const activationUrl = `${origin}/accept-invitation?token=${encodeURIComponent(envelope.token)}`;
      const result = await this.client.send(
        ownerInvitationEmail({
          from: this.app.config.SES_FROM_EMAIL,
          to: row.email,
          tenantName: row.tenantName,
          activationUrl,
          expiresAt: new Date(row.expiresAt),
        }),
      );
      await this.complete(row, result.MessageId ?? null);
    } catch (error) {
      const failure = classifySesFailure(error);
      await this.fail(row, failure.code, failure.retryable);
    }
  }

  private isStillEligible(row: LeasedInvitation) {
    return withPlatform(this.app.db, async (tx) => {
      const result = await tx.$queryRawUnsafe<Array<{ eligible: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM app.invitation_delivery_attempts a
           JOIN app.owner_invitations i ON i.tenant_id=a.tenant_id AND i.id=a.invitation_id
           JOIN app.tenants t ON t.id=a.tenant_id
           WHERE a.id=$1::uuid AND a.tenant_id=$2::uuid AND a.state='LEASED'
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL
             AND i.expires_at>now() AND t.status='ACTIVE'
         ) AS eligible`,
        row.attemptId,
        row.tenantId,
      );
      return Boolean(result[0]?.eligible);
    });
  }

  private async complete(
    row: LeasedInvitation,
    providerMessageId: string | null,
  ) {
    await withPlatform(this.app.db, async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE app.invitation_delivery_attempts a
         SET state='DELIVERED',delivered_at=now(),failure_code=null,
           provider_message_id=$1,secret_envelope=null,updated_at=now()
         WHERE a.id=$2::uuid AND a.tenant_id=$3::uuid AND a.state='LEASED'
           AND EXISTS (
             SELECT 1 FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id
             WHERE i.tenant_id=a.tenant_id AND i.id=a.invitation_id
               AND i.accepted_at IS NULL AND i.revoked_at IS NULL
               AND i.expires_at>now() AND t.status='ACTIVE'
           )`,
        providerMessageId,
        row.attemptId,
        row.tenantId,
      );
      if (!updated) {
        await tx.$executeRawUnsafe(
          `UPDATE app.invitation_delivery_attempts
           SET state='FAILED',failure_code='INVITATION_NO_LONGER_ACTIVE',secret_envelope=null,updated_at=now()
           WHERE id=$1::uuid AND tenant_id=$2::uuid AND state='LEASED'`,
          row.attemptId,
          row.tenantId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.owner_invitations SET delivery_state='FAILED',updated_at=now(),version=version+1
           WHERE tenant_id=$1::uuid AND id=$2::uuid AND accepted_at IS NULL`,
          row.tenantId,
          row.invitationId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.outbox_events SET state='FAILED',error_class='INVITATION_NO_LONGER_ACTIVE',
             updated_at=now(),version=version+1
           WHERE tenant_id=$1::uuid AND aggregate_id=$2::uuid
             AND event_type='owner_invitation.requested.v1' AND state='PENDING'`,
          row.tenantId,
          row.invitationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,correlation_id)
           VALUES($1::uuid,'OWNER_INVITATION_DELIVERY_FAILED','ERROR',$2,
             'Invitation eligibility changed while SES submission was in progress',$3)
           ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,
             last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1`,
          row.tenantId,
          `owner-invitation-delivery:${row.invitationId}`,
          `invitation-delivery:${row.attemptId}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
           VALUES($1::uuid,'owner.invitation.delivery.failed','owner_invitation',$2::uuid,'WORKER',$3::jsonb,$4)`,
          row.tenantId,
          row.invitationId,
          JSON.stringify({ failureCode: "INVITATION_NO_LONGER_ACTIVE" }),
          `invitation-delivery:${row.attemptId}`,
        );
        return;
      }
      await tx.$executeRawUnsafe(
        `UPDATE app.owner_invitations SET delivery_state='DELIVERED',updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND accepted_at IS NULL AND revoked_at IS NULL`,
        row.tenantId,
        row.invitationId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.outbox_events SET state='PROCESSED',processed_at=now(),error_class=null,
           updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND aggregate_id=$2::uuid
           AND event_type='owner_invitation.requested.v1' AND state='PENDING'`,
        row.tenantId,
        row.invitationId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
         VALUES($1::uuid,'owner.invitation.delivered','owner_invitation',$2::uuid,'WORKER',$3::jsonb,$4)`,
        row.tenantId,
        row.invitationId,
        JSON.stringify({ channel: "EMAIL", provider: "SES" }),
        `invitation-delivery:${row.attemptId}`,
      );
    });
  }

  private async fail(
    row: LeasedInvitation,
    failureCode: string,
    retryable: boolean,
  ) {
    await withPlatform(this.app.db, async (tx) => {
      if (
        retryable &&
        row.attempts < this.app.config.INVITATION_DELIVERY_MAX_ATTEMPTS
      ) {
        const retryDelaySeconds = row.attempts === 1 ? 60 : 300;
        await tx.$executeRawUnsafe(
          `UPDATE app.invitation_delivery_attempts
           SET state='PENDING',failure_code=$1,available_at=now()+($2::int*interval '1 second'),
             leased_at=null,updated_at=now()
           WHERE id=$3::uuid AND tenant_id=$4::uuid AND state='LEASED'`,
          failureCode,
          retryDelaySeconds,
          row.attemptId,
          row.tenantId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.outbox_events SET error_class=$1,updated_at=now(),version=version+1
           WHERE tenant_id=$2::uuid AND aggregate_id=$3::uuid
             AND event_type='owner_invitation.requested.v1' AND state='PENDING'`,
          failureCode,
          row.tenantId,
          row.invitationId,
        );
        return;
      }
      const updated = await tx.$executeRawUnsafe(
        `UPDATE app.invitation_delivery_attempts
         SET state='FAILED',failure_code=$1,secret_envelope=null,updated_at=now()
         WHERE id=$2::uuid AND tenant_id=$3::uuid AND state='LEASED'`,
        failureCode,
        row.attemptId,
        row.tenantId,
      );
      if (!updated) return;
      await tx.$executeRawUnsafe(
        `UPDATE app.owner_invitations SET delivery_state='FAILED',updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND accepted_at IS NULL`,
        row.tenantId,
        row.invitationId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.outbox_events SET state='FAILED',error_class=$1,updated_at=now(),version=version+1
         WHERE tenant_id=$2::uuid AND aggregate_id=$3::uuid
           AND event_type='owner_invitation.requested.v1' AND state='PENDING'`,
        failureCode,
        row.tenantId,
        row.invitationId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,correlation_id)
         VALUES($1::uuid,'OWNER_INVITATION_DELIVERY_FAILED','ERROR',$2,
           'An owner activation email was not accepted by the configured provider',$3)
         ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,
           last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1`,
        row.tenantId,
        `owner-invitation-delivery:${row.invitationId}`,
        `invitation-delivery:${row.attemptId}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,action,target_type,target_id,source,after_json,correlation_id)
         VALUES($1::uuid,'owner.invitation.delivery.failed','owner_invitation',$2::uuid,'WORKER',$3::jsonb,$4)`,
        row.tenantId,
        row.invitationId,
        JSON.stringify({ failureCode }),
        `invitation-delivery:${row.attemptId}`,
      );
    });
    this.logger.warn(
      `Owner invitation delivery failed invitationId=${row.invitationId} code=${failureCode}`,
    );
  }
}

@Injectable()
export class InvitationEmailScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitationEmailScheduler.name);
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private activePoll?: Promise<void>;

  constructor(
    @Inject(InvitationEmailDeliveryService)
    private readonly delivery: InvitationEmailDeliveryService,
    @Inject(AppService) private readonly app: AppService,
  ) {}

  onModuleInit() {
    if (this.app.config.EMAIL_DELIVERY_PROVIDER !== "ses") return;
    const interval = this.app.config.INVITATION_DELIVERY_POLL_SECONDS * 1000;
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    this.startupTimer = setTimeout(() => void this.poll(), 1_000);
    this.startupTimer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    await this.activePoll;
  }

  private poll(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    this.activePoll = this.runPoll();
    return this.activePoll;
  }

  private async runPoll() {
    try {
      await this.delivery.processPending();
    } catch (error) {
      this.logger.error(
        "Invitation delivery poll failed; the next scheduled poll will retry",
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.activePoll = undefined;
    }
  }
}
