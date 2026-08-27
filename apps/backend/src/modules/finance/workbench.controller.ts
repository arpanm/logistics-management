import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { AccessService } from "../../access.service.js";
import { AppError, AppService } from "../../app.service.js";
import { FinanceWorkbenchService } from "./workbench.service.js";

const uuid = z.string().uuid(),
  exact = z.string().regex(/^-?(0|[1-9]\d*)$/),
  nonNegative = z.string().regex(/^(0|[1-9]\d*)$/),
  cookie = "logistics_session";
@Controller("tenant/finance")
export class FinanceWorkbenchController {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FinanceWorkbenchService)
    private readonly service: FinanceWorkbenchService,
  ) {}
  private actor(req: Request) {
    return this.app.session(req.cookies?.[cookie]);
  }
  private async authorized(req: Request, write = false) {
    const actor = await this.actor(req);
    const effective = await this.access.effective(actor, this.correlation(req));
    if (
      !effective.capabilities.includes(write ? "finance.admin" : "finance.read")
    )
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    if (write)
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
  private async run(res: Response, fn: () => Promise<unknown>, status = 200) {
    try {
      return res.status(status).json(await fn());
    } catch (error) {
      if (error instanceof ZodError)
        return res.status(400).json({
          code: "VALIDATION_FAILED",
          message: "Check the highlighted fields",
          fields: Object.fromEntries(
            error.issues.map((i) => [i.path.join("."), [i.message]]),
          ),
        });
      if (error instanceof AppError)
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          fields: error.fields,
        });
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      });
    }
  }
  @Get("workbench") dashboard(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.service.dashboard(await this.authorized(req)),
    );
  }
  @Get("references") references(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.service.references(await this.authorized(req)),
    );
  }
  @Get("invoices") invoices(
    @Query("search") search: string | undefined,
    @Query("status") status: string | undefined,
    @Query("clientId") clientId: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.invoices(await this.authorized(req), {
        search: z.string().trim().max(120).default("").parse(search),
        status: z.string().trim().max(40).default("").parse(status),
        clientId: z
          .union([uuid, z.literal("")])
          .default("")
          .parse(clientId),
        from: z
          .union([z.string().date(), z.literal("")])
          .default("")
          .parse(from),
        to: z
          .union([z.string().date(), z.literal("")])
          .default("")
          .parse(to),
      }),
    );
  }
  @Get("receipts") receipts(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.service.receipts(await this.authorized(req)),
    );
  }
  @Post("receipts") createReceipt(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            receiptRef: z.string().trim().min(2).max(100),
            clientId: uuid,
            paymentDate: z.string().date(),
            amountMinor: nonNegative,
            mode: z.enum([
              "NEFT",
              "RTGS",
              "IMPS",
              "CHEQUE",
              "UPI",
              "ADJUSTMENT",
            ]),
            instrumentNo: z.string().trim().min(2).max(120),
            bankReference: z.string().trim().max(120).optional(),
          })
          .strict()
          .parse(body);
        return this.service.createReceipt(
          await this.authorized(req, true),
          input,
          this.correlation(req),
          idempotencyKey,
        );
      },
      201,
    );
  }
  @Post("invoices") create(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            invoiceNo: z.string().trim().min(2).max(80),
            invoiceDate: z.string().date(),
            clientId: uuid,
            clientLocationId: uuid,
            currency: z.string().regex(/^[A-Z]{3}$/),
            creditDays: z.number().int().min(0).max(365),
            lines: z
              .array(
                z
                  .object({
                    tripId: uuid,
                    podTaskId: uuid,
                    chargeCode: z.string().trim().min(1).max(80),
                    quantityMilli: nonNegative,
                    rateMinor: exact,
                    taxBasisPoints: z.number().int().min(0).max(10000),
                  })
                  .strict(),
              )
              .min(1)
              .max(500),
          })
          .strict()
          .parse(body);
        return this.service.createInvoice(
          await this.authorized(req, true),
          input,
          this.correlation(req),
          idempotencyKey,
        );
      },
      201,
    );
  }
  @Post("invoices/:id/actions") invoiceAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum([
            "SUBMIT",
            "APPROVE",
            "REJECT",
            "POST",
            "ACKNOWLEDGE",
            "REVERSE",
          ]),
          expectedVersion: z.number().int().positive(),
          acknowledgedAt: z.string().datetime({ offset: true }).optional(),
          reversalInvoiceNo: z.string().trim().min(2).max(80).optional(),
          reason: z.string().trim().min(3).max(1000).optional(),
        })
        .strict()
        .parse(body);
      return this.service.invoiceAction(
        await this.authorized(req, true),
        uuid.parse(id),
        input,
        this.correlation(req),
        idempotencyKey,
      );
    });
  }
  @Post("invoices/:id/update") updateInvoice(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          invoiceNo: z.string().trim().min(2).max(80),
          invoiceDate: z.string().date(),
          creditDays: z.number().int().min(0).max(365),
        })
        .strict()
        .parse(body);
      return this.service.updateInvoice(
        await this.authorized(req, true),
        uuid.parse(id),
        input,
        this.correlation(req),
        idempotencyKey,
      );
    });
  }
  @Post("invoices/:id/notes") invoiceNote(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            noteType: z.enum(["CREDIT_NOTE", "DEBIT_NOTE"]),
            amountMinor: z.string().regex(/^[1-9]\d*$/),
            reason: z.string().trim().min(3).max(1000),
          })
          .strict()
          .parse(body);
        return this.service.addInvoiceNote(
          await this.authorized(req, true),
          uuid.parse(id),
          input,
          this.correlation(req),
          idempotencyKey,
        );
      },
      201,
    );
  }
  @Post("invoices/:id/followups") followup(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            outcome: z.string().trim().min(2).max(80),
            note: z.string().trim().min(2).max(2000),
            promisedAt: z.string().date().optional(),
            promisedMinor: nonNegative.optional(),
            nextFollowupAt: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .parse(body);
        return this.service.followUp(
          await this.authorized(req, true),
          uuid.parse(id),
          input,
          this.correlation(req),
          idempotencyKey,
        );
      },
      201,
    );
  }
  @Post("vendor-bills/:id/actions") vendorAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum(["SUBMIT", "VERIFY", "APPROVE", "DISPUTE", "PAY"]),
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(3).max(1000).optional(),
          bankVersionId: uuid.optional(),
          amountMinor: nonNegative.optional(),
          batchNo: z.string().trim().min(2).max(80).optional(),
        })
        .strict()
        .parse(body);
      return this.service.vendorAction(
        await this.authorized(req, true),
        uuid.parse(id),
        input,
        this.correlation(req),
        idempotencyKey,
      );
    });
  }
  @Post("vendor-bills") createVendorBill(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            vendorInvoiceNo: z.string().trim().min(2).max(100),
            invoiceDate: z.string().date(),
            vendorId: uuid,
            gstMinor: nonNegative,
            deductionMinor: nonNegative.optional(),
            advanceMinor: nonNegative.optional(),
            lines: z
              .array(
                z.object({ tripId: uuid, claimedMinor: nonNegative }).strict(),
              )
              .min(1)
              .max(500),
          })
          .strict()
          .parse(body);
        return this.service.createVendorBill(
          await this.authorized(req, true),
          input,
          this.correlation(req),
          idempotencyKey,
        );
      },
      201,
    );
  }
  @Post("payment-runs/:id/actions") paymentAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum(["APPROVE", "SUBMIT", "MARK_PAID", "FAIL", "REVERSE"]),
          expectedVersion: z.number().int().positive(),
          utr: z.string().trim().min(3).max(120).optional(),
          reason: z.string().trim().min(3).max(1000).optional(),
        })
        .strict()
        .parse(body);
      return this.service.paymentBatchAction(
        await this.authorized(req, true),
        uuid.parse(id),
        input,
        this.correlation(req),
        idempotencyKey,
      );
    });
  }
}
