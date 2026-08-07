import assert from "node:assert/strict";
import test from "node:test";

import { adaptiveLineCount } from "../../src/features/dictionary/adaptive-line-clamp";

test("adaptive line count fills only the preview's usable block space", () => {
  assert.equal(
    adaptiveLineCount({
      availableBlockSize: 132,
      blockEndInset: 12,
      blockStartInset: 10,
      lineHeight: 22,
    }),
    5,
  );
  assert.equal(
    adaptiveLineCount({
      availableBlockSize: 131,
      blockEndInset: 12,
      blockStartInset: 10,
      lineHeight: 22,
    }),
    4,
  );
});

test("adaptive line count allows the card to omit a preview when no full line fits", () => {
  assert.equal(
    adaptiveLineCount({
      availableBlockSize: 12,
      blockEndInset: 8,
      blockStartInset: 8,
      lineHeight: 20,
    }),
    0,
  );
  assert.equal(
    adaptiveLineCount({
      availableBlockSize: 100,
      blockEndInset: 0,
      blockStartInset: 0,
      lineHeight: Number.NaN,
    }),
    0,
  );
});
