import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { AccessService } from "../../access.service.js";
import { AlertsProvider } from "../alerts/alerts.provider.js";
import { DataProvider } from "../data/data.provider.js";
import { IntegrationsProvider } from "../integrations/integrations.provider.js";
import { ControlProvider } from "./control.provider.js";

const cookie = "logistics_session";
const lens = z.enum([
  "placement",
  "pod",
  "collection",
  "trip",
  "vendor-payable",
]);
const uuid = z.string().uuid();

@Controller("tenant")
export class IntelligenceController {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ControlProvider) private readonly control: ControlProvider,
    @Inject(AlertsProvider) private readonly alerts: AlertsProvider,
    @Inject(DataProvider) private readonly data: DataProvider,
    @Inject(IntegrationsProvider)
    private readonly integrations: IntegrationsProvider,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  private async authorized(req: Request, capability: string) {
    const actor = await this.actor(req);
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ??
      crypto.randomUUID();
    const effective = await this.access.effective(actor, correlationId);
    if (!effective.capabilities.includes(capability))
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    return actor;
  }
  private csrf(
    req: Request,
    actor: Awaited<ReturnType<IntelligenceController["actor"]>>,
  ) {
    this.app.requireCsrf(
      actor,
      typeof req.headers["x-csrf-token"] === "string"
        ? req.headers["x-csrf-token"]
        : undefined,
      req.headers.origin,
    );
  }
  private async run(res: Response, fn: () => Promise<unknown>, status = 200) {
    try {
      return res.status(status).json(await fn());
    } catch (error) {
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          fields: Object.fromEntries(
            error.issues.map((issue) => [
              issue.path.join("."),
              [issue.message],
            ]),
          ),
        });
      if (error instanceof AppError)
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          fields: error.fields,
        });
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      });
    }
  }

  @Get("control/:lens") dashboard(
    @Param("lens") value: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.control.dashboard(
        await this.authorized(req, "control.dashboard.read"),
        lens.parse(value),
      ),
    );
  }
  @Get("control/:lens/drill") drill(
    @Param("lens") value: string,
    @Query("status") status: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.control.drill(
        await this.authorized(req, "control.dashboard.read"),
        lens.parse(value),
        status,
      ),
    );
  }
  @Get("control/:lens/views") savedViews(
    @Param("lens") value: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.control.savedViews(
        await this.authorized(req, "control.dashboard.read"),
        lens.parse(value),
      ),
    );
  }
  @Post("control/:lens/views") saveView(
    @Param("lens") value: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "control.dashboard.read");
        this.csrf(req, actor);
        const input = z
          .object({
            name: z.string().trim().min(2).max(100),
            filters: z.record(z.unknown()).default({}),
            isDefault: z.boolean().default(false),
            expectedVersion: z.number().int().positive().optional(),
          })
          .strict()
          .parse(body);
        return this.control.saveView(actor, lens.parse(value), input);
      },
      201,
    );
  }
  @Get("alerts") alertQueue(
    @Query("state") state: string | undefined,
    @Query("severity") severity: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.alerts.queue(
        await this.authorized(req, "alerts.read"),
        state ?? "",
        severity ?? "",
      ),
    );
  }
  @Get("alert-rules") alertRules(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.alerts.rules(await this.authorized(req, "alerts.read")),
    );
  }
  @Post("alert-rules") saveAlertRule(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "alerts.admin");
        this.csrf(req, actor);
        const input = z
          .object({
            id: uuid.optional(),
            code: z.string().regex(/^[A-Z0-9_.-]{2,80}$/),
            name: z.string().trim().min(2).max(120),
            sourceModule: z.string().trim().min(2).max(40),
            eventType: z.string().trim().min(2).max(120).optional(),
            metricCode: z.enum([
              "PLACEMENT_OVERDUE_MINUTES",
              "POD_AGE_DAYS",
              "INVOICE_OVERDUE_DAYS",
              "COMPLIANCE_EXPIRY_DAYS",
            ]),
            scopeNodeIds: z.array(uuid).max(100).default([]),
            threshold: z
              .object({ value: z.number().nonnegative() })
              .passthrough(),
            severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]),
            recipientPolicy: z.record(z.unknown()).default({}),
            channels: z
              .array(z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]))
              .min(1)
              .max(4),
            quietHours: z.record(z.unknown()).default({}),
            repeatPolicy: z.record(z.unknown()).default({}),
            escalationLevels: z.array(z.unknown()).max(20).default([]),
            acknowledgementRequired: z.boolean().default(true),
            resolutionCondition: z.record(z.unknown()).default({}),
            active: z.boolean().default(true),
            expectedVersion: z.number().int().positive().optional(),
          })
          .strict()
          .parse(body);
        return this.alerts.saveRule(
          actor,
          input,
          (req as Request & { correlationId?: string }).correlationId ??
            crypto.randomUUID(),
        );
      },
      201,
    );
  }
  @Post("alerts/:id/actions") alertAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const actor = await this.authorized(req, "alerts.admin");
      this.csrf(req, actor);
      const input = z
        .object({
          action: z.enum([
            "ACKNOWLEDGE",
            "ASSIGN",
            "COMMENT",
            "SNOOZE",
            "ESCALATE",
            "RESOLVE",
            "REOPEN",
          ]),
          reason: z.string().max(1000).optional(),
          ownerMembershipId: z.string().uuid().optional(),
          snoozedUntil: z.string().datetime().optional(),
          expectedVersion: z.number().int().positive(),
        })
        .strict()
        .parse(body);
      return this.alerts.act(
        actor,
        uuid.parse(id),
        input.action,
        input,
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : "",
        (req as Request & { correlationId?: string }).correlationId ??
          crypto.randomUUID(),
      );
    });
  }
  @Get("imports/status") importStatus(
    @Query("jobId") jobId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.data.status(
        await this.authorized(req, "data.import.admin"),
        jobId ? uuid.parse(jobId) : undefined,
      ),
    );
  }
  @Get("imports/:id/errors") importErrors(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.data.errors(
        await this.authorized(req, "data.import.admin"),
        uuid.parse(id),
      ),
    );
  }
  @Post("imports/preview") importPreview(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "data.import.admin");
        this.csrf(req, actor);
        const input = z
          .object({
            dataset: z.enum([
              "CLIENT",
              "LOCATION",
              "VENDOR",
              "INDENT_PLACEMENT",
              "POD",
              "INVOICE_COLLECTION",
              "PAYMENT_RECEIPT",
            ]),
            filename: z.string().min(1).max(240),
            mediaType: z.string().min(1).max(120),
            byteSize: z.number().int().nonnegative().max(25_000_000),
            checksum: z.string().regex(/^[a-f0-9]{64}$/),
            sourceTimezone: z.string().min(1).max(100),
            importMode: z.enum(["APPEND", "UPSERT", "FULL_FILE"]),
            headers: z.array(z.string().min(1)).min(1),
            rows: z.array(z.record(z.unknown())).max(10000),
          })
          .strict()
          .parse(body);
        return this.data.preview(actor, {
          ...input,
          idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
        });
      },
      201,
    );
  }
  @Post("imports/parse") importParse(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const actor = await this.authorized(req, "data.import.admin");
      this.csrf(req, actor);
      const input = z
        .object({
          filename: z.string().min(1).max(240),
          mediaType: z.string().min(1).max(120),
          contentBase64: z.string().min(1).max(34_000_000),
        })
        .strict()
        .parse(body);
      return this.data.parseFile(
        input.filename,
        input.mediaType,
        input.contentBase64,
      );
    });
  }
  @Post("imports/:id/commit") importCommit(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const actor = await this.authorized(req, "data.import.admin");
      this.csrf(req, actor);
      const input = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(body);
      return this.data.commit(actor, uuid.parse(id), input.expectedVersion);
    });
  }
  @Get("integrations") integrationList(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.integrations.endpoints(
        await this.authorized(req, "integrations.read"),
      ),
    );
  }
  @Get("integrations/:id/mappings") integrationMappings(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.integrations.mappings(
        await this.authorized(req, "integrations.read"),
        uuid.parse(id),
      ),
    );
  }
  @Post("integrations/:id/mappings") integrationMappingCreate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "integrations.admin");
        this.csrf(req, actor);
        const input = z
          .object({
            schema: z.record(z.unknown()),
            mapping: z.record(z.unknown()),
          })
          .strict()
          .parse(body);
        return this.integrations.createMapping(
          actor,
          uuid.parse(id),
          input,
          (req as Request & { correlationId?: string }).correlationId ??
            crypto.randomUUID(),
        );
      },
      201,
    );
  }
  @Post("integrations/api-clients") apiClientCreate(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "integrations.admin");
        this.csrf(req, actor);
        const input = z
          .object({
            code: z.string().regex(/^[A-Z0-9_-]{2,40}$/),
            name: z.string().trim().min(2).max(120),
            scopes: z.array(z.string().trim().min(2).max(120)).min(1).max(100),
            expiresAt: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .parse(body);
        return this.integrations.createApiClient(
          actor,
          input,
          (req as Request & { correlationId?: string }).correlationId ??
            crypto.randomUUID(),
        );
      },
      201,
    );
  }
  @Post("integrations/api-clients/:id/rotate") apiClientRotate(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const actor = await this.authorized(req, "integrations.admin");
      this.csrf(req, actor);
      return this.integrations.rotateApiClient(
        actor,
        uuid.parse(id),
        (req as Request & { correlationId?: string }).correlationId ??
          crypto.randomUUID(),
      );
    });
  }
  @Post("webhooks/:tenantCode/:clientCode") webhook(
    @Param("tenantCode") tenantCode: string,
    @Param("clientCode") clientCode: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            eventKey: z.string().trim().min(2).max(120),
            eventType: z.string().trim().min(2).max(120),
            payload: z.unknown(),
          })
          .strict()
          .parse(body);
        const auth = String(req.headers.authorization ?? "");
        if (!auth.startsWith("Bearer "))
          throw new AppError(
            401,
            "MACHINE_AUTH_FAILED",
            "Machine authentication failed",
          );
        return this.integrations.ingestWebhook({
          tenantCode: z
            .string()
            .regex(/^[A-Z0-9_-]{2,40}$/)
            .parse(tenantCode),
          clientCode: z
            .string()
            .regex(/^[A-Z0-9_-]{2,40}$/)
            .parse(clientCode),
          token: auth.slice(7),
          signature: z
            .string()
            .regex(/^[a-f0-9]{64}$/i)
            .parse(req.headers["x-webhook-signature"]),
          eventKey: input.eventKey,
          eventType: input.eventType,
          payload: input.payload,
          correlationId:
            (req as Request & { correlationId?: string }).correlationId ??
            crypto.randomUUID(),
        });
      },
      202,
    );
  }
  @Post("integrations") integrationCreate(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const actor = await this.authorized(req, "integrations.admin");
        this.csrf(req, actor);
        const input = z
          .object({
            code: z.string().regex(/^[A-Z0-9_-]{2,40}$/),
            type: z.enum([
              "API",
              "WEBHOOK",
              "NOTIFICATION",
              "GPS",
              "ACCOUNTING",
              "MIGRATION",
            ]),
            name: z.string().min(2).max(120),
            environment: z.string().min(2).max(40),
            endpoint: z
              .union([
                z.string().url(),
                z.string().regex(/^local:\/\/[a-z0-9/_-]+$/i),
              ])
              .optional(),
            credentialReference: z.string().min(3).max(240).optional(),
            scopes: z
              .array(z.string().trim().min(1).max(100))
              .max(50)
              .default([]),
            allowedEvents: z
              .array(z.string().trim().min(1).max(120))
              .max(100)
              .default([]),
            mappingVersion: z.number().int().positive().default(1),
            rateLimit: z.unknown().optional(),
            retryPolicy: z.unknown().optional(),
          })
          .strict()
          .parse(body);
        return this.integrations.createEndpoint(
          actor,
          input,
          typeof req.headers["idempotency-key"] === "string"
            ? req.headers["idempotency-key"]
            : "",
          (req as Request & { correlationId?: string }).correlationId ??
            crypto.randomUUID(),
        );
      },
      201,
    );
  }
  @Get("integrations/deliveries") deliveryList(
    @Query("state") state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.integrations.deliveries(
        await this.authorized(req, "integrations.read"),
        state ?? "",
      ),
    );
  }
  @Get("integrations/dead-letters") deadLetters(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.integrations.deadLetters(
        await this.authorized(req, "integrations.read"),
      ),
    );
  }
  @Get("integrations/health") integrationHealth(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.integrations.health(await this.authorized(req, "integrations.read")),
    );
  }
  @Post("integrations/dead-letters/:id/replay") replay(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const actor = await this.authorized(req, "integrations.replay");
      this.csrf(req, actor);
      const input = z
        .object({
          reason: z.string().min(5).max(1000),
          expectedVersion: z.number().int().positive(),
        })
        .strict()
        .parse(body);
      return this.integrations.replay(
        actor,
        uuid.parse(id),
        input.reason,
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : "",
        input.expectedVersion,
        (req as Request & { correlationId?: string }).correlationId ??
          crypto.randomUUID(),
      );
    });
  }
}
