import assert from "node:assert/strict";
import test from "node:test";

import {
  clampLookupPosition,
  extractEnglishToken,
  normalizeLookupQuery,
  resolveLookupInteractionMode,
} from "../../src/features/dictionary/inline-lookup-model";

test("extracts English tokens with apostrophes and hyphens only", () => {
  assert.equal(extractEnglishToken("well-known don't l’esprit", 6), "well-known");
  assert.equal(extractEnglishToken("well-known don't l’esprit", 13), "don't");
  assert.equal(extractEnglishToken("well-known don't l’esprit", 22), "l’esprit");
  assert.equal(extractEnglishToken("中文word", 1), null);
  assert.equal(extractEnglishToken("   ", 1), null);
  assert.equal(extractEnglishToken("--", 1), null);
});

test("normalizes desktop selections and rejects excessive text", () => {
  assert.equal(normalizeLookupQuery("  Ｆｕｌｌ\nwidth\t phrase  "), "Full width phrase");
  assert.equal(normalizeLookupQuery(" "), null);
  assert.equal(normalizeLookupQuery("a".repeat(81)), null);
});

test("uses tap lookup for responsive and touch-oriented contexts", () => {
  assert.equal(
    resolveLookupInteractionMode({
      viewportWidth: 1440,
      hasFinePointer: true,
      hasCoarsePointer: false,
      hasTouchInput: false,
    }),
    "selection",
  );
  assert.equal(
    resolveLookupInteractionMode({
      viewportWidth: 1024,
      hasFinePointer: true,
      hasCoarsePointer: false,
      hasTouchInput: false,
    }),
    "tap",
  );
  assert.equal(
    resolveLookupInteractionMode({
      viewportWidth: 1025,
      hasFinePointer: true,
      hasCoarsePointer: false,
      hasTouchInput: false,
    }),
    "selection",
  );
  assert.equal(
    resolveLookupInteractionMode({
      viewportWidth: 1366,
      hasFinePointer: true,
      hasCoarsePointer: true,
      hasTouchInput: false,
    }),
    "tap",
  );
  assert.equal(
    resolveLookupInteractionMode({
      viewportWidth: 1366,
      hasFinePointer: true,
      hasCoarsePointer: false,
      hasTouchInput: true,
    }),
    "tap",
  );
});

test("clamps the lookup button and prefers an available side of the selection", () => {
  assert.deepEqual(
    clampLookupPosition(
      { left: 0, top: 10, width: 10, height: 10 },
      { left: 0, top: 0, width: 200, height: 160 },
      { width: 80, height: 32 },
    ),
    { left: 8, top: 28, placement: "below" },
  );
  assert.deepEqual(
    clampLookupPosition(
      { left: 180, top: 140, width: 10, height: 10 },
      { left: 0, top: 0, width: 200, height: 160 },
      { width: 80, height: 32 },
    ),
    { left: 112, top: 100, placement: "above" },
  );
  assert.deepEqual(
    clampLookupPosition(
      { left: 96, top: 64, width: 8, height: 8 },
      { left: 0, top: 0, width: 120, height: 90 },
      { width: 104, height: 72 },
    ),
    { left: 8, top: 10, placement: "below" },
  );
});
