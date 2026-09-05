import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppService } from "../../app.service.js";
import { MetaWhatsappAdapter } from "./conversation-whatsapp.adapter.js";

const config = {
  WHATSAPP_PROVIDER: "meta",
  WHATSAPP_GRAPH_API_VERSION: "v23.0",
  WHATSAPP_PHONE_NUMBER_ID: "123456",
  WHATSAPP_ACCESS_TOKEN: "provider-token-never-logged",
  WHATSAPP_ALERT_TEMPLATE_NAME: "logistics_operational_alert",
  WHATSAPP_TEMPLATE_LANGUAGE: "en",
};

describe("INT02-WA-006 Meta WhatsApp adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a provider media redirect to a non-provider host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: "https://attacker.example/file.csv",
            mime_type: "text/csv",
            file_size: 100,
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = new MetaWhatsappAdapter({
      config,
    } as unknown as AppService);
    await expect(
      adapter.downloadMedia({ id: "provider-media-1", filename: "safe.csv" }),
    ).rejects.toMatchObject({ code: "WHATSAPP_MEDIA_HOST_INVALID" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call Meta when the channel is disabled", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const adapter = new MetaWhatsappAdapter({
      config: { ...config, WHATSAPP_PROVIDER: "disabled" },
    } as unknown as AppService);
    await expect(
      adapter.sendText("+919999999999", "hello"),
    ).rejects.toMatchObject({
      code: "WHATSAPP_DISABLED",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
