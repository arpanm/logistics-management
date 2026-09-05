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
  RawBodyRequest,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { conversationProposalActionSchema } from "@logistics/domain";
import { ConversationService } from "./conversation.service.js";
import { ConversationWhatsappService } from "./conversation-whatsapp.service.js";

const cookie = "logistics_session";
const correlation = (req: Request) =>
  (req as Request & { correlationId?: string }).correlationId ??
  crypto.randomUUID();
const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    meta?: { code?: string };
    cause?: unknown;
  };
  return (
    candidate.code === "P2002" ||
    candidate.code === "23505" ||
    candidate.meta?.code === "23505" ||
    isUniqueViolation(candidate.cause)
  );
};

class BaseController {
  constructor(
    protected readonly app: AppService,
    protected readonly service: ConversationService,
  ) {}
  protected actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  protected async mutation(req: Request) {
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
  protected async run(
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
            error.issues.map((issue) => [
              issue.path.join("."),
              [issue.message],
            ]),
          ),
        });
      if (error instanceof AppError)
        return res
          .status(error.status)
          .json({ code: error.code, message: error.message, correlationId });
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Request failed",
        correlationId,
      });
    }
  }
}

@Controller("conversations")
export class ConversationController extends BaseController {
  constructor(
    @Inject(AppService) app: AppService,
    @Inject(ConversationService) service: ConversationService,
    @Inject(ConversationWhatsappService)
    private readonly whatsapp: ConversationWhatsappService,
  ) {
    super(app, service);
  }
  @Get("whatsapp/status") whatsappStatus(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.whatsapp.status(await this.actor(req)),
    );
  }
  @Get("whatsapp/deliveries") whatsappDeliveries(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.whatsapp.deliveries(await this.actor(req)),
    );
  }
  @Patch("whatsapp/preferences") whatsappPreferences(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () => {
      const input = z
        .object({
          proactive: z.boolean(),
          quietStart: z
            .string()
            .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
            .nullable()
            .optional(),
          quietEnd: z
            .string()
            .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
            .nullable()
            .optional(),
          expectedVersion: z.number().int().min(0),
        })
        .strict()
        .parse(body);
      return this.whatsapp.updatePreference(
        await this.mutation(req),
        input,
        correlation(req),
        key ?? "",
      );
    });
  }
  @Post("whatsapp/unlink") whatsappUnlink(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () => {
      z.object({}).strict().parse(body);
      return this.whatsapp.unlink(
        await this.mutation(req),
        correlation(req),
        key ?? "",
      );
    });
  }
  @Get("capabilities") capabilities(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () => {
      return this.service.catalogFor(await this.actor(req));
    });
  }
  @Get("threads") list(@Req() req: Request, @Res() res: Response) {
    return this.run(req, res, async () =>
      this.service.list(await this.actor(req)),
    );
  }
  @Post("threads") create(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.create(await this.mutation(req), body, key ?? ""),
      201,
    );
  }
  @Get("threads/:threadId") detail(
    @Param("threadId") threadId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () =>
      this.service.detail(await this.actor(req), threadId),
    );
  }
  @Post("threads/:threadId/messages") submit(
    @Param("threadId") threadId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () =>
        this.service.submit(
          await this.mutation(req),
          threadId,
          body,
          correlation(req),
          key ?? "",
        ),
      201,
    );
  }
  @Post("proposals/:proposalId/confirm") confirm(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () => {
      const input = conversationProposalActionSchema.parse(body);
      return this.service.confirm(
        await this.mutation(req),
        proposalId,
        input.expectedVersion,
        key ?? "",
        correlation(req),
      );
    });
  }
  @Post("proposals/:proposalId/cancel") cancel(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(req, res, async () => {
      const input = conversationProposalActionSchema.parse(body);
      return this.service.cancel(
        await this.mutation(req),
        proposalId,
        input.expectedVersion,
      );
    });
  }
  @Post("whatsapp/link-challenges") link(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      req,
      res,
      async () => {
        z.object({}).strict().parse(body);
        return this.service.createWhatsappChallenge(await this.mutation(req));
      },
      201,
    );
  }
}

const webhook = z
  .object({
    entry: z.array(
      z
        .object({
          changes: z.array(
            z
              .object({
                value: z
                  .object({
                    messages: z
                      .array(
                        z
                          .object({
                            id: z.string().min(1).max(200),
                            from: z.string().regex(/^\+?[1-9][0-9]{7,14}$/),
                            type: z.enum(["text", "image", "document"]),
                            text: z
                              .object({
                                body: z.string().trim().min(1).max(8000),
                              })
                              .optional(),
                            image: z
                              .object({
                                id: z.string().min(1).max(200),
                                mime_type: z.string().max(120).optional(),
                                caption: z.string().max(8000).optional(),
                              })
                              .optional(),
                            document: z
                              .object({
                                id: z.string().min(1).max(200),
                                filename: z.string().max(180).optional(),
                                mime_type: z.string().max(120).optional(),
                                caption: z.string().max(8000).optional(),
                              })
                              .optional(),
                          })
                          .superRefine((message, context) => {
                            if (message.type === "text" && !message.text)
                              context.addIssue({
                                code: z.ZodIssueCode.custom,
                                path: ["text"],
                                message: "Text is required",
                              });
                            if (message.type === "image" && !message.image)
                              context.addIssue({
                                code: z.ZodIssueCode.custom,
                                path: ["image"],
                                message: "Image is required",
                              });
                            if (
                              message.type === "document" &&
                              !message.document
                            )
                              context.addIssue({
                                code: z.ZodIssueCode.custom,
                                path: ["document"],
                                message: "Document is required",
                              });
                          }),
                      )
                      .optional(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

@Controller("webhooks/whatsapp")
export class WhatsappWebhookController extends BaseController {
  constructor(
    @Inject(AppService) app: AppService,
    @Inject(ConversationService) service: ConversationService,
    @Inject(ConversationWhatsappService)
    private readonly whatsapp: ConversationWhatsappService,
  ) {
    super(app, service);
  }
  @Get() verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    if (
      this.app.config.WHATSAPP_PROVIDER !== "meta" ||
      mode !== "subscribe" ||
      !this.whatsapp.verifyToken(token)
    )
      return res.status(403).send("Forbidden");
    return res.status(200).send(challenge);
  }
  @Post() async receive(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    const correlationId = correlation(req);
    try {
      if (this.app.config.WHATSAPP_PROVIDER !== "meta")
        return res.status(404).json({ code: "WHATSAPP_DISABLED" });
      const raw = req.rawBody;
      if (!raw)
        return res
          .status(400)
          .json({ code: "RAW_BODY_REQUIRED", correlationId });
      const supplied = String(req.headers["x-hub-signature-256"] ?? "");
      if (!this.whatsapp.verifySignature(raw, supplied))
        return res
          .status(401)
          .json({ code: "SIGNATURE_INVALID", correlationId });
      const parsed = webhook.parse(req.body);
      const messages = parsed.entry.flatMap((entry) =>
        entry.changes.flatMap((change) => change.value.messages ?? []),
      );
      let retryRequired = false;
      const rejected: string[] = [];
      for (const message of messages) {
        const media =
          message.type === "image"
            ? message.image
            : message.type === "document"
              ? message.document
              : undefined;
        try {
          await this.whatsapp.receive(
            {
              id: message.id,
              from: message.from,
              text: message.text?.body ?? media?.caption ?? "Upload this file",
              media: media
                ? {
                    id: media.id,
                    filename:
                      "filename" in media && typeof media.filename === "string"
                        ? media.filename
                        : undefined,
                    mediaType: media.mime_type,
                    caption: media.caption,
                  }
                : undefined,
            },
            raw,
            correlationId,
          );
        } catch (error) {
          if (isUniqueViolation(error)) continue;
          if (error instanceof AppError && error.status < 500) {
            rejected.push(error.code);
            continue;
          }
          retryRequired = true;
          rejected.push(
            error instanceof AppError ? error.code : "INTERNAL_ERROR",
          );
        }
      }
      return res.status(retryRequired ? 503 : 200).json({
        accepted: !retryRequired,
        retryRequired,
        rejected,
      });
    } catch (error) {
      if (error instanceof ZodError)
        return res.status(400).json({ code: "WEBHOOK_INVALID", correlationId });
      if (error instanceof AppError)
        return res
          .status(error.status >= 500 ? 503 : 200)
          .json({ accepted: false, code: error.code, correlationId });
      if (isUniqueViolation(error))
        return res.status(200).json({ accepted: true, duplicate: true });
      return res.status(500).json({ code: "INTERNAL_ERROR", correlationId });
    }
  }
}
