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
import { ZodError } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { AccessMastersService } from "./access-masters.service.js";

const sessionCookie = "logistics_session";
const correlation = (req: Request) =>
  typeof req.headers["x-correlation-id"] === "string"
    ? req.headers["x-correlation-id"]
    : crypto.randomUUID();

@Controller()
export class AccessMastersController {
  private readonly logger = new Logger(AccessMastersController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AccessMastersService)
    private readonly service: AccessMastersService,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[sessionCookie]);
  }
  private async mutationActor(req: Request) {
    const actor = await this.actor(req);
    this.app.requireCsrf(
      actor,
      typeof req.headers["x-csrf-token"] === "string"
        ? req.headers["x-csrf-token"]
        : undefined,
      req.headers.origin,
    );
    return actor;
  }
  private async run(
    req: Request,
    res: Response,
    action: () => Promise<unknown>,
    status = 200,
  ) {
    const correlationId = correlation(req);
    try {
      return res.status(status).json(await action());
    } catch (error) {
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          correlationId,
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
          correlationId,
          fields: error.fields,
        });
      this.logger.error(
        "Access/master remediation request failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId,
      });
    }
  }
  @Get("tenant/access/remediation/users")
  directory(
    @Query() query: Record<string, string | undefined>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.directory(await this.actor(req), {
        ...query,
        page: Number(query.page ?? 1),
        pageSize: Number(query.pageSize ?? 25),
      }),
    );
  }
  @Get("tenant/access/remediation/users/:id")
  dossier(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () =>
      this.service.userDossier(await this.actor(req), id),
    );
  }
  @Patch("tenant/access/remediation/users/:id/profile")
  updateProfile(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.updateProfile(
        await this.mutationActor(req),
        id,
        body,
        key,
        correlation(req),
      ),
    );
  }
  @Get("domain/master-admin/catalogs/:kind")
  catalogs(
    @Param("kind") kind: string,
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.catalogs(await this.actor(req), kind, search),
    );
  }
  @Post("domain/master-admin/catalogs")
  createCatalog(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.createCatalog(
          await this.mutationActor(req),
          body,
          key,
          correlation(req),
        ),
      201,
    );
  }
  @Post("domain/master-admin/:resource")
  createEnhanced(
    @Param("resource") resource: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.createEnhanced(
          await this.mutationActor(req),
          resource,
          body,
          key,
          correlation(req),
        ),
      201,
    );
  }
}
