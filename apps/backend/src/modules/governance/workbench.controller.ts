import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { GovernanceWorkbenchService } from "./workbench.service.js";
const cookie = "logistics_session";
const correlation = (req: Request) =>
  typeof req.headers["x-correlation-id"] === "string"
    ? req.headers["x-correlation-id"]
    : crypto.randomUUID();
@Controller("governance-workbench")
export class GovernanceWorkbenchController {
  private readonly logger = new Logger(GovernanceWorkbenchController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(GovernanceWorkbenchService)
    private readonly service: GovernanceWorkbenchService,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  private async mutation(req: Request) {
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
    fn: () => Promise<unknown>,
    status = 200,
  ) {
    const correlationId = correlation(req);
    try {
      return res.status(status).json(await fn());
    } catch (error) {
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
        return res
          .status(error.status)
          .json({ code: error.code, message: error.message, correlationId });
      this.logger.error(
        "Governance workbench failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Request failed",
        correlationId,
      });
    }
  }
  @Get("policies") list(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () =>
      this.service.list(await this.actor(req)),
    );
  }
  @Get("policies/roles") roles(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () =>
      this.service.roles(await this.actor(req)),
    );
  }
  @Post("policies") create(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.create(
          await this.mutation(req),
          body,
          typeof req.headers["idempotency-key"] === "string"
            ? req.headers["idempotency-key"]
            : "",
          correlation(req),
        ),
      201,
    );
  }
  @Patch("policies/:id") update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.update(
        await this.mutation(req),
        z.string().uuid().parse(id),
        body,
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : "",
        correlation(req),
      ),
    );
  }
}
