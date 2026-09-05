export type ApiError = {
  code: string;
  message: string;
  correlationId?: string;
  fields?: Record<string, string[]>;
};
export type ApiRequestInit = RequestInit & {
  /** Explicitly pins asynchronous/multi-request form work to its submitter. */
  feedbackAnchor?: HTMLElement | null;
  /** Opts a confirmed create/update into shared success feedback. */
  successFeedback?: string;
};

export function mutationSuccessFeedback(
  method: string,
  message?: string,
): string | null {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return null;
  const normalized = message?.trim();
  return normalized ? normalized : null;
}
function mutationFeedbackAnchor() {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active.matches("button, input[type=submit], [role=button]"))
    return active;
  const form = active.closest("form");
  return (
    form?.querySelector<HTMLElement>(
      'button[type="submit"], button:not([type]), input[type="submit"]',
    ) ?? null
  );
}
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
  options: ApiRequestInit = {},
): Promise<T> {
  const {
    feedbackAnchor: explicitFeedbackAnchor,
    successFeedback,
    ...fetchOptions
  } = options;
  const method = (options.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const successMessage = mutationSuccessFeedback(method, successFeedback);
  // Snapshot the initiator before awaiting fetch. Concurrent requests must not
  // compete for one mutable "last clicked" control when their results arrive.
  const feedbackAnchor = mutation
    ? explicitFeedbackAnchor === undefined
      ? mutationFeedbackAnchor()
      : explicitFeedbackAnchor
    : null;
  const feedbackId = mutation
    ? typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
    : null;
  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...fetchOptions,
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
    if (typeof window !== "undefined" && mutation)
      window.dispatchEvent(
        new CustomEvent("logistics:api-result", {
          detail: {
            id: feedbackId,
            ok: false,
            error,
            anchor: feedbackAnchor,
          },
        }),
      );
    throw error;
  }
  if (typeof window !== "undefined" && mutation && successMessage)
    window.dispatchEvent(
      new CustomEvent("logistics:api-result", {
        detail: {
          id: feedbackId,
          ok: true,
          message: successMessage,
          anchor: feedbackAnchor,
        },
      }),
    );
  return response.json() as Promise<T>;
}
