import {
  All,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  checklistSchema,
  csvCell,
  fnd02FixtureSchema,
  inviteAcceptSchema,
  lifecycleSchema,
  loginSchema,
  membershipFixtureSchema,
  probeCreateSchema,
  probeUpdateSchema,
  postalLocalityQuerySchema,
  switchTenantSchema,
  tenantCreateSchemaFor,
} from "@logistics/domain";
import { AppError, AppService } from "./app.service.js";

const sessionCookie = "logistics_session";
const requestId = (req: Request) => {
  const cached = (req as Request & { correlationId?: string }).correlationId;
  if (cached) return cached;
  const value =
    typeof req.headers["x-correlation-id"] === "string"
      ? req.headers["x-correlation-id"]
      : crypto.randomUUID();
  (req as Request & { correlationId?: string }).correlationId = value;
  return value;
};

@Controller()
export class ApiController {
  private readonly logger = new Logger(ApiController.name);
  constructor(@Inject(AppService) private readonly service: AppService) {}
  private cookie(res: Response, value: string, csrf: string) {
    const common = {
      sameSite: "lax" as const,
      secure: this.service.config.APP_ENV === "production",
      path: "/",
      maxAge: this.service.config.SESSION_TTL_HOURS * 3600000,
    };
    res.cookie(sessionCookie, value, { ...common, httpOnly: true });
    res.cookie("logistics_csrf", csrf, { ...common, httpOnly: false });
  }
  private clear(res: Response) {
    const common = {
      sameSite: "lax" as const,
      secure: this.service.config.APP_ENV === "production",
      path: "/",
    };
    res.clearCookie(sessionCookie, { ...common, httpOnly: true });
    res.clearCookie("logistics_csrf", { ...common, httpOnly: false });
  }
  private async run(
    res: Response,
    req: Request,
    fn: () => Promise<unknown>,
    success = 200,
  ) {
    try {
      const value = await fn();
      return res.status(success).json(value);
    } catch (error) {
      const correlationId = requestId(req);
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          correlationId,
          fields: Object.fromEntries(
            error.issues.map((i) => [i.path.join("."), [i.message]]),
          ),
        });
      if (error instanceof AppError)
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          correlationId,
          fields: error.fields,
        });
      this.logger.error(
        "Unhandled API request failure",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId,
      });
    }
  }
  private async actor(req: Request) {
    return this.service.session(req.cookies?.[sessionCookie]);
  }
  private csrf(
    req: Request,
    actor: Awaited<ReturnType<ApiController["actor"]>>,
  ) {
    this.service.requireCsrf(
      actor,
      typeof req.headers["x-csrf-token"] === "string"
        ? req.headers["x-csrf-token"]
        : undefined,
      req.headers.origin,
    );
  }

  @Get("health/live") live(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, () => this.service.live());
  }
  @Get("health/ready") ready(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, () => this.service.ready());
  }
  @Post("auth/login") login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const input = loginSchema.parse(body);
      const result = await this.service.login(
        input.identifier ?? input.email!,
        input.password,
        input.tenantCode,
        requestId(req),
      );
      if ("requiresTenantSelection" in result) return result;
      this.cookie(res, result.sessionToken, result.csrfToken);
      return {
        user: result.user,
        activeTenantId: result.activeTenantId,
        contextVersion: result.contextVersion,
        mfaRequired: result.mfaRequired,
        mfaEnrolled: result.mfaEnrolled,
      };
    });
  }
  @Post("auth/logout") logout(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const value = await this.service.logout(actor, requestId(req));
      this.clear(res);
      return value;
    });
  }
  @Get("auth/me") me(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.service.me(await this.actor(req)),
    );
  }
  @Get("auth/invitations/:token/preview") invitePreview(
    @Param("token") token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, () => this.service.invitationPreview(token));
  }
  @Post("auth/invitations/:token/accept") inviteAccept(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const input = inviteAcceptSchema.parse(body);
      const result = await this.service.acceptInvitation(
        token,
        input.displayName,
        input.password,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return {
        user: result.user,
        activeTenantId: result.activeTenantId,
        contextVersion: result.contextVersion,
      };
    });
  }
  @Post("session/active-tenant") switchTenant(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = switchTenantSchema.parse(body);
      const result = await this.service.switchTenant(
        actor,
        input.tenantId,
        input.expectedContextVersion,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return {
        activeTenantId: result.activeTenantId,
        contextVersion: result.contextVersion,
      };
    });
  }

  @Get("platform/tenants") listTenants(
    @Query("search") search: string | undefined,
    @Query("status") status: string | undefined,
    @Query("page") page: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.listTenants(
        await this.actor(req),
        search ?? "",
        status ?? "",
        Number(page ?? 1),
      ),
    );
  }
  @Get("reference/postal-localities") postalLocalities(
    @Query("country") country: string | undefined,
    @Query("postalCode") postalCode: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      const query = postalLocalityQuerySchema.parse({ country, postalCode });
      return this.service.postalLocalities(
        actor,
        query.country,
        query.postalCode,
      );
    });
  }
  @Post("platform/tenants") createTenant(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Headers("x-test-failure") failure: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      req,
      async () => {
        const actor = await this.actor(req);
        this.csrf(req, actor);
        const tenantSchema = tenantCreateSchemaFor(
          this.service.config.SUPPORTED_COUNTRIES.split(","),
          this.service.config.SUPPORTED_CURRENCIES.split(","),
        );
        return this.service.provision(
          actor,
          tenantSchema.parse(body),
          key,
          requestId(req),
          failure === "provision-after-defaults",
        );
      },
      201,
    );
  }
  @Get("platform/tenants/:id") tenantDetail(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.tenantDetail(await this.actor(req), id),
    );
  }
  @Post("platform/tenants/:id/owner-invitation/reissue")
  reissueOwnerInvitation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = lifecycleSchema.parse(body);
      return this.service.reissueOwnerInvitation(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        requestId(req),
        key,
        req.headers.origin ?? this.service.config.FRONTEND_URL,
      );
    });
  }
  @Post("platform/tenants/:id/deactivate") deactivate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = lifecycleSchema.parse(body);
      return this.service.lifecycle(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        "INACTIVE",
        requestId(req),
        key,
        input.confirmationCode,
      );
    });
  }
  @Post("platform/tenants/:id/reactivate") reactivate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = lifecycleSchema.parse(body);
      return this.service.lifecycle(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        "ACTIVE",
        requestId(req),
        key,
      );
    });
  }
  @Get("platform/report") report(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.service.platformReport(await this.actor(req)),
    );
  }
  @Get("platform/alerts") alerts(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.service.alerts(await this.actor(req)),
    );
  }

  @Get("tenant/context") tenantContext(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.tenantContext(await this.actor(req)),
    );
  }
  @Patch("tenant/setup/:key") updateSetup(
    @Param("key") key: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = checklistSchema.parse(body);
      return this.service.updateChecklist(
        actor,
        key,
        input.expectedVersion,
        input.state,
        requestId(req),
      );
    });
  }
  @Get("tenant/probes/export") async exportProbes(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const actor = await this.actor(req);
      const rows = await this.service.exportProbes(actor, search ?? "");
      const csv = [
        "Label,Note,Created at",
        ...rows.map((r) =>
          [
            csvCell(String(r.label)),
            csvCell(String(r.note)),
            csvCell(String(r.createdAt)),
          ].join(","),
        ),
      ].join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="isolation-records.csv"',
      );
      return res.status(200).send(`\uFEFF${csv}`);
    } catch (error) {
      return this.run(res, req, async () => {
        throw error;
      });
    }
  }
  @Get("tenant/probes/template") async probeExportTemplate(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const actor = await this.actor(req);
      this.service.requireTenant(actor);
      const csv = [
        "Label,Note,Created at",
        [
          csvCell("Sample delivery proof"),
          csvCell("Tenant-scoped example record"),
          csvCell("2026-01-15T10:30:00.000Z"),
        ].join(","),
      ].join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="isolation-records-sample.csv"',
      );
      return res.status(200).send(`\uFEFF${csv}`);
    } catch (error) {
      return this.run(res, req, async () => {
        throw error;
      });
    }
  }
  @Get("tenant/probes/report") probeReport(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.probeReport(await this.actor(req)),
    );
  }
  @Get("tenant/probes") listProbes(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.listProbes(await this.actor(req), search ?? ""),
    );
  }
  @Post("tenant/probes") createProbe(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      req,
      async () => {
        const actor = await this.actor(req);
        this.csrf(req, actor);
        const input = probeCreateSchema.parse(body);
        return this.service.createProbe(
          actor,
          input.label,
          input.note,
          requestId(req),
          key,
        );
      },
      201,
    );
  }
  @Get("tenant/probes/:id/document") async document(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const actor = await this.actor(req);
      const doc = await this.service.probeDocument(actor, id);
      res.setHeader("Content-Type", String(doc.mediaType));
      res.setHeader("Content-Length", String(doc.byteLength));
      res.setHeader("X-Content-SHA256", String(doc.sha256));
      return res.status(200).send(doc.content);
    } catch (error) {
      return this.run(res, req, async () => {
        throw error;
      });
    }
  }
  @Get("tenant/probes/:id") getProbe(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.service.getProbe(await this.actor(req), id),
    );
  }
  @Patch("tenant/probes/:id") updateProbe(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = probeUpdateSchema.parse(body);
      if (!input.expectedVersion)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Expected version is required",
        );
      return this.service.updateProbe(
        actor,
        id,
        { ...input, expectedVersion: input.expectedVersion },
        requestId(req),
      );
    });
  }

  @Post("test/memberships/status") membershipFixture(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      return this.service.setMembershipFixture(
        actor,
        membershipFixtureSchema.parse(body),
        requestId(req),
      );
    });
  }

  @Post("test/fnd02/fixtures") fnd02Fixture(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      req,
      async () => {
        const actor = await this.actor(req);
        this.csrf(req, actor);
        return this.service.createFnd02Fixture(
          actor,
          fnd02FixtureSchema.parse(body),
          key,
          requestId(req),
        );
      },
      201,
    );
  }

  @All("*path") missing(@Req() req: Request, @Res() res: Response) {
    return res.status(404).json({
      code: "NOT_FOUND",
      message: "Resource not found",
      correlationId: requestId(req),
    });
  }
}
