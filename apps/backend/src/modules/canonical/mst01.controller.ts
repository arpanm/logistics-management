import {
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
import { z, ZodError } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { Mst01Service } from "./mst01.service.js";

const cookie = "logistics_session";
@Controller("domain/masters")
export class Mst01Controller {
  private readonly logger = new Logger(Mst01Controller.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(Mst01Service) private readonly service: Mst01Service,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  private async mutation(req: Request) {
    const actor = await this.actor(req);
    this.app.requireCsrf(
      actor,
      String(req.headers["x-csrf-token"] ?? ""),
      req.headers.origin,
    );
    return actor;
  }
  private correlation(req: Request) {
    return (
      (req as Request & { correlationId?: string }).correlationId ??
      crypto.randomUUID()
    );
  }
  private async run(
    res: Response,
    action: () => Promise<unknown>,
    status = 200,
  ) {
    try {
      const output = await action();
      if (res.headersSent) return;
      return res.status(status).json(output);
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
      this.logger.error(
        "MST-01 request failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      });
    }
  }
  @Get("postal-localities") postal(
    @Query("postalCode") pin: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.postal(
        await this.actor(req),
        z
          .string()
          .regex(/^[1-9][0-9]{5}$/)
          .parse(pin),
      ),
    );
  }
  @Post("test-controls/postal/fail-next") armPostalFailure(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({ postalCode: z.string().regex(/^[1-9][0-9]{5}$/) })
        .strict()
        .parse(body);
      return this.service.armPostalFailure(
        await this.mutation(req),
        input.postalCode,
      );
    });
  }
  @Post("test-controls/postal/stale-next") armPostalStale(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({ postalLocalityId: z.string().uuid() })
        .strict()
        .parse(body);
      return this.service.armPostalStaleSelection(
        await this.mutation(req),
        input.postalLocalityId,
      );
    });
  }
  @Post("test-controls/counts") testCounts(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      z.object({})
        .strict()
        .parse(body ?? {});
      return this.service.testCounts(await this.mutation(req));
    });
  }
  @Get("organization") organizations(
    @Query() rawQuery: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const query = z
        .object({
          query: z.string().trim().max(160).default(""),
          state: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z.enum(["ACTIVE", "INACTIVE"]).optional(),
          ),
          nodeType: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
              .enum(["LEGAL_ENTITY", "REGION", "BRANCH", "TEAM", "HUB"])
              .optional(),
          ),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .strict()
        .parse(rawQuery);
      return this.service.organizationView(
        await this.actor(req),
        undefined,
        query,
      );
    });
  }
  @Get("organization/:id") organization(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.organizationView(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Post("organization") createOrganization(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () =>
        this.service.createOrganization(
          await this.mutation(req),
          body,
          key ?? "",
          this.correlation(req),
        ),
      201,
    );
  }
  @Get("organization/:id/impact") organizationImpact(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.organizationImpact(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Post("organization/:id/exception-deactivate")
  organizationException(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.exceptionDeactivate(
        await this.mutation(req),
        "ORGANIZATION",
        z.string().uuid().parse(id),
        z
          .object({
            expectedVersion: z.number().int().positive(),
            impactSnapshotId: z.string().min(16),
            reason: z.string().trim().min(10).max(1000),
            reviewOwnerMembershipId: z.string().uuid().optional(),
            reviewBy: z.string().date(),
          })
          .strict()
          .parse(body),
        this.correlation(req),
        key ?? "",
      ),
    );
  }
  @Post("organization/:id/reassign-deactivate")
  reassignDeactivateOrganization(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.reassignDeactivateOrganization(
        await this.mutation(req),
        z.string().uuid().parse(id),
        z
          .object({
            replacementNodeId: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
            impactSnapshotId: z.string().min(16),
            reason: z.string().trim().min(5).max(1000),
          })
          .strict()
          .parse(body),
        this.correlation(req),
        key ?? "",
      ),
    );
  }
  @Patch("organization/:id") updateOrganization(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.updateOrganization(
        await this.mutation(req),
        z.string().uuid().parse(id),
        body,
        key ?? "",
        this.correlation(req),
      ),
    );
  }
  @Get("employees") employees(
    @Query() rawQuery: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const query = z
        .object({
          query: z.string().trim().max(160).default(""),
          state: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z.enum(["ACTIVE", "INACTIVE"]).optional(),
          ),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .strict()
        .parse(rawQuery);
      return this.service.employeeView(await this.actor(req), undefined, query);
    });
  }
  @Get("employees/:id") employee(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.employeeView(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Post("employees") createEmployee(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () =>
        this.service.createEmployee(
          await this.mutation(req),
          body,
          key ?? "",
          this.correlation(req),
        ),
      201,
    );
  }
  @Get("employees/:id/impact") employeeImpact(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.employeeImpact(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Post("employees/:id/exception-deactivate") employeeException(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.exceptionDeactivate(
        await this.mutation(req),
        "EMPLOYEE",
        z.string().uuid().parse(id),
        z
          .object({
            expectedVersion: z.number().int().positive(),
            impactSnapshotId: z.string().min(16),
            reason: z.string().trim().min(10).max(1000),
            reviewOwnerMembershipId: z.string().uuid().optional(),
            reviewBy: z.string().date(),
          })
          .strict()
          .parse(body),
        this.correlation(req),
        key ?? "",
      ),
    );
  }
  @Get("exceptions") exceptions(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.service.exceptionReport(await this.actor(req)),
    );
  }
  @Post("exceptions/:id/reactivate") reactivateException(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.reactivateException(
        await this.mutation(req),
        z.string().uuid().parse(id),
        z
          .object({ reason: z.string().trim().min(10).max(1000) })
          .strict()
          .parse(body).reason,
        this.correlation(req),
        key ?? "",
      ),
    );
  }
  @Get("ownership-report") ownershipReport(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.ownershipReport(await this.actor(req)),
    );
  }
  @Get("ownership-report/export") ownershipExport(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const report = await this.service.ownershipExport(
        await this.actor(req),
        this.correlation(req),
      );
      const escape = (value: unknown) => {
        const raw = String(value ?? "");
        const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
        return `"${safe.replaceAll('"', '""')}"`;
      };
      const content = [
        ["Generated at", report.generatedAt, "", "", ""],
        ["Resource type", "Code", "Name", "Owner", "Ownership"],
        ...report.items.map((item) => [
          item.resourceKind,
          item.code,
          item.name,
          item.ownerCode ?? "",
          item.ownershipState,
        ]),
      ]
        .map((row) => row.map(escape).join(","))
        .join("\n");
      res.type("text/csv").attachment("ownership-report.csv").send(content);
      return undefined;
    });
  }
  @Post("ownership-alerts/evaluate") evaluateOwnershipAlerts(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.evaluateOwnershipAlerts(await this.mutation(req)),
    );
  }
  @Patch("employees/:id") updateEmployee(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.updateEmployee(
        await this.mutation(req),
        z.string().uuid().parse(id),
        body,
        key ?? "",
        this.correlation(req),
      ),
    );
  }
}
