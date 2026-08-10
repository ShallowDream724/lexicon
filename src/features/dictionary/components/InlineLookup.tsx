"use client";

import { Search } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  clampLookupPosition,
  normalizeLookupQuery,
  resolveEnglishLookupToken,
  resolveLookupInteractionMode,
  type LookupInteractionMode,
  type LookupAnchorRect,
  type LookupPopupSize,
  type LookupViewport,
} from "../inline-lookup-model";

type InlineLookupProps = {
  onLookup: (query: string) => Promise<unknown> | void;
};

type LookupCandidate = {
  query: string;
  anchor: LookupAnchorRect;
  surface: HTMLElement;
};

const fallbackPopupSize: LookupPopupSize = { width: 180, height: 40 };
const lookupSurfaceSelector = "[data-inline-lookup-surface]";

function containsInteractiveAncestor(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) {
    return false;
  }
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement;
  return Boolean(element?.closest("button, a, input, textarea, select, [contenteditable]"));
}

function lookupSurface(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) {
    return null;
  }
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement;
  return element?.closest<HTMLElement>(lookupSurfaceSelector) ?? null;
}

function selectionAnchor(selection: Selection, root: HTMLElement): LookupCandidate | null {
  if (!selection.rangeCount || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  if (containsInteractiveAncestor(range.commonAncestorContainer)) {
    return null;
  }
  const query = normalizeLookupQuery(selection.toString());
  if (!query) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return null;
  }
  return { query, anchor: toAnchorRect(rect), surface: root };
}

function tokenAtPoint(
  document: Document,
  root: HTMLElement,
  clientX: number,
  clientY: number,
): LookupCandidate | null {
  const range = caretRangeAtPoint(document, clientX, clientY);
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !root.contains(range.startContainer)) {
    return null;
  }
  if (containsInteractiveAncestor(range.startContainer)) {
    return null;
  }

  const text = range.startContainer.textContent ?? "";
  const token = resolveEnglishLookupToken(text, range.startOffset);
  if (!token) {
    return null;
  }

  const tokenRange = document.createRange();
  tokenRange.setStart(range.startContainer, token.start);
  tokenRange.setEnd(range.startContainer, token.end);
  const rect = tokenRange.getBoundingClientRect();
  return {
    query: token.query,
    surface: root,
    anchor: rect.width || rect.height
      ? toAnchorRect(rect)
      : { left: clientX, top: clientY, width: 0, height: 0 },
  };
}

function caretRangeAtPoint(document: Document, clientX: number, clientY: number): Range | null {
  const caretPositionFromPoint = document.caretPositionFromPoint;
  if (caretPositionFromPoint) {
    const position = caretPositionFromPoint.call(document, clientX, clientY);
    if (!position) {
      return null;
    }
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint?.(clientX, clientY) ?? null;
}

function toAnchorRect(rect: DOMRect): LookupAnchorRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function viewportBounds(): LookupViewport {
  const visualViewport = window.visualViewport;
  return visualViewport
    ? {
        left: visualViewport.offsetLeft,
        top: visualViewport.offsetTop,
        width: visualViewport.width,
        height: visualViewport.height,
      }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function lookupInteractionMode(): LookupInteractionMode {
  return resolveLookupInteractionMode({
    viewportWidth: window.innerWidth,
    hasFinePointer: window.matchMedia("(pointer: fine)").matches,
    hasCoarsePointer: window.matchMedia("(pointer: coarse)").matches,
    hasTouchInput: navigator.maxTouchPoints > 0,
  });
}

function useLookupInteractionMode(): LookupInteractionMode {
  const [mode, setMode] = useState<LookupInteractionMode>(() =>
    typeof window === "undefined" ? "selection" : lookupInteractionMode(),
  );

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const updateMode = () => setMode(lookupInteractionMode());

    updateMode();
    window.addEventListener("resize", updateMode);
    finePointer.addEventListener("change", updateMode);
    coarsePointer.addEventListener("change", updateMode);

    return () => {
      window.removeEventListener("resize", updateMode);
      finePointer.removeEventListener("change", updateMode);
      coarsePointer.removeEventListener("change", updateMode);
    };
  }, []);

  return mode;
}

export function InlineLookup({ onLookup }: InlineLookupProps) {
  const [candidate, setCandidate] = useState<LookupCandidate | null>(null);
  const [popupSize, setPopupSize] = useState<LookupPopupSize>(fallbackPopupSize);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const interactionMode = useLookupInteractionMode();

  const position = useMemo(
    () => candidate && clampLookupPosition(candidate.anchor, viewportBounds(), popupSize),
    [candidate, popupSize],
  );

  useLayoutEffect(() => {
    if (!candidate || !buttonRef.current) {
      return;
    }
    const { width, height } = buttonRef.current.getBoundingClientRect();
    if (width && height && (width !== popupSize.width || height !== popupSize.height)) {
      setPopupSize({ width, height });
    }
  }, [candidate, popupSize.height, popupSize.width]);

  useEffect(() => {
    const dismiss = () => setCandidate(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) {
        return;
      }
      if (!lookupSurface(event.target)) {
        dismiss();
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      const surface = lookupSurface(event.target);
      if (!surface || containsInteractiveAncestor(event.target)) {
        return;
      }
      if (interactionMode === "selection") {
        const selection = window.getSelection();
        const next = selection && selectionAnchor(selection, surface);
        setCandidate(next);
        return;
      }
      setCandidate(tokenAtPoint(document, surface, event.clientX, event.clientY));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
    };
  }, [interactionMode]);

  useEffect(() => {
    if (!candidate) {
      return;
    }
    const surface = candidate.surface;
    const observer = new MutationObserver((records) => {
      if (!surface.isConnected) {
        setCandidate(null);
        return;
      }
      const button = buttonRef.current;
      const hasSurfaceMutation = records.some((record) => {
        if (!surface.contains(record.target)) {
          return false;
        }
        if (record.target === button) {
          return false;
        }
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) => node !== button && !(node instanceof Element && node.contains(button)),
        );
      });
      if (hasSurfaceMutation) {
        setCandidate(null);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [candidate]);

  if (!candidate || !position) {
    return null;
  }

  const style: CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    maxWidth: "calc(100vw - 16px)",
  };

  return createPortal(
    <button
      aria-label={`查询 ${candidate.query}`}
      className="inline-lookup"
      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => event.preventDefault()}
      onClick={() => {
        const query = candidate.query;
        setCandidate(null);
        void Promise.resolve(onLookup(query)).catch(() => undefined);
      }}
      ref={buttonRef}
      style={style}
      type="button"
    >
      <Search aria-hidden="true" />
      <span>查询 {candidate.query}</span>
    </button>,
    candidate.surface,
  );
}
