import assert from "node:assert/strict";
import test from "node:test";

import {
  fitHorizontalTabsToWidth,
  horizontalTabAvailableWidth,
  horizontalScrollState,
  scrollLeftToAlignItemStart,
} from "../../src/features/dictionary/horizontal-scroll-state";

test("bounds the dock measurement to the current visual viewport", () => {
  assert.equal(
    horizontalTabAvailableWidth({
      dockWidth: 393,
      visualViewportWidth: 360,
      paddingStart: 12,
      paddingEnd: 12,
      trailingControlWidth: 84,
      gap: 12,
    }),
    240,
  );
  assert.equal(
    horizontalTabAvailableWidth({
      dockWidth: 393,
      paddingStart: 12,
      paddingEnd: 12,
      trailingControlWidth: 84,
      gap: 12,
    }),
    273,
  );
  assert.equal(
    horizontalTabAvailableWidth({
      dockWidth: Number.NaN,
      visualViewportWidth: Number.POSITIVE_INFINITY,
      paddingStart: 12,
      paddingEnd: 12,
      trailingControlWidth: 84,
      gap: 12,
    }),
    0,
  );
});

test("fits the largest whole number of tabs into the measured dock width", () => {
  assert.deepEqual(
    fitHorizontalTabsToWidth({
      availableWidth: 255,
      itemCount: 5,
      itemWidth: 75,
      staticChromeWidth: 10,
      overflowChromeWidth: 24,
    }),
    { overflowing: true, visibleCount: 3, frameWidth: 249, pageWidth: 225 },
  );
  assert.deepEqual(
    fitHorizontalTabsToWidth({
      availableWidth: 200,
      itemCount: 5,
      itemWidth: 75,
      staticChromeWidth: 10,
      overflowChromeWidth: 24,
    }),
    { overflowing: true, visibleCount: 2, frameWidth: 174, pageWidth: 150 },
  );
  assert.deepEqual(
    fitHorizontalTabsToWidth({
      availableWidth: 400,
      itemCount: 5,
      itemWidth: 75,
      staticChromeWidth: 10,
      overflowChromeWidth: 24,
    }),
    { overflowing: false, visibleCount: 5, frameWidth: 385, pageWidth: 375 },
  );
});

test("shrinks a non-overflowing frame to the aggregate rendered tab width", () => {
  assert.deepEqual(
    fitHorizontalTabsToWidth({
      availableWidth: 500,
      itemCount: 4,
      itemWidth: 180,
      contentWidth: 405,
      staticChromeWidth: 10,
      overflowChromeWidth: 24,
    }),
    { overflowing: false, visibleCount: 4, frameWidth: 415, pageWidth: 405 },
  );

  assert.deepEqual(
    fitHorizontalTabsToWidth({
      availableWidth: 255,
      itemCount: 5,
      itemWidth: 75,
      contentWidth: 375,
      staticChromeWidth: 10,
      overflowChromeWidth: 24,
    }),
    { overflowing: true, visibleCount: 3, frameWidth: 249, pageWidth: 225 },
  );
});

test("reports only directions that still contain horizontally hidden content", () => {
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 0, clientWidth: 320, scrollWidth: 320 }),
    { overflowing: false, canScrollLeft: false, canScrollRight: false },
  );
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 0, clientWidth: 240, scrollWidth: 480 }),
    { overflowing: true, canScrollLeft: false, canScrollRight: true },
  );
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 120, clientWidth: 240, scrollWidth: 480 }),
    { overflowing: true, canScrollLeft: true, canScrollRight: true },
  );
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 240, clientWidth: 240, scrollWidth: 480 }),
    { overflowing: true, canScrollLeft: true, canScrollRight: false },
  );
});

test("absorbs subpixel differences at either scroll boundary", () => {
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 0.75, clientWidth: 240, scrollWidth: 480 }),
    { overflowing: true, canScrollLeft: false, canScrollRight: true },
  );
  assert.deepEqual(
    horizontalScrollState({ scrollLeft: 239.5, clientWidth: 240, scrollWidth: 480 }),
    { overflowing: true, canScrollLeft: true, canScrollRight: false },
  );
});

test("aligns a newly selected item to the leading edge of the next tab page", () => {
  const viewport = { clientWidth: 160, scrollWidth: 310 };
  assert.equal(
    scrollLeftToAlignItemStart({
      ...viewport,
      scrollLeft: 0,
      itemLeft: 5,
      itemWidth: 75,
      leadingInset: 5,
    }),
    0,
  );
  assert.equal(
    scrollLeftToAlignItemStart({
      ...viewport,
      scrollLeft: 0,
      itemLeft: 80,
      itemWidth: 75,
      leadingInset: 5,
    }),
    75,
  );
  assert.equal(
    scrollLeftToAlignItemStart({
      ...viewport,
      scrollLeft: 75,
      itemLeft: 230,
      itemWidth: 75,
      leadingInset: 5,
    }),
    150,
  );
});
