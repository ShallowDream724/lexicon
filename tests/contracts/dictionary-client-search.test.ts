import assert from "node:assert/strict";
import test from "node:test";

import { parseSearchTargets } from "../../src/lib/dictionary-client/client";

test("parses optional reverse-search evidence without changing English search items", () => {
  const [english, chinese] = parseSearchTargets({
    query: "休息",
    items: [{
      kind: "dictionary",
      id: "rest",
      headword: "rest",
      partsOfSpeech: ["noun"],
      translationPreview: "休息",
    }, {
      kind: "dictionary",
      id: "break",
      headword: "break",
      partsOfSpeech: ["noun"],
      translationPreview: "间歇",
      matches: [{
        scope: "sense",
        englishText: "a short period of rest",
        chineseText: "短暂的休息",
        location: {
          section: "definitions",
          part: "noun",
          ownerId: "sense-break",
          path: ["senses", "0"],
        },
      }],
    }],
  });

  assert.equal(english?.kind, "dictionary");
  assert.equal(english?.kind === "dictionary" ? english.matches : undefined, undefined);
  assert.equal(chinese?.kind === "dictionary" ? chinese.matches?.[0]?.location.ownerId : undefined, "sense-break");
});

test("rejects reverse-search evidence with an unknown location contract", () => {
  assert.throws(() => parseSearchTargets({
    items: [{
      kind: "dictionary",
      id: "rest",
      headword: "rest",
      matches: [{
        scope: "sense",
        englishText: "rest",
        chineseText: "休息",
        location: { section: "source-private-section", path: [] },
      }],
    }],
  }));
});
