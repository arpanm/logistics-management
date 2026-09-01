"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export type TenantFormat = { locale: string; timezone: string };

function browserFormat(): TenantFormat {
  if (typeof Intl === "undefined") return { locale: "en", timezone: "UTC" };
  const options = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: options.locale || "en",
    timezone: options.timeZone || "UTC",
  };
}

export function useTenantFormat() {
  const [format, setFormat] = useState<TenantFormat>(browserFormat);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ tenant: { locale: string; timezone: string } }>(
      "/tenant/context",
      { signal: controller.signal },
    )
      .then(({ tenant }) =>
        setFormat({ locale: tenant.locale, timezone: tenant.timezone }),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return format;
}
