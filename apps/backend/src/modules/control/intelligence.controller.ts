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
            endpoint: z.string().url().optional(),
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
