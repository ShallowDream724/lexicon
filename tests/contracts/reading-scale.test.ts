import assert from "node:assert/strict";
import test from "node:test";

import {
  readingScaleFromIndex,
  readingScaleIndex,
  readingScaleOptions,
} from "../../src/features/dictionary/reading-scale";

test("maps the bounded reading-size slider to the persisted three-level preference", () => {
  assert.deepEqual(
    readingScaleOptions.map(({ value }) => value),
    ["small", "default", "large"],
  );
  assert.equal(readingScaleIndex("small"), 0);
  assert.equal(readingScaleIndex("default"), 1);
  assert.equal(readingScaleIndex("large"), 2);
  assert.equal(readingScaleFromIndex(-1), "small");
  assert.equal(readingScaleFromIndex(1), "default");
  assert.equal(readingScaleFromIndex(3), "large");
});
