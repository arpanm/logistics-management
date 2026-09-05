import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppError, AppService } from "../../app.service.js";

const MAX_MEDIA_BYTES = 5_000_000;
const providerMediaHosts = [
  "lookaside.fbsbx.com",
  "lookaside.facebook.com",
  "scontent.whatsapp.net",
];

export type MetaInboundMedia = {
  id: string;
  filename?: string;
  mediaType?: string;
  caption?: string;
};

export type DownloadedWhatsappAttachment = {
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  contentBase64: string;
  dataset?:
    | "CLIENT"
    | "LOCATION"
    | "VENDOR"
    | "INDENT_PLACEMENT"
    | "POD"
    | "INVOICE_COLLECTION"
    | "PAYMENT_RECEIPT";
  sourceTimezone?: string;
  importMode?: "APPEND" | "UPSERT" | "FULL_FILE";
};

@Injectable()
export class MetaWhatsappAdapter {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private endpoint(path: string) {
    return `https://graph.facebook.com/${this.app.config.WHATSAPP_GRAPH_API_VERSION}/${path}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.app.config.WHATSAPP_ACCESS_TOKEN}` };
  }

  async sendText(to: string, body: string): Promise<string> {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta")
      throw new AppError(409, "WHATSAPP_DISABLED", "WhatsApp is not enabled");
    const response = await fetch(
      this.endpoint(`${this.app.config.WHATSAPP_PHONE_NUMBER_ID}/messages`),
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to.replace(/^\+/, ""),
          type: "text",
          text: { preview_url: false, body: body.slice(0, 4096) },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new AppError(
        response.status === 429 || response.status >= 500 ? 503 : 502,
        response.status === 429
          ? "WHATSAPP_RATE_LIMITED"
          : "WHATSAPP_SEND_FAILED",
        "WhatsApp delivery failed",
      );
    const result = (await response.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const id = result.messages?.[0]?.id;
    if (!id)
      throw new AppError(
        502,
        "WHATSAPP_RESPONSE_INVALID",
        "WhatsApp delivery failed",
      );
    return id;
  }

  async sendTemplate(to: string, parameters: string[]): Promise<string> {
    if (this.app.config.WHATSAPP_PROVIDER !== "meta")
      throw new AppError(409, "WHATSAPP_DISABLED", "WhatsApp is not enabled");
    const response = await fetch(
      this.endpoint(`${this.app.config.WHATSAPP_PHONE_NUMBER_ID}/messages`),
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: this.app.config.WHATSAPP_ALERT_TEMPLATE_NAME,
            language: { code: this.app.config.WHATSAPP_TEMPLATE_LANGUAGE },
            components: [
              {
                type: "body",
                parameters: parameters.slice(0, 8).map((text) => ({
                  type: "text",
                  text: text.slice(0, 1024),
                })),
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new AppError(
        response.status === 429 || response.status >= 500 ? 503 : 502,
        response.status === 429
          ? "WHATSAPP_RATE_LIMITED"
          : "WHATSAPP_SEND_FAILED",
        "WhatsApp delivery failed",
      );
    const result = (await response.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const id = result.messages?.[0]?.id;
    if (!id)
      throw new AppError(
        502,
        "WHATSAPP_RESPONSE_INVALID",
        "WhatsApp delivery failed",
      );
    return id;
  }

  async downloadMedia(
    media: MetaInboundMedia,
  ): Promise<DownloadedWhatsappAttachment> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(media.id))
      throw new AppError(400, "WHATSAPP_MEDIA_ID_INVALID", "Media is invalid");
    const metadataResponse = await fetch(
      this.endpoint(encodeURIComponent(media.id)),
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!metadataResponse.ok)
      throw new AppError(
        502,
        "WHATSAPP_MEDIA_METADATA_FAILED",
        "Media could not be retrieved",
      );
    const metadata = (await metadataResponse.json()) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!metadata.url)
      throw new AppError(
        502,
        "WHATSAPP_MEDIA_METADATA_INVALID",
        "Media could not be retrieved",
      );
    const target = new URL(metadata.url);
    const hostAllowed = providerMediaHosts.some(
      (host) =>
        target.hostname === host || target.hostname.endsWith(`.${host}`),
    );
    if (target.protocol !== "https:" || !hostAllowed)
      throw new AppError(
        502,
        "WHATSAPP_MEDIA_HOST_INVALID",
        "Media host is not allowed",
      );
    if (metadata.file_size && metadata.file_size > MAX_MEDIA_BYTES)
      throw new AppError(
        413,
        "ATTACHMENT_TOO_LARGE",
        "Attachment is too large",
      );
    const mediaResponse = await fetch(target, {
      headers: this.headers(),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!mediaResponse.ok)
      throw new AppError(
        502,
        "WHATSAPP_MEDIA_DOWNLOAD_FAILED",
        "Media could not be retrieved",
      );
    const declared = Number(mediaResponse.headers.get("content-length") ?? 0);
    if (declared > MAX_MEDIA_BYTES)
      throw new AppError(
        413,
        "ATTACHMENT_TOO_LARGE",
        "Attachment is too large",
      );
    const content = Buffer.from(await mediaResponse.arrayBuffer());
    if (!content.length || content.length > MAX_MEDIA_BYTES)
      throw new AppError(
        413,
        "ATTACHMENT_TOO_LARGE",
        "Attachment is too large",
      );
    const mediaType =
      metadata.mime_type ?? media.mediaType ?? "application/octet-stream";
    const filename = (media.filename ?? `whatsapp-${media.id}`).slice(0, 180);
    const attachment: DownloadedWhatsappAttachment = {
      filename,
      mediaType,
      byteSize: content.length,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    };
    if (mediaType === "text/csv" || mediaType.includes("spreadsheetml")) {
      const caption = media.caption ?? "";
      const dataset = caption
        .match(
          /\bdataset\s+(CLIENT|LOCATION|VENDOR|INDENT_PLACEMENT|POD|INVOICE_COLLECTION|PAYMENT_RECEIPT)\b/i,
        )?.[1]
        ?.toUpperCase() as DownloadedWhatsappAttachment["dataset"];
      const sourceTimezone = caption.match(
        /\btimezone\s+([A-Za-z_]+\/[A-Za-z_]+)\b/i,
      )?.[1];
      const importMode = caption
        .match(/\bmode\s+(APPEND|UPSERT|FULL_FILE)\b/i)?.[1]
        ?.toUpperCase() as DownloadedWhatsappAttachment["importMode"];
      if (!dataset || !sourceTimezone || !importMode)
        throw new AppError(
          400,
          "IMPORT_METADATA_REQUIRED",
          "CSV/XLSX caption must include dataset, timezone, and mode",
        );
      Object.assign(attachment, { dataset, sourceTimezone, importMode });
    }
    return attachment;
  }
}
