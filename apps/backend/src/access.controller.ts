import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import {
  accessAcceptSchema,
  accessInviteSchema,
  accessLifecycleSchema,
  accessMutationSchema,
  accessPreviewSchema,
  policyOperationSchema,
  probeAccessCreateSchema,
  probeAccessUpdateSchema,
  probeReassignSchema,
  roleMutationSchema,
  csvCell,
} from "@logistics/domain";
import { AppError, AppService } from "./app.service.js";
import { AccessService } from "./access.service.js";

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
const sessionCookie = "logistics_session";

@Controller()
export class AccessController {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}
  private async actor(req: Request, allowRestricted = false) {
    return this.app.session(req.cookies?.[sessionCookie], allowRestricted);
  }
  private csrf(
    req: Request,
    actor: Awaited<ReturnType<AccessController["actor"]>>,
  ) {
    this.app.requireCsrf(
      actor,
      typeof req.headers["x-csrf-token"] === "string"
        ? req.headers["x-csrf-token"]
        : undefined,
      req.headers.origin,
    );
  }
  private cookie(res: Response, value: string, csrf: string) {
    const common = {
      sameSite: "lax" as const,
      secure: this.app.config.APP_ENV === "production",
      path: "/",
      maxAge: this.app.config.SESSION_TTL_HOURS * 3600000,
    };
    res.cookie(sessionCookie, value, { ...common, httpOnly: true });
    res.cookie("logistics_csrf", csrf, { ...common, httpOnly: false });
  }
  private async run(
    res: Response,
    req: Request,
    fn: () => Promise<unknown>,
    status = 200,
  ) {
    try {
      if (req.params.id && !z.string().uuid().safeParse(req.params.id).success)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      return res.status(status).json(await fn());
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
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId,
      });
    }
  }

  @Get("auth/access-invitations/:token/preview")
  invitationPreview(
    @Param("token") token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, () => this.access.invitationPreview(token));
  }
  @Post("auth/access-invitations/:token/accept")
  invitationAccept(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const input = accessAcceptSchema.parse(body);
      const result = await this.access.acceptInvitation(
        token,
        input,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return {
        activeTenantId: result.activeTenantId,
        contextVersion: result.contextVersion,
        home: result.home,
        mfaRequired: result.mfaRequired,
      };
    });
  }

  @Get("tenant/access/effective")
  effective(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.effective(await this.actor(req), requestId(req)),
    );
  }
  @Get("tenant/access/capabilities")
  capabilities(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.capabilities(await this.actor(req)),
    );
  }
  @Get("tenant/access/scopes")
  scopes(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.access.scopes(await this.actor(req), search ?? ""),
    );
  }
  @Get("tenant/access/roles")
  roles(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.listRoles(await this.actor(req), requestId(req)),
    );
  }
  @Post("tenant/access/roles")
  createRole(
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
        return this.access.createRole(
          actor,
          roleMutationSchema.parse(body),
          key,
          requestId(req),
        );
      },
      201,
    );
  }
  @Patch("tenant/access/roles/:id")
  updateRole(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = roleMutationSchema
        .refine(
          (value) =>
            value.expectedVersion !== undefined && Boolean(value.reason),
          { message: "Expected version and reason are required" },
        )
        .parse(body);
      return this.access.updateRole(
        actor,
        id,
        input as typeof input & { expectedVersion: number; reason: string },
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/roles/:id/deactivate")
  deactivateRole(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.deactivateRole(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        key,
        requestId(req),
      );
    });
  }
  @Get("tenant/access/users")
  users(
    @Query("search") search: string | undefined,
    @Query("status") status: string | undefined,
    @Query("page") page: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.access.listUsers(
        await this.actor(req),
        search ?? "",
        status ?? "",
        Number(page ?? 1),
        requestId(req),
      ),
    );
  }
  @Post("tenant/access/users")
  invite(
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
        return this.access.invite(
          actor,
          accessInviteSchema.parse(body),
          key,
          requestId(req),
        );
      },
      201,
    );
  }
  @Get("tenant/access/users/:id")
  user(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.userDetail(await this.actor(req), id, requestId(req)),
    );
  }
  @Post("tenant/access/users/:id/preview")
  preview(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      return this.access.preview(
        actor,
        id,
        accessPreviewSchema.parse(body),
        requestId(req),
      );
    });
  }
  @Patch("tenant/access/users/:id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      return this.access.updateAccess(
        actor,
        id,
        accessMutationSchema.parse(body),
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/users/:id/suspend")
  suspend(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.lifecycle(id, body, key, "SUSPENDED", req, res);
  }
  @Post("tenant/access/users/:id/reactivate")
  reactivate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.lifecycle(id, body, key, "ACTIVE", req, res);
  }
  private lifecycle(
    id: string,
    body: unknown,
    key: string,
    state: "ACTIVE" | "SUSPENDED",
    req: Request,
    res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.lifecycle(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        state,
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/users/:id/sessions/reset")
  resetSessions(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.resetSessions(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/users/:id/mfa/reset")
  resetMfa(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.resetMfa(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/users/:id/invitations/resend")
  resendInvitation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.resendInvitation(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        key,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/users/:id/invitations/revoke")
  revokeInvitation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.revokeInvitation(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        key,
        requestId(req),
      );
    });
  }

  @Get("tenant/access/probes")
  probes(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.access.listProbes(
        await this.actor(req),
        search ?? "",
        requestId(req),
      ),
    );
  }
  @Get("tenant/access/probes/export")
  async exportProbes(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const rows = await this.access.exportProbes(
        await this.actor(req),
        search ?? "",
        requestId(req),
      );
      const csv = [
        "Label,Status,Resource type",
        ...rows.map((row) =>
          [
            csvCell(String(row.label)),
            csvCell(String(row.status)),
            csvCell(String(row.resourceType)),
          ].join(","),
        ),
      ].join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="access-proof.csv"',
      );
      return res.status(200).send(`\uFEFF${csv}`);
    } catch (error) {
      return this.run(res, req, async () => {
        throw error;
      });
    }
  }
  @Post("tenant/access/probes")
  createProbe(
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
        return this.access.createProbe(
          actor,
          probeAccessCreateSchema.parse(body),
          key,
          requestId(req),
        );
      },
      201,
    );
  }
  @Get("tenant/access/probes/:id")
  probe(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.probe(await this.actor(req), id, requestId(req)),
    );
  }
  @Patch("tenant/access/probes/:id")
  updateProbe(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      return this.access.updateProbe(
        actor,
        id,
        probeAccessUpdateSchema.parse(body),
        requestId(req),
      );
    });
  }
  @Post("tenant/access/probes/:id/approve")
  approveProbe(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = accessLifecycleSchema.parse(body);
      return this.access.approveProbe(
        actor,
        id,
        input.expectedVersion,
        input.reason,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/probes/:id/reassign")
  reassignProbe(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = probeReassignSchema.parse(body);
      return this.access.reassignProbe(
        actor,
        id,
        input.expectedVersion,
        input.assignedUserId,
        input.reason,
        requestId(req),
      );
    });
  }
  @Post("tenant/access/operations/preview")
  previewOperation(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = policyOperationSchema.parse(body);
      return this.access.previewOperation(
        actor,
        input.capability,
        input.action,
        input.resourceId,
        requestId(req),
      );
    });
  }
  @Get("tenant/access/reports/:type")
  report(
    @Param("type") type: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.access.reports(await this.actor(req), type, requestId(req)),
    );
  }
  @Get("tenant/access/reports/:type/export")
  reportExport(
    @Param("type") type: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () =>
      this.access.reportExport(await this.actor(req), type, requestId(req)),
    );
  }
  @Get("tenant/access/alerts")
  alerts(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () =>
      this.access.alerts(await this.actor(req), requestId(req)),
    );
  }
  @Post("tenant/access/alerts/:id/:action")
  updateAlert(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req);
      this.csrf(req, actor);
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(10).max(500),
        })
        .strict()
        .parse(body);
      const state =
        action === "acknowledge"
          ? "ACKNOWLEDGED"
          : action === "resolve"
            ? "RESOLVED"
            : null;
      if (!state) throw new AppError(404, "NOT_FOUND", "Resource not found");
      return this.access.updateAlert(
        actor,
        z.string().uuid().parse(id),
        input.expectedVersion,
        state,
        input.reason,
        requestId(req),
      );
    });
  }
  @Post("auth/mfa/totp/setup")
  setupMfa(@Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req, true);
      this.csrf(req, actor);
      return this.access.setupMfa(actor, requestId(req));
    });
  }
  @Post("auth/mfa/totp/confirm")
  confirmMfa(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req, true);
      this.csrf(req, actor);
      const input = z
        .object({
          factorId: z.string().uuid(),
          codes: z.tuple([
            z.string().regex(/^\d{6}$/),
            z.string().regex(/^\d{6}$/),
          ]),
        })
        .strict()
        .parse(body);
      const result = await this.access.confirmMfa(
        actor,
        input.factorId,
        input.codes,
        requestId(req),
      );
      return result;
    });
  }
  @Post("auth/mfa/recovery/acknowledge")
  acknowledgeRecovery(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req, true);
      this.csrf(req, actor);
      const input = z
        .object({ factorId: z.string().uuid(), acknowledged: z.literal(true) })
        .strict()
        .parse(body);
      const result = await this.access.acknowledgeRecoveryCodes(
        actor,
        input.factorId,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return { verified: true, contextVersion: result.contextVersion };
    });
  }
  @Post("auth/mfa/challenge")
  challengeMfa(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req, true);
      this.csrf(req, actor);
      const input = z
        .object({ code: z.string().regex(/^\d{6}$/) })
        .strict()
        .parse(body);
      const result = await this.access.challengeMfa(
        actor,
        input.code,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return { verified: true, contextVersion: result.contextVersion };
    });
  }
  @Post("auth/mfa/recovery")
  recoverMfa(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.run(res, req, async () => {
      const actor = await this.actor(req, true);
      this.csrf(req, actor);
      const input = z
        .object({ recoveryCode: z.string().min(8).max(64) })
        .strict()
        .parse(body);
      const result = await this.access.recoverMfa(
        actor,
        input.recoveryCode,
        requestId(req),
      );
      this.cookie(res, result.sessionToken, result.csrfToken);
      return { verified: true, contextVersion: result.contextVersion };
    });
  }
}
