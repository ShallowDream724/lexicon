"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { DialogPortal } from "./DialogPortal";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const pendingRef = useRef(pending);
  const titleId = useId();
  const descriptionId = useId();
  useViewportScrollLock(open);

  useLayoutEffect(() => {
    onCancelRef.current = onCancel;
    pendingRef.current = pending;
  }, [onCancel, pending]);

  useEffect(() => {
    if (!open) {
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus({ preventScroll: true }));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!pendingRef.current) {
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape, true);
      returnFocusRef.current?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const keepFocusInside = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (!focusable?.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <DialogPortal>
      <div
        className="confirm-dialog-layer"
        role="presentation"
        onClick={(event) => {
          event.stopPropagation();
          if (!pending) {
            onCancel();
          }
        }}
      >
        <section
          className="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-busy={pending || undefined}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          ref={dialogRef}
          tabIndex={-1}
          onKeyDown={keepFocusInside}
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {error ? <p className="confirm-dialog-error" role="alert">{error}</p> : null}
          <footer>
            <button ref={cancelButtonRef} type="button" disabled={pending} onClick={onCancel}>
              取消
            </button>
            <button className="is-danger" type="button" disabled={pending} onClick={onConfirm}>
              {pending ? "处理中" : confirmLabel}
            </button>
          </footer>
        </section>
      </div>
    </DialogPortal>
  );
}
