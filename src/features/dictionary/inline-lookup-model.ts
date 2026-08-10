export const INLINE_LOOKUP_MAX_QUERY_LENGTH = 80;
export const INLINE_LOOKUP_VIEWPORT_MARGIN = 8;
export const INLINE_LOOKUP_TOUCH_VIEWPORT_MAX_WIDTH = 1024;

export type LookupInteractionMode = "selection" | "tap";

export type LookupInteractionEnvironment = {
  viewportWidth: number;
  hasFinePointer: boolean;
  hasCoarsePointer: boolean;
  hasTouchInput: boolean;
};

export type LookupAnchorRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type LookupViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type LookupPopupSize = {
  width: number;
  height: number;
};

export type LookupPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

export type EnglishLookupToken = {
  query: string;
  start: number;
  end: number;
};

export function resolveLookupInteractionMode({
  viewportWidth,
  hasFinePointer,
  hasCoarsePointer,
  hasTouchInput,
}: LookupInteractionEnvironment): LookupInteractionMode {
  if (
    viewportWidth <= INLINE_LOOKUP_TOUCH_VIEWPORT_MAX_WIDTH ||
    hasCoarsePointer ||
    hasTouchInput
  ) {
    return "tap";
  }

  return hasFinePointer ? "selection" : "tap";
}

const wordCore = "A-Za-z";
const wordJoiner = "'\\u2019\\-\\u2010\\u2011\\u2012\\u2013\\u2014";
const tokenCharacter = new RegExp(`[${wordCore}${wordJoiner}]`);
const validToken = new RegExp(
  `^[${wordCore}]+(?:[${wordJoiner}][${wordCore}]+)*$`,
);

export function normalizeLookupQuery(
  value: string,
  maxLength = INLINE_LOOKUP_MAX_QUERY_LENGTH,
): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function resolveEnglishLookupToken(
  value: string,
  offset: number,
  maxLength = INLINE_LOOKUP_MAX_QUERY_LENGTH,
): EnglishLookupToken | null {
  if (!value || offset < 0 || offset > value.length) {
    return null;
  }

  let start = offset;
  let end = offset;

  if (start === value.length || !tokenCharacter.test(value[start]!)) {
    start -= 1;
  }
  if (start < 0 || !tokenCharacter.test(value[start]!)) {
    return null;
  }

  while (start > 0 && tokenCharacter.test(value[start - 1]!)) {
    start -= 1;
  }
  end = offset;
  while (end < value.length && tokenCharacter.test(value[end]!)) {
    end += 1;
  }

  const token = value.slice(start, end);
  const query = validToken.test(token) ? normalizeLookupQuery(token, maxLength) : null;
  return query ? { query, start, end } : null;
}

export function extractEnglishToken(value: string, offset: number): string | null {
  return resolveEnglishLookupToken(value, offset)?.query ?? null;
}

export function clampLookupPosition(
  anchor: LookupAnchorRect,
  viewport: LookupViewport,
  popup: LookupPopupSize,
  margin = INLINE_LOOKUP_VIEWPORT_MARGIN,
): LookupPosition {
  const minimumLeft = viewport.left + margin;
  const maximumLeft = viewport.left + viewport.width - popup.width - margin;
  const minimumTop = viewport.top + margin;
  const maximumTop = viewport.top + viewport.height - popup.height - margin;
  const centeredLeft = anchor.left + anchor.width / 2 - popup.width / 2;
  const belowTop = anchor.top + anchor.height + margin;
  const aboveTop = anchor.top - popup.height - margin;
  const fitsBelow = belowTop <= maximumTop;
  const fitsAbove = aboveTop >= minimumTop;
  const placement = fitsBelow || !fitsAbove ? "below" : "above";
  const desiredTop = placement === "below" ? belowTop : aboveTop;

  return {
    left: clamp(centeredLeft, minimumLeft, Math.max(minimumLeft, maximumLeft)),
    top: clamp(desiredTop, minimumTop, Math.max(minimumTop, maximumTop)),
    placement,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
