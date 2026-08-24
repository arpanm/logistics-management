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
import { z, ZodError } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { AccessService } from "../../access.service.js";
import { KernelService } from "./kernel.service.js";

const recordSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(160),
  data: z.record(z.unknown()).default({}),
  effectiveFrom: z.string().min(1).nullable().optional(),
  effectiveTo: z.string().min(1).nullable().optional(),
});
const updateSchema = recordSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });
const transitionSchema = z.object({
  toStatus: z.string().trim().min(2).max(40),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});
const commentSchema = z.object({ body: z.string().trim().min(1).max(4000) });
const documentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(120),
  objectKey: z.string().trim().min(3).max(500),
  byteSize: z.number().int().nonnegative(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const sessionCookie = "logistics_session";
const correlationId = (req: Request) =>
  typeof req.headers["x-correlation-id"] === "string"
    ? req.headers["x-correlation-id"]
    : crypto.randomUUID();

@Controller("modules")
export class KernelController {
  private readonly logger = new Logger(KernelController.name);
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(KernelService) private readonly kernel: KernelService,
  ) {}

  private actor(req: Request) {
    return this.app.session(req.cookies?.[sessionCookie]);
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

  private capability(moduleKey: string, resource: string, write: boolean) {
    if (moduleKey === "alerts" && resource === "alert")
      return write ? "alerts.admin" : "alerts.read";
    if (moduleKey === "integrations" && resource === "delivery")
      return write ? "integrations.admin" : "integrations.read";
    return undefined;
  }

  private async authorizedResource(
    req: Request,
    moduleKey: string,
    resource: string,
    write: boolean,
  ) {
    const actor = write ? await this.mutate(req) : await this.actor(req);
    const capability = this.capability(moduleKey, resource, write);
    if (capability) {
      const effective = await this.access.effective(actor, correlationId(req));
      if (!effective.capabilities.includes(capability))
        throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    }
    return actor;
  }

  private async run(
    req: Request,
    res: Response,
    action: () => Promise<unknown>,
    success = 200,
  ) {
    const requestId = correlationId(req);
    try {
      return res.status(success).json(await action());
    } catch (error) {
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          correlationId: requestId,
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
          correlationId: requestId,
        });
      this.logger.error(
        "Module kernel request failed",
        error instanceof Error ? error.stack : undefined,
      );
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        correlationId: requestId,
      });
    }
  }

  @Get()
  manifests(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () => {
      await this.actor(req);
      return this.kernel.manifests();
    });
  }

  @Get(":moduleKey/:resource/manifest")
  metadata(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () => {
      await this.actor(req);
      return this.kernel.metadata(moduleKey, resource);
    });
  }

  @Get(":moduleKey/:resource/report")
  report(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.kernel.report(
        await this.authorizedResource(req, moduleKey, resource, false),
        moduleKey,
        resource,
      ),
    );
  }

  @Get(":moduleKey/:resource")
  list(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Query("search") search: string | undefined,
    @Query("status") status: string | undefined,
    @Query("page") page: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.kernel.list(
        await this.authorizedResource(req, moduleKey, resource, false),
        moduleKey,
        resource,
        search,
        status,
        Number(page ?? 1),
      ),
    );
  }

  @Post(":moduleKey/:resource")
  create(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () => {
        const actor = await this.authorizedResource(
          req,
          moduleKey,
          resource,
          true,
        );
        return this.kernel.create(
          actor,
          moduleKey,
          resource,
          recordSchema.parse(body),
          correlationId(req),
          typeof req.headers["idempotency-key"] === "string"
            ? req.headers["idempotency-key"]
            : undefined,
        );
      },
      201,
    );
  }

  @Get(":moduleKey/:resource/:id")
  detail(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.kernel.detail(
        await this.authorizedResource(req, moduleKey, resource, false),
        moduleKey,
        resource,
        z.string().uuid().parse(id),
      ),
    );
  }

  @Patch(":moduleKey/:resource/:id")
  update(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.kernel.update(
        await this.authorizedResource(req, moduleKey, resource, true),
        moduleKey,
        resource,
        z.string().uuid().parse(id),
        updateSchema.parse(body),
        correlationId(req),
      ),
    );
  }

  @Post(":moduleKey/:resource/:id/transition")
  transition(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.kernel.transition(
        await this.authorizedResource(req, moduleKey, resource, true),
        moduleKey,
        resource,
        z.string().uuid().parse(id),
        transitionSchema.parse(body),
        correlationId(req),
      ),
    );
  }

  @Post(":moduleKey/:resource/:id/comments")
  comment(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.kernel.addComment(
          await this.authorizedResource(req, moduleKey, resource, true),
          moduleKey,
          resource,
          z.string().uuid().parse(id),
          commentSchema.parse(body).body,
        ),
      201,
    );
  }

  @Post(":moduleKey/:resource/:id/documents")
  document(
    @Param("moduleKey") moduleKey: string,
    @Param("resource") resource: string,
    @Body() body: unknown,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.kernel.addDocument(
          await this.authorizedResource(req, moduleKey, resource, true),
          moduleKey,
          resource,
          z.string().uuid().parse(id),
          documentSchema.parse(body),
        ),
      201,
    );
  }
}
