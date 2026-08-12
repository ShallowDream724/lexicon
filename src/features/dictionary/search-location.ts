import type { SearchDocumentLocation } from "../../../packages/dictionary-search/src/index";

export type SearchLocationAttributes = {
  "data-search-owner-id"?: string;
  "data-search-path"?: string;
};

const SEARCH_LOCATION_HIGHLIGHT_DURATION_MS = 3_000;
const SEARCH_LOCATION_SCROLL_SETTLE_MS = 120;

const searchLocationHighlightAttribute = "data-search-highlight";
let cancelActiveSearchLocationReveal: (() => void) | null = null;

type RevealSearchLocationOptions = {
  highlightDurationMs?: number;
  scrollSettleMs?: number;
};

export function searchLocationPathKey(path: readonly string[]): string {
  return path.map((segment) => encodeURIComponent(segment)).join("/");
}

export function searchLocationAttributes(
  location: SearchDocumentLocation | undefined,
  ownerId?: string,
): SearchLocationAttributes {
  const resolvedOwnerId = ownerId?.trim() || location?.ownerId?.trim();
  return {
    ...(resolvedOwnerId ? { "data-search-owner-id": resolvedOwnerId } : {}),
    ...(location?.path.length
      ? { "data-search-path": searchLocationPathKey(location.path) }
      : {}),
  };
}

export function searchLocationPathAttributes(
  location: SearchDocumentLocation | undefined,
): SearchLocationAttributes {
  return location?.path.length
    ? { "data-search-path": searchLocationPathKey(location.path) }
    : {};
}

export function searchLocationContains(
  container: SearchDocumentLocation | undefined,
  target: SearchDocumentLocation,
): boolean {
  if (!container || container.section !== target.section) {
    return false;
  }

  const pathsMatch = container.path.length === target.path.length &&
    container.path.every((segment, index) => segment === target.path[index]);
  if (pathsMatch) {
    return !container.ownerId || !target.ownerId || container.ownerId === target.ownerId;
  }

  return container.path.length > 0 &&
    container.path.length < target.path.length &&
    container.path.every((segment, index) => segment === target.path[index]);
}

function elementsWithAttribute(root: ParentNode, attribute: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`));
}

function elementById(root: ParentNode, id: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
    (element) => element.id === id,
  ) ?? null;
}

export function findSearchLocationElement(
  location: SearchDocumentLocation,
  root: ParentNode = document,
): HTMLElement | null {
  const targetPath = searchLocationPathKey(location.path);
  if (targetPath) {
    const candidates = elementsWithAttribute(root, "data-search-path");
    const exactCandidates = candidates.filter(
      (element) => element.dataset.searchPath === targetPath,
    );
    const exact = location.ownerId
      ? exactCandidates.find(
          (element) => element.dataset.searchOwnerId === location.ownerId,
        ) ?? exactCandidates.find((element) => !element.dataset.searchOwnerId)
      : exactCandidates[0];
    if (exact) {
      return exact;
    }
  }

  if (location.ownerId) {
    const owner = elementsWithAttribute(root, "data-search-owner-id").find(
      (element) => element.dataset.searchOwnerId === location.ownerId,
    );
    if (owner) {
      return owner;
    }
  }

  if (targetPath) {
    const candidates = elementsWithAttribute(root, "data-search-path");
    const ancestor = candidates
      .filter((element) => {
        const candidate = element.dataset.searchPath;
        return Boolean(candidate && targetPath.startsWith(`${candidate}/`));
      })
      .toSorted(
        (left, right) => (right.dataset.searchPath?.length ?? 0) - (left.dataset.searchPath?.length ?? 0),
      )[0];
    if (ancestor) {
      return ancestor;
    }
  }

  return elementById(root, location.section) ??
    (location.section === "grammar-usage" ? elementById(root, "definitions") : null);
}

function scheduleSearchLocationHighlight(
  element: HTMLElement,
  options: RevealSearchLocationOptions,
): void {
  cancelActiveSearchLocationReveal?.();
  const ownerDocument = element.ownerDocument;
  const listenerController = new AbortController();
  const settleMs = options.scrollSettleMs ?? SEARCH_LOCATION_SCROLL_SETTLE_MS;
  const highlightDurationMs = options.highlightDurationMs ?? SEARCH_LOCATION_HIGHLIGHT_DURATION_MS;
  let settleTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let highlightTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let active = true;

  const cancel = () => {
    if (!active) {
      return;
    }
    active = false;
    listenerController.abort();
    if (settleTimeout) {
      globalThis.clearTimeout(settleTimeout);
    }
    if (highlightTimeout) {
      globalThis.clearTimeout(highlightTimeout);
    }
    element.removeAttribute(searchLocationHighlightAttribute);
    if (cancelActiveSearchLocationReveal === cancel) {
      cancelActiveSearchLocationReveal = null;
    }
  };
  const highlight = () => {
    listenerController.abort();
    element.removeAttribute(searchLocationHighlightAttribute);
    void element.offsetWidth;
    element.setAttribute(searchLocationHighlightAttribute, "true");
    highlightTimeout = globalThis.setTimeout(cancel, highlightDurationMs);
  };
  function schedule() {
    if (!active) {
      return;
    }
    if (settleTimeout) {
      globalThis.clearTimeout(settleTimeout);
    }
    settleTimeout = globalThis.setTimeout(highlight, settleMs);
  }

  const listenerOptions = {
    capture: true,
    passive: true,
    signal: listenerController.signal,
  };
  ownerDocument?.addEventListener("scroll", schedule, listenerOptions);
  ownerDocument?.defaultView?.addEventListener("scroll", schedule, listenerOptions);
  cancelActiveSearchLocationReveal = cancel;
  schedule();
}

export function revealSearchLocation(
  location: SearchDocumentLocation,
  root: ParentNode = document,
  options: RevealSearchLocationOptions = {},
): HTMLElement | null {
  const target = findSearchLocationElement(location, root);
  if (target) {
    scheduleSearchLocationHighlight(target, options);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return target;
}
