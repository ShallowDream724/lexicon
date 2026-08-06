export type HorizontalScrollMetrics = {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
};

export type HorizontalScrollState = {
  overflowing: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
};

export type HorizontalTabLayoutMetrics = {
  availableWidth: number;
  itemCount: number;
  itemWidth: number;
  staticChromeWidth: number;
  overflowChromeWidth: number;
};

export type HorizontalTabLayout = {
  overflowing: boolean;
  visibleCount: number;
  frameWidth: number;
  pageWidth: number;
};

export type HorizontalTabAvailableWidthMetrics = {
  dockWidth: number;
  visualViewportWidth?: number;
  paddingStart: number;
  paddingEnd: number;
  trailingControlWidth: number;
  gap: number;
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function horizontalTabAvailableWidth(
  metrics: HorizontalTabAvailableWidthMetrics,
): number {
  const dockWidth = finiteNonNegative(metrics.dockWidth);
  const visualViewportWidth = finiteNonNegative(metrics.visualViewportWidth ?? 0);
  const visibleDockWidth = visualViewportWidth > 0
    ? Math.min(dockWidth, visualViewportWidth)
    : dockWidth;

  return Math.max(
    0,
    visibleDockWidth -
      finiteNonNegative(metrics.paddingStart) -
      finiteNonNegative(metrics.paddingEnd) -
      finiteNonNegative(metrics.trailingControlWidth) -
      finiteNonNegative(metrics.gap),
  );
}

export function fitHorizontalTabsToWidth(
  metrics: HorizontalTabLayoutMetrics,
  tolerance = 1,
): HorizontalTabLayout {
  if (metrics.itemCount <= 0 || metrics.itemWidth <= 0) {
    return { overflowing: false, visibleCount: 0, frameWidth: 0, pageWidth: 0 };
  }

  const availableWidth = Math.max(0, metrics.availableWidth);
  const allItemsWidth = metrics.itemCount * metrics.itemWidth;
  const naturalWidth = allItemsWidth + metrics.staticChromeWidth;
  if (naturalWidth <= availableWidth + tolerance) {
    return {
      overflowing: false,
      visibleCount: metrics.itemCount,
      frameWidth: naturalWidth,
      pageWidth: allItemsWidth,
    };
  }

  const visibleCount = Math.max(
    1,
    Math.min(
      metrics.itemCount,
      Math.floor(
        Math.max(0, availableWidth - metrics.overflowChromeWidth) /
          metrics.itemWidth,
      ),
    ),
  );
  return {
    overflowing: true,
    visibleCount,
    frameWidth: Math.min(
      availableWidth,
      visibleCount * metrics.itemWidth + metrics.overflowChromeWidth,
    ),
    pageWidth: visibleCount * metrics.itemWidth,
  };
}

export function horizontalScrollState(
  metrics: HorizontalScrollMetrics,
  tolerance = 1,
): HorizontalScrollState {
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const overflowing = maxScrollLeft > tolerance;
  return {
    overflowing,
    canScrollLeft: overflowing && metrics.scrollLeft > tolerance,
    canScrollRight: overflowing && metrics.scrollLeft < maxScrollLeft - tolerance,
  };
}

export type HorizontalItemMetrics = HorizontalScrollMetrics & {
  itemLeft: number;
  itemWidth: number;
  leadingInset?: number;
};

export function scrollLeftToAlignItemStart(
  metrics: HorizontalItemMetrics,
): number {
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const leadingInset = Math.max(0, metrics.leadingInset ?? 0);
  return Math.min(Math.max(metrics.itemLeft - leadingInset, 0), maxScrollLeft);
}
