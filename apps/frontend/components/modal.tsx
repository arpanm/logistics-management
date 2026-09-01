"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const focusable =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  titleId,
  onClose,
  children,
  className = "",
}: {
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const surface = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const priorOverflow = document.body.style.overflow;
    const application = document.querySelector<HTMLElement>(".app-shell");
    const priorInert = application?.inert ?? false;
    const priorHidden = application
      ? application.getAttribute("aria-hidden")
      : null;
    document.body.style.overflow = "hidden";
    if (application) {
      application.inert = true;
      application.setAttribute("aria-hidden", "true");
    }
    const frame = requestAnimationFrame(() => {
      const first = surface.current?.querySelector<HTMLElement>(focusable);
      (first ?? surface.current)?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !surface.current) return;
      const nodes = Array.from(
        surface.current.querySelectorAll<HTMLElement>(focusable),
      ).filter((node) => node.offsetParent !== null);
      if (!nodes.length) {
        event.preventDefault();
        surface.current.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = priorOverflow;
      if (application) {
        application.inert = priorInert;
        if (priorHidden === null) application.removeAttribute("aria-hidden");
        else application.setAttribute("aria-hidden", priorHidden);
      }
      requestAnimationFrame(() => previous?.focus());
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={surface}
        className={`modal-surface ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
