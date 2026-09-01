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
import { ZodError, z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { CanonicalService } from "./canonical.service.js";
import { OperationalWorkerService } from "./workers.service.js";

const sessionCookie = "logistics_session";
const correlation = (req: Request) =>
  typeof req.headers["x-correlation-id"] === "string"
    ? req.headers["x-correlation-id"]
    : crypto.randomUUID();

@Controller("domain")
export class CanonicalController {
  private readonly logger = new Logger(CanonicalController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(CanonicalService) private readonly canonical: CanonicalService,
    @Inject(OperationalWorkerService)
    private readonly workers: OperationalWorkerService,
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
  @Post("workers/run")
  runWorkers(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () => {
      const actor = await this.mutationActor(req);
      const input = z
        .object({ limit: z.number().int().min(1).max(250).default(50) })
        .strict()
        .parse(body);
      return this.workers.run(actor, input.limit);
    });
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
        "Canonical domain request failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId,
      });
    }
  }

  @Get(":resource/report")
  report(
    @Param("resource") resource: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.report(await this.actor(req), resource),
    );
  }
  @Get("governance/approval-definitions")
  approvalDefinitions(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () =>
      this.canonical.approvalDefinitions(await this.actor(req)),
    );
  }
  @Get(":resource")
  list(
    @Param("resource") resource: string,
    @Query("search") search: string | undefined,
    @Query("state") state: string | undefined,
    @Query("page") page: string | undefined,
    @Query("pageSize") pageSize: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.list(
        await this.actor(req),
        resource,
        search,
        state,
        z.coerce.number().int().min(1).default(1).parse(page),
        z.coerce.number().int().min(10).max(100).default(50).parse(pageSize),
      ),
    );
  }
  @Post(":resource")
  create(
    @Param("resource") resource: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.create(
          await this.mutationActor(req),
          resource,
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Get(":resource/:id")
  detail(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.detail(
        await this.actor(req),
        resource,
        z.string().uuid().parse(id),
      ),
    );
  }
  @Post(":resource/:id/transition")
  transition(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.transition(
        await this.mutationActor(req),
        resource,
        z.string().uuid().parse(id),
        body,
        this.key(req),
        correlation(req),
      ),
    );
  }
  @Post("trips/:id/events")
  tripEvent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.appendTripEvent(
          await this.mutationActor(req),
          z.string().uuid().parse(id),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("trips/create")
  createTrip(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.createTrip(
          await this.mutationActor(req),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("allocations/:id/assign")
  assignAllocation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.assignAllocation(
          await this.mutationActor(req),
          z.string().uuid().parse(id),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("receipts/:id/allocations")
  receiptAllocation(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.allocateReceipt(
          await this.mutationActor(req),
          z.string().uuid().parse(id),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Get("governance/documents")
  governedDocuments(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.documents(await this.actor(req), search ?? ""),
    );
  }
  @Post("governance/documents")
  uploadDocument(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.uploadDocument(
          await this.mutationActor(req),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("governance/documents/:id/access")
  documentAccess(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.issueDocumentAccess(
          await this.mutationActor(req),
          z.string().uuid().parse(id),
          correlation(req),
        ),
      201,
    );
  }
  @Get("governance/documents/download/:token")
  downloadDocument(
    @Param("token") token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.downloadDocument(
        await this.actor(req),
        z.string().min(40).max(200).parse(token),
      ),
    );
  }
  @Get("governance/comments/:targetType/:targetId")
  comments(
    @Param("targetType") targetType: string,
    @Param("targetId") targetId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.listGovernedComments(
        await this.actor(req),
        z.string().min(2).max(80).parse(targetType),
        z.string().uuid().parse(targetId),
      ),
    );
  }
  @Post("governance/comments")
  comment(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.addGovernedComment(
          await this.mutationActor(req),
          body,
          correlation(req),
        ),
      201,
    );
  }
  @Post("governance/comments/:id/update")
  updateComment(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.updateGovernedComment(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        correlation(req),
      ),
    );
  }
  @Post("governance/approval-definitions")
  createApprovalDefinition(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.createApprovalDefinition(
          await this.mutationActor(req),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("governance/approvals")
  requestApproval(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.requestApproval(
          await this.mutationActor(req),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
  @Post("governance/approvals/:id/decisions")
  decideApproval(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.decideApproval(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        correlation(req),
      ),
    );
  }
  @Post("configurations/:id/publish")
  publishConfiguration(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.canonical.publishConfiguration(
        await this.mutationActor(req),
        z.string().uuid().parse(id),
        body,
        this.key(req),
        correlation(req),
      ),
    );
  }
  @Post("configurations/:id/rollback")
  rollbackConfiguration(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.canonical.rollbackConfiguration(
          await this.mutationActor(req),
          z.string().uuid().parse(id),
          body,
          this.key(req),
          correlation(req),
        ),
      201,
    );
  }
}
