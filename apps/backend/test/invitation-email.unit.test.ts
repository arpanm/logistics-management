import { readFileSync } from "node:fs";
import { loadConfig } from "@logistics/config";
import { describe, expect, it } from "vitest";
import {
  classifySesFailure,
  ownerInvitationEmail,
} from "../src/invitation-email.service.js";
import {
  openOwnerInvitationToken,
  sealOwnerInvitationToken,
} from "../src/invitation-token-envelope.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const invitationId = "00000000-0000-4000-8000-000000000002";
const key = Buffer.alloc(32, 7).toString("base64");
const baseEnvironment = {
  NODE_ENV: "production",
  APP_ENV: "production",
  DATABASE_URL: "postgresql://app:password@database.example.com/logistics",
  FRONTEND_URL: "https://13.61.27.202",
  AUTH_SECRET: "a-production-auth-secret-value",
  PLATFORM_ADMIN_PASSWORD: "a-production-admin-password",
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
  EMAIL_DELIVERY_PROVIDER: "ses",
  AWS_REGION: "eu-north-1",
  SES_FROM_EMAIL: "mukh.bad@gmail.com",
  EMAIL_TOKEN_ENCRYPTION_KEY: key,
} satisfies NodeJS.ProcessEnv;
const deliverySource = readFileSync(
  new URL("../src/invitation-email.service.ts", import.meta.url),
  "utf8",
);

describe("INT-01 SES owner invitation delivery (Implemented / Not Run)", () => {
  it("INT01-SES-U-001 validates production SES configuration fail closed", () => {
    expect(loadConfig(baseEnvironment)).toMatchObject({
      EMAIL_DELIVERY_PROVIDER: "ses",
      AWS_REGION: "eu-north-1",
      SES_FROM_EMAIL: "mukh.bad@gmail.com",
    });
    expect(() =>
      loadConfig({ ...baseEnvironment, EMAIL_TOKEN_ENCRYPTION_KEY: "" }),
    ).toThrow("EMAIL_TOKEN_ENCRYPTION_KEY");
    expect(() =>
      loadConfig({ ...baseEnvironment, FRONTEND_URL: "http://13.61.27.202" }),
    ).toThrow("HTTPS");
    expect(() =>
      loadConfig({ ...baseEnvironment, FRONTEND_URL: "https://127.0.0.1" }),
    ).toThrow("non-loopback");
  });

  it("INT01-SES-U-002 builds safe SES text and HTML", () => {
    const command = ownerInvitationEmail({
      from: "mukh.bad@gmail.com",
      to: "owner@example.com",
      tenantName: "Tenant\r\n<script>alert(1)</script>",
      activationUrl:
        "https://13.61.27.202/accept-invitation?token=one-time-token",
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
    });
    const input = command.input;
    const subject = input.Content?.Simple?.Subject?.Data ?? "";
    const html = input.Content?.Simple?.Body?.Html?.Data ?? "";
    const text = input.Content?.Simple?.Body?.Text?.Data ?? "";

    expect(input.FromEmailAddress).toBe("mukh.bad@gmail.com");
    expect(input.Destination?.ToAddresses).toEqual(["owner@example.com"]);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).toContain("Tenant &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.match(/accept-invitation\?token=/g)).toHaveLength(1);
    expect(text.match(/accept-invitation\?token=/g)).toHaveLength(1);
  });

  it("INT01-SES-U-003 retries only known pre-acceptance failures", () => {
    expect(
      classifySesFailure({
        name: "ThrottlingException",
        $metadata: { requestId: "provider-rejection-id", httpStatusCode: 429 },
      }),
    ).toMatchObject({ code: "SES_THROTTLINGEXCEPTION", retryable: true });
    expect(
      classifySesFailure({
        name: "TimeoutError",
        $metadata: { requestId: "ambiguous-provider-receipt" },
      }).retryable,
    ).toBe(false);
    expect(classifySesFailure({ name: "ECONNRESET" })).toEqual({
      code: "DELIVERY_OUTCOME_UNKNOWN",
      retryable: false,
    });
    expect(classifySesFailure({ name: "MessageRejected" }).retryable).toBe(
      false,
    );
  });

  it("INT01-SES-U-004 reuses one authenticated token envelope across safe retries", () => {
    const token = "a-secure-one-time-activation-token-value-1234567890";
    const expiresAt = "2026-08-30T12:00:00.000Z";
    const envelope = sealOwnerInvitationToken(
      { tenantId, invitationId, token, expiresAt },
      key,
    )!;

    expect(envelope).not.toContain(token);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        openOwnerInvitationToken(envelope, tenantId, invitationId, key),
      ).toMatchObject({ token, expiresAt });
    expect(() =>
      openOwnerInvitationToken(
        envelope,
        "00000000-0000-4000-8000-000000000009",
        invitationId,
        key,
      ),
    ).toThrow();
    expect(deliverySource).toContain("TOKEN_MATERIAL_UNAVAILABLE");
  });
});
