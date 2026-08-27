import {
  Body,
  Controller,
  Get,
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
import { ZodError, z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { OperationsWorkbenchService } from "./operations-workbench.service.js";

const sessionCookie = "logistics_session";
const requestId = (req: Request) =>
  typeof req.headers["x-correlation-id"] === "string"
    ? req.headers["x-correlation-id"]
    : crypto.randomUUID();

@Controller("operations")
export class OperationsWorkbenchController {
  private readonly logger = new Logger(OperationsWorkbenchController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(OperationsWorkbenchService)
    private readonly operations: OperationsWorkbenchService,
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
  private key(req: Request) {
    return typeof req.headers["idempotency-key"] === "string"
      ? req.headers["idempotency-key"]
      : "";
  }
  private async run(
    req: Request,
    res: Response,
    action: () => Promise<unknown>,
    status = 200,
  ) {
    const correlationId = requestId(req);
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
        "Operations workbench request failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId,
      });
    }
  }

  @Get("dashboard") dashboard(
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.dashboard(await this.actor(req), query),
    );
  }
  @Get("indents") indents(
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.indents(await this.actor(req), query),
    );
  }
  @Post("indents") createIndent(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.operations.createIndent(
          await this.mutationActor(req),
          body,
          this.key(req),
          requestId(req),
        ),
      201,
    );
  }
  @Post("indents/:id/transition") updateIndent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.updateIndent(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Patch("indents/:id") editIndent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.editIndent(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Get("indents/:id/eligible-vendors") eligible(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.eligibleVendors(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Get("allocations") allocations(
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.allocations(await this.actor(req), query),
    );
  }
  @Post("allocations/manual") manual(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.operations.manualAllocation(
          await this.mutationActor(req),
          body,
          this.key(req),
          requestId(req),
        ),
      201,
    );
  }
  @Post("allocations/:id/transition") updateAllocation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.updateAllocation(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Post("allocations/:id/assign") assign(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.assign(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Get("allocations/:id/eligible-assets") eligibleAssets(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.eligibleAssets(
        await this.actor(req),
        z.string().uuid().parse(id),
      ),
    );
  }
  @Get("trips") trips(
    @Query() query: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.trips(await this.actor(req), query),
    );
  }
  @Post("trips") createTrip(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.operations.createTrip(
          await this.mutationActor(req),
          body,
          this.key(req),
          requestId(req),
        ),
      201,
    );
  }
  @Post("trips/:id/action") tripAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.tripAction(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Post("trips/:id/transition") updateTrip(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.updateTrip(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Get("auto-allocation-rules") rules(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.rules(await this.actor(req)),
    );
  }
  @Post("auto-allocation-rules") createRule(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.operations.saveRule(
          await this.mutationActor(req),
          null,
          body,
          this.key(req),
          requestId(req),
        ),
      201,
    );
  }
  @Patch("auto-allocation-rules/:id") updateRule(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.saveRule(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        requestId(req),
      ),
    );
  }
  @Get("auto-allocation-rules/:ruleId/preview/:indentId") preview(
    @Param("ruleId") ruleId: string,
    @Param("indentId") indentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.operations.previewRule(
        await this.actor(req),
        z.string().uuid().parse(ruleId),
        z.string().uuid().parse(indentId),
      ),
    );
  }
  @Post("auto-allocation-rules/:ruleId/execute/:indentId") execute(
    @Param("ruleId") ruleId: string,
    @Param("indentId") indentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.operations.executeRule(
          await this.mutationActor(req),
          z.string().uuid().parse(ruleId),
          z.string().uuid().parse(indentId),
          this.key(req),
          requestId(req),
        ),
      201,
    );
  }
}
