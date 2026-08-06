"use client";

import { Search } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  clampLookupPosition,
  extractEnglishToken,
  normalizeLookupQuery,
  resolveLookupInteractionMode,
  type LookupInteractionMode,
  type LookupAnchorRect,
  type LookupPopupSize,
  type LookupViewport,
} from "../inline-lookup-model";

type InlineLookupProps = {
  rootRef: RefObject<HTMLElement | null>;
  onLookup: (query: string) => Promise<unknown> | void;
};

type LookupCandidate = {
  query: string;
  anchor: LookupAnchorRect;
};

const fallbackPopupSize: LookupPopupSize = { width: 180, height: 40 };

function containsInteractiveAncestor(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) {
    return false;
  }
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement;
  return Boolean(element?.closest("button, a, input, textarea, select, [contenteditable]"));
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
  return { query, anchor: toAnchorRect(rect) };
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
  const token = extractEnglishToken(text, range.startOffset);
  if (!token) {
    return null;
  }

  const start = tokenStart(text, range.startOffset);
  if (start === null) {
    return null;
  }
  const tokenRange = document.createRange();
  tokenRange.setStart(range.startContainer, start);
  tokenRange.setEnd(range.startContainer, start + token.length);
  const rect = tokenRange.getBoundingClientRect();
  return {
    query: token,
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

function tokenStart(value: string, offset: number): number | null {
  const token = extractEnglishToken(value, offset);
  if (!token) {
    return null;
  }
  const candidateStart = value.lastIndexOf(token, Math.min(offset, value.length));
  return candidateStart >= 0 ? candidateStart : null;
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

export function InlineLookup({ rootRef, onLookup }: InlineLookupProps) {
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
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const dismiss = () => setCandidate(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) {
        return;
      }
      if (!root.contains(event.target as Node)) {
        dismiss();
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!root.contains(event.target as Node) || containsInteractiveAncestor(event.target)) {
        return;
      }
      if (interactionMode === "selection") {
        const selection = window.getSelection();
        const next = selection && selectionAnchor(selection, root);
        setCandidate(next);
        return;
      }
      setCandidate(tokenAtPoint(document, root, event.clientX, event.clientY));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
      }
    };
    const observer = new MutationObserver((records) => {
      const button = buttonRef.current;
      const hasExternalMutation = records.some((record) => {
        if (record.target === button) {
          return false;
        }
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) => node !== button && !(node instanceof Element && node.contains(button)),
        );
      });
      if (hasExternalMutation) {
        dismiss();
      }
    });

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
      observer.disconnect();
    };
  }, [interactionMode, rootRef]);

  if (!candidate || !position) {
    return null;
  }

  const style: CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    maxWidth: "calc(100vw - 16px)",
  };

  return (
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
    </button>
  );
}
