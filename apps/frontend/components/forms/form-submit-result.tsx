import type { ApiError } from "../api";
import type { ReactNode } from "react";

type FormSubmitResultProps = {
  children: ReactNode;
  error?: ApiError | string | null;
  success?: string | null;
  busy?: boolean;
};

/**
 * Keeps the outcome of a mutation beside the control that initiated it. This
 * is intentionally separate from page-level load errors, which may still be
 * rendered at the top of a workspace.
 */
export function FormSubmitResult({
  children,
  error,
  success,
  busy = false,
}: FormSubmitResultProps) {
  const apiError = typeof error === "string" ? null : error;
  const message = typeof error === "string" ? error : apiError?.message;

  return (
    <div className="form-submit-row" aria-busy={busy || undefined}>
      <div className="form-submit-actions">{children}</div>
      {message ? (
        <div className="form-submit-result form-submit-error" role="alert">
          <strong>{message}</strong>
          {apiError?.fields &&
            Object.entries(apiError.fields).map(([field, messages]) => (
              <span key={field}>
                {field}: {messages.join(", ")}
              </span>
            ))}
          {apiError?.correlationId && (
            <small>Reference {apiError.correlationId}</small>
          )}
        </div>
      ) : success ? (
        <div
          className="form-submit-result form-submit-success"
          role="status"
          aria-live="polite"
        >
          {success}
        </div>
      ) : null}
    </div>
  );
}
