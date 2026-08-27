"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ApiError } from "../api";

type ApiResultEvent = CustomEvent<{
  id: string;
  ok: boolean;
  error?: ApiError;
  anchor?: HTMLElement | null;
}>;

type Feedback = {
  id: string;
  ok: boolean;
  error?: ApiError;
  anchor: HTMLElement;
  top: number;
  left: number;
};

/**
 * Mutation forms predate the shared submit-result component. This bridge gives
 * every API-backed form/action immediate feedback at the initiating control,
 * including field and correlation details, while those forms are migrated to
 * fully local state at their normal maintenance boundary.
 */
export function FormFeedbackBridge() {
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as ApiResultEvent).detail;
      const anchor = detail.anchor;
      if (!anchor || !document.contains(anchor)) return;
      if (!detail.ok) clearSensitiveInputs(anchor);
      const position = positionFor(anchor);
      setFeedback((current) => [
        ...current,
        { ...detail, anchor, ...position },
      ]);
      const timer = window.setTimeout(
        () => {
          setFeedback((current) =>
            current.filter((item) => item.id !== detail.id),
          );
          timers.current.delete(detail.id);
        },
        detail.ok ? 6000 : 12000,
      );
      timers.current.set(detail.id, timer);
    };
    const reposition = () =>
      setFeedback((current) =>
        current.map((item) =>
          document.contains(item.anchor)
            ? { ...item, ...positionFor(item.anchor) }
            : item,
        ),
      );
    window.addEventListener("logistics:api-result", show);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("logistics:api-result", show);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  if (!feedback.length) return null;
  const groups = feedback.reduce<
    Array<{ anchor: HTMLElement; top: number; left: number; items: Feedback[] }>
  >((current, item) => {
    const group = current.find((candidate) => candidate.anchor === item.anchor);
    if (group) group.items.push(item);
    else
      current.push({
        anchor: item.anchor,
        top: item.top,
        left: item.left,
        items: [item],
      });
    return current;
  }, []);
  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setFeedback((current) => current.filter((item) => item.id !== id));
  };
  return createPortal(
    <>
      {groups.map((group) => (
        <div
          className="form-feedback-stack"
          style={{ top: group.top, left: group.left }}
          key={group.items[0]!.id}
        >
          {group.items.map((item) => {
            const error = item.error;
            return (
              <div
                className={`form-feedback-popover ${item.ok ? "form-submit-success" : "form-submit-error"}`}
                role={item.ok ? "status" : "alert"}
                aria-live={item.ok ? "polite" : "assertive"}
                key={item.id}
              >
                <strong>
                  {item.ok ? "Saved successfully." : error?.message}
                </strong>
                {error?.fields &&
                  Object.entries(error.fields).map(([field, messages]) => (
                    <span key={field}>
                      {field}: {messages.join(", ")}
                    </span>
                  ))}
                {error?.correlationId && (
                  <small>Reference {error.correlationId}</small>
                )}
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  aria-label="Dismiss result"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </>,
    document.body,
  );
}

function positionFor(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(420, window.innerWidth - 24);
  const below = rect.bottom + 8;
  return {
    top:
      below + 180 < window.innerHeight ? below : Math.max(12, rect.top - 180),
    left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
  };
}

function clearSensitiveInputs(anchor: HTMLElement) {
  const form = anchor.closest("form");
  if (!form) return;
  form
    .querySelectorAll<HTMLInputElement>(
      'input[type="password"], input[name*="password" i], input[name*="token" i], input[name*="secret" i]',
    )
    .forEach((input) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) nativeSetter.call(input, "");
      else input.value = "";
      // React-controlled inputs consume the bubbling input event and update
      // their state; uncontrolled inputs remain cleared directly.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
