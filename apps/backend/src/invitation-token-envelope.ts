import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const envelopeVersion = "v1";

export type OwnerInvitationTokenEnvelope = {
  version: typeof envelopeVersion;
  tenantId: string;
  invitationId: string;
  token: string;
  expiresAt: string;
};

const encryptionKey = (encodedKey: string) => {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32)
    throw new Error(
      "EMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return key;
};

const associatedData = (tenantId: string, invitationId: string) =>
  Buffer.from(`owner-invitation\0${tenantId}\0${invitationId}`, "utf8");

export function sealOwnerInvitationToken(
  input: Omit<OwnerInvitationTokenEnvelope, "version">,
  encodedKey: string,
): string | null {
  if (!encodedKey) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(encodedKey),
    nonce,
  );
  cipher.setAAD(associatedData(input.tenantId, input.invitationId));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({ version: envelopeVersion, ...input }),
      "utf8",
    ),
    cipher.final(),
  ]);
  return [envelopeVersion, nonce, cipher.getAuthTag(), encrypted]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(".");
}

export function openOwnerInvitationToken(
  envelope: string,
  tenantId: string,
  invitationId: string,
  encodedKey: string,
): OwnerInvitationTokenEnvelope {
  const [version, nonceValue, tagValue, encryptedValue, extra] =
    envelope.split(".");
  if (
    version !== envelopeVersion ||
    !nonceValue ||
    !tagValue ||
    !encryptedValue ||
    extra
  )
    throw new Error("Invitation token envelope is invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(encodedKey),
    Buffer.from(nonceValue, "base64url"),
  );
  decipher.setAAD(associatedData(tenantId, invitationId));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as Partial<OwnerInvitationTokenEnvelope>;
  if (
    payload.version !== envelopeVersion ||
    payload.tenantId !== tenantId ||
    payload.invitationId !== invitationId ||
    typeof payload.token !== "string" ||
    payload.token.length < 32 ||
    typeof payload.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(payload.expiresAt))
  )
    throw new Error("Invitation token envelope payload is invalid");
  return payload as OwnerInvitationTokenEnvelope;
}
