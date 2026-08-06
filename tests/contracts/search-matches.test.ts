import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackSearchQueries,
  resolveSearchMatches,
  type DictionarySearchItem,
} from "../../src/features/dictionary/search-matches";

const item = (
  id: string,
  headword: string,
  partsOfSpeech: string[] = [],
  translationPreview = "",
): DictionarySearchItem => ({ id, headword, partsOfSpeech, translationPreview });

test("returns a direct entry only for one exact normalized headword", () => {
  assert.deepEqual(
    resolveSearchMatches("Rest", [item("rest", "rest"), item("result", "result")]),
    { kind: "direct", entryId: "rest" },
  );
});

test("keeps API order when multiple entries have an exact headword", () => {
  const items = [item("noun", "rest"), item("verb", "rest"), item("prefix", "restful")];

  assert.deepEqual(resolveSearchMatches("rest", items), { kind: "candidates", items });
});

test("returns prefixes as candidates without guessing a direct entry", () => {
  const items = [item("restful", "restful"), item("restore", "restore")];

  assert.deepEqual(resolveSearchMatches("rest", items), { kind: "candidates", items });
});

test("returns an empty candidate list for no matches", () => {
  assert.deepEqual(resolveSearchMatches("rest", []), { kind: "candidates", items: [] });
});

test("normalizes case, middle dots, and compatibility characters before matching", () => {
  assert.deepEqual(
    resolveSearchMatches("  CO·OPERATE  ", [item("cooperate", "co\u2027operate")]),
    { kind: "direct", entryId: "cooperate" },
  );

  assert.deepEqual(
    resolveSearchMatches("\uFF21", [item("a", "a")]),
    { kind: "direct", entryId: "a" },
  );
});

test("deduplicates repeated ids while retaining first-result order", () => {
  const first = item("rest", "rest", ["noun"], "休息");
  const second = item("restful", "restful", ["adjective"], "安宁的");

  assert.deepEqual(
    resolveSearchMatches("res", [first, item("rest", "rest", ["verb"], "其余"), second]),
    { kind: "candidates", items: [first, second] },
  );
});

test("derives bounded single-word inflection fallbacks without touching phrases", () => {
  assert.deepEqual(fallbackSearchQueries("crashed"), ["crash", "crashe"]);
  assert.deepEqual(fallbackSearchQueries("stopped"), ["stop"]);
  assert.deepEqual(fallbackSearchQueries("studies"), ["study"]);
  assert.deepEqual(fallbackSearchQueries("making"), ["mak", "make"]);
  assert.deepEqual(fallbackSearchQueries("a sentence with spaces"), []);
  assert.deepEqual(fallbackSearchQueries("crash-test"), []);
});
