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
import { AppError, AppService } from "../../app.service.js";
import { AdvancedDomainService } from "./advanced.service.js";

const uuid = z.string().uuid();
const reason = z.string().trim().min(5).max(1000);
// JSON numbers cannot represent every PostgreSQL bigint exactly. Financial
// minor units therefore cross this API as canonical base-10 strings.
export const exactMinorSchema = z.string().regex(/^-?(0|[1-9]\d*)$/);
export const nonNegativeMinorSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const positiveMinorSchema = z.string().regex(/^[1-9]\d*$/);
const cookie = "logistics_session";

@Controller("domain/commands")
export class AdvancedDomainController {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AdvancedDomainService)
    private readonly service: AdvancedDomainService,
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
      return res.status(status).json(await action());
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
      return res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      });
    }
  }

  @Get("organization/:id/impact") impact(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.organizationImpact(await this.actor(req), uuid.parse(id)),
    );
  }
  @Post("organization/:id/move") move(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          parentId: uuid.nullable(),
          expectedVersion: z.number().int().positive(),
          reason,
        })
        .strict()
        .parse(body);
      return this.service.moveOrganization(
        await this.mutation(req),
        uuid.parse(id),
        input.parentId,
        input.expectedVersion,
        input.reason,
        this.correlation(req),
        idempotencyKey ?? "",
      );
    });
  }
  @Post("assignments/bulk") bulk(
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
            items: z
              .array(
                z
                  .object({
                    employeeId: uuid,
                    assignmentType: z.enum([
                      "MANAGER",
                      "KAM",
                      "TRAFFIC",
                      "QUEUE_OWNER",
                    ]),
                    organizationNodeId: uuid.optional(),
                    clientId: uuid.optional(),
                    effectiveFrom: z.string().datetime({ offset: true }),
                    effectiveTo: z
                      .string()
                      .datetime({ offset: true })
                      .optional(),
                    exceptionReason: z.string().trim().max(500).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(250),
          })
          .strict()
          .parse(body);
        return this.service.bulkAssignments(
          await this.mutation(req),
          input.items,
          idempotencyKey ?? "",
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("employees/:id/reassign-deactivate") reassignEmployee(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          replacementEmployeeId: uuid,
          expectedVersion: z.number().int().positive(),
          impactSnapshotId: z.string().min(16),
          reason,
        })
        .strict()
        .parse(body);
      return this.service.reassignEmployee(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
        idempotencyKey ?? "",
      );
    });
  }
  @Get("duplicates") duplicates(
    @Query("kind") kind: string,
    @Query("name") name: string,
    @Query("taxId") taxId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.duplicateCandidates(
        await this.actor(req),
        z.enum(["CLIENT", "VENDOR"]).parse(kind),
        z.string().trim().min(2).max(160).parse(name),
        taxId,
      ),
    );
  }
  @Post("contracts/:id/versions") contractVersion(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            expectedVersion: z.number().int().positive(),
            creditDays: z.number().int().min(0).max(365),
            podMode: z.enum(["PHYSICAL", "DIGITAL", "BOTH"]),
            documentRequirements: z.array(z.unknown()).max(100),
            terms: z.record(z.unknown()),
            reason,
          })
          .strict()
          .parse(body);
        return this.service.createContractVersion(
          await this.mutation(req),
          uuid.parse(id),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Get("contracts/versions") contractVersions(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.contractVersions(await this.actor(req), search ?? ""),
    );
  }
  @Post("vendors/:id/banks") bank(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            accountHolder: z.string().trim().min(2).max(160),
            accountNumber: z.string().regex(/^\d{6,34}$/),
            ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/),
          })
          .strict()
          .parse(body);
        return this.service.addVendorBank(
          await this.mutation(req),
          uuid.parse(id),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Get("vendors/:id/banks") banks(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.vendorBanks(await this.actor(req), uuid.parse(id)),
    );
  }
  @Post("vendor-banks/:id/decision") bankDecision(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          expectedState: z.literal("PENDING_VERIFICATION"),
          decision: z.enum(["VERIFIED", "REJECTED"]),
          reason,
        })
        .strict()
        .parse(body);
      return this.service.verifyVendorBank(
        await this.mutation(req),
        uuid.parse(id),
        input.expectedState,
        input.decision,
        input.reason,
        this.correlation(req),
      );
    });
  }
  @Post("compliance") compliance(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            subjectType: z.enum(["VENDOR", "VEHICLE", "DRIVER"]),
            subjectId: uuid,
            requirementCode: z.string().regex(/^[A-Z0-9_.-]{2,80}$/),
            documentId: uuid.optional(),
            validFrom: z.string().date().optional(),
            validTo: z.string().date().optional(),
          })
          .strict()
          .parse(body);
        return this.service.upsertCompliance(
          await this.mutation(req),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("compliance/:id/decision") complianceDecision(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({ decision: z.enum(["VERIFIED", "REJECTED"]), reason })
        .strict()
        .parse(body);
      return this.service.decideCompliance(
        await this.mutation(req),
        uuid.parse(id),
        input.decision,
        input.reason,
        this.correlation(req),
      );
    });
  }
  @Get("compliance/:type/:id") complianceList(
    @Param("type") type: string,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.complianceRecords(
        await this.actor(req),
        z.enum(["VENDOR", "VEHICLE", "DRIVER"]).parse(type),
        uuid.parse(id),
      ),
    );
  }
  @Get("eligibility/:type/:id") eligibility(
    @Param("type") type: string,
    @Param("id") id: string,
    @Query("contextId") contextId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.eligibility(
        await this.actor(req),
        z.enum(["VENDOR", "VEHICLE", "DRIVER"]).parse(type),
        uuid.parse(id),
        contextId ? uuid.parse(contextId) : undefined,
      ),
    );
  }
  @Post("eligibility/override") eligibilityOverride(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            subjectType: z.enum(["VENDOR", "VEHICLE", "DRIVER"]),
            subjectId: uuid,
            contextType: z.string().trim().min(2).max(40),
            contextId: uuid,
            reason,
            expiresAt: z.string().datetime({ offset: true }),
            approvedBy: uuid,
          })
          .strict()
          .parse(body);
        return this.service.overrideEligibility(
          await this.mutation(req),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }

  @Post("indents/:id/cancel") cancelIndent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          cancelledVehicles: z.number().int().positive(),
          vendorCostMinor: nonNegativeMinorSchema.default("0"),
          expectedVersion: z.number().int().positive(),
          reason,
        })
        .strict()
        .parse(body);
      return this.service.cancelIndent(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Post("allocations/:id/respond") respond(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          decision: z.enum(["ACCEPTED", "REJECTED"]),
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000).optional(),
        })
        .strict()
        .parse(body);
      return this.service.respondOffer(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Post("pod/:id/review") pod(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum([
            "RECEIVE",
            "START_REVIEW",
            "ACCEPT",
            "REJECT",
            "REQUEST_CORRECTION",
            "SUBMIT",
          ]),
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000).optional(),
          invoiceReference: z.string().trim().min(1).max(80).optional(),
          invoiceDate: z.string().date().optional(),
          invoiceValueMinor: nonNegativeMinorSchema.optional(),
        })
        .strict()
        .parse(body);
      return this.service.reviewPod(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Post("gps/observations") gps(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            deviceId: z.string().trim().min(2).max(100),
            tripId: uuid,
            eventKey: z.string().trim().min(2).max(120),
            observedAt: z.string().datetime({ offset: true }),
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            speedKph: z.number().min(0).max(300).optional(),
            odometerKm: z.number().nonnegative().optional(),
          })
          .strict()
          .parse(body);
        return this.service.ingestGps(
          await this.mutation(req),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Get("gps/health") gpsHealth(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () =>
      this.service.gpsHealth(await this.actor(req)),
    );
  }

  @Post("invoices/:id/acknowledge") acknowledge(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          acknowledgedAt: z.string().datetime({ offset: true }),
          evidence: z.record(z.unknown()).default({}),
        })
        .strict()
        .parse(body);
      return this.service.acknowledgeInvoice(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Post("invoices/:id/reverse") reverseInvoice(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            expectedVersion: z.number().int().positive(),
            reversalInvoiceNo: z.string().trim().min(2).max(80),
            reason,
          })
          .strict()
          .parse(body);
        return this.service.reverseInvoice(
          await this.mutation(req),
          uuid.parse(id),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("invoices/:id/notes") invoiceNote(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            noteType: z.enum(["CREDIT_NOTE", "DEBIT_NOTE"]),
            amountMinor: exactMinorSchema,
            reason,
            evidence: z.record(z.unknown()).default({}),
          })
          .strict()
          .parse(body);
        return this.service.addInvoiceNote(
          await this.mutation(req),
          uuid.parse(id),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("receipts/:receiptId/entries/:entryId/reverse") reverseReceipt(
    @Param("receiptId") receiptId: string,
    @Param("entryId") entryId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z.object({ reason }).strict().parse(body);
      return this.service.reverseReceiptEntry(
        await this.mutation(req),
        uuid.parse(receiptId),
        uuid.parse(entryId),
        input.reason,
        this.correlation(req),
      );
    });
  }
  @Post("invoices/:id/followups") followup(
    @Param("id") id: string,
    @Body() body: unknown,
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
            promisedMinor: positiveMinorSchema.optional(),
            nextFollowupAt: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .parse(body);
        return this.service.addCollectionFollowup(
          await this.mutation(req),
          uuid.parse(id),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("vendor-bills") vendorBill(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            vendorId: uuid,
            vendorInvoiceNo: z.string().trim().min(2).max(80),
            invoiceDate: z.string().date(),
            gstMinor: nonNegativeMinorSchema,
            tdsMinor: nonNegativeMinorSchema,
            deductionMinor: nonNegativeMinorSchema.default("0"),
            advanceMinor: nonNegativeMinorSchema.default("0"),
            lines: z
              .array(
                z
                  .object({
                    tripId: uuid,
                    claimedMinor: nonNegativeMinorSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
          })
          .strict()
          .parse(body);
        return this.service.createVendorBill(
          await this.mutation(req),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Post("vendor-bills/:id/decision") vendorBillDecision(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum(["VERIFY", "APPROVE", "DISPUTE"]),
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000).optional(),
        })
        .strict()
        .parse(body);
      return this.service.decideVendorBill(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Post("payment-batches") paymentBatch(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(
      res,
      async () => {
        const input = z
          .object({
            batchNo: z.string().trim().min(2).max(80),
            bankVersionId: uuid,
            allocations: z
              .array(
                z
                  .object({
                    vendorBillId: uuid,
                    amountMinor: positiveMinorSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
          })
          .strict()
          .parse(body);
        return this.service.createPaymentBatch(
          await this.mutation(req),
          input,
          this.correlation(req),
        );
      },
      201,
    );
  }
  @Get("payment-batches") paymentBatches(
    @Query("search") search: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.paymentBatches(await this.actor(req), search ?? ""),
    );
  }
  @Post("payment-batches/:id/transition") paymentTransition(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum(["APPROVE", "SUBMIT", "MARK_PAID", "FAIL", "REVERSE"]),
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000).optional(),
          utr: z.string().trim().min(3).max(80).optional(),
        })
        .strict()
        .parse(body);
      return this.service.transitionPaymentBatch(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
  @Get("accounting/reconciliation") accounting(
    @Query("state") state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () =>
      this.service.accountingReconciliation(await this.actor(req), state ?? ""),
    );
  }
  @Post("accounting/reconciliation/:id/action") accountingAction(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, async () => {
      const input = z
        .object({
          action: z.enum([
            "MARK_EXPORTED",
            "ACKNOWLEDGE",
            "FAIL",
            "RETRY",
            "REVERSE",
          ]),
          expectedVersion: z.number().int().positive(),
          externalReference: z.string().trim().max(160).optional(),
          safeErrorCode: z
            .string()
            .regex(/^[A-Z0-9_.-]{2,80}$/)
            .optional(),
          reason: z.string().trim().min(5).max(1000).optional(),
        })
        .strict()
        .parse(body);
      return this.service.updateAccounting(
        await this.mutation(req),
        uuid.parse(id),
        input,
        this.correlation(req),
      );
    });
  }
}
