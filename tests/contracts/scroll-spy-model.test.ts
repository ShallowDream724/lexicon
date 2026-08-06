import assert from "node:assert/strict";
import test from "node:test";

import { activeSectionForScroll } from "../../src/features/dictionary/scroll-spy-model";

test("selects the last section at the document end even when it cannot reach the top anchor", () => {
  assert.equal(
    activeSectionForScroll(
      [
        { id: "definitions", top: -900 },
        { id: "idioms", top: 430 },
      ],
      {
        anchor: 80,
        scrollY: 1_200,
        viewportHeight: 800,
        documentHeight: 2_000,
      },
    ),
    "idioms",
  );
});

test("uses the top anchor during ordinary scrolling and ignores missing anchors", () => {
  assert.equal(
    activeSectionForScroll(
      [
        { id: "definitions", top: -120 },
        { id: "missing", top: Number.NaN },
        { id: "idioms", top: 240 },
      ],
      {
        anchor: 80,
        scrollY: 300,
        viewportHeight: 700,
        documentHeight: 2_400,
      },
    ),
    "definitions",
  );
});
