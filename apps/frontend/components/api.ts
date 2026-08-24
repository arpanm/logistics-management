export type ApiError = {
  code: string;
  message: string;
  correlationId?: string;
  fields?: Record<string, string[]>;
};
export function csrfToken() {
  if (typeof document === "undefined") return "";
  return decodeURIComponent(
    document.cookie
      .split("; ")
      .find((v) => v.startsWith("logistics_csrf="))
      ?.split("=")
      .slice(1)
      .join("=") ?? "",
  );
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    let error: ApiError = {
      code: "REQUEST_FAILED",
      message: "The request could not be completed",
    };
    try {
      error = await response.json();
    } catch {}
    throw error;
  }
  return response.json() as Promise<T>;
}
