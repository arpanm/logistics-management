import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { controlLens, ControlWorkbenchService } from "./workbench.service.js";
const cookie = "logistics_session";
@Controller("control-workbench")
export class ControlWorkbenchController {
  private readonly logger = new Logger(ControlWorkbenchController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(ControlWorkbenchService)
    private readonly service: ControlWorkbenchService,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  private async mutate(req: Request) {
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
    try {
      return res.status(status).json(await fn());
    } catch (error) {
      const correlationId = crypto.randomUUID();
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          correlationId,
        });
      if (error instanceof AppError)
        return res
          .status(error.status)
          .json({ code: error.code, message: error.message, correlationId });
      this.logger.error(
        "Control workbench failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Request failed",
        correlationId,
      });
    }
  }
  @Get(":lens") dashboard(
    @Param("lens") lens: string,
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.dashboard(
        await this.actor(req),
        controlLens.parse(lens),
        query,
      ),
    );
  }
  @Get(":lens/export") exportCsv(
    @Param("lens") lens: string,
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.exportCsv(
        await this.actor(req),
        controlLens.parse(lens),
        query,
      ),
    );
  }
  @Get(":lens/views") views(
    @Param("lens") lens: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.views(await this.actor(req), controlLens.parse(lens)),
    );
  }
  @Post(":lens/views") save(
    @Param("lens") lens: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.saveView(
          await this.mutate(req),
          controlLens.parse(lens),
          body,
        ),
      201,
    );
  }
}
