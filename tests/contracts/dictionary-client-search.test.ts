import assert from "node:assert/strict";
import test from "node:test";

import { parseSearchPage, parseSearchTargets } from "../../src/lib/dictionary-client/client";

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

test("parses an optional incremental-search offset without changing legacy items", () => {
  const page = parseSearchPage({
    query: "休息",
    items: [{ kind: "dictionary", id: "rest", headword: "rest" }],
    nextOffset: 32,
  });

  assert.equal(page.items[0]?.id, "rest");
  assert.equal(page.nextOffset, 32);
  assert.equal(parseSearchPage({ items: [] }).nextOffset, null);
  assert.throws(() => parseSearchPage({ items: [], nextOffset: 512 }));
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
