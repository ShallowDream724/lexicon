import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackSearchQueries,
  isChineseSearchQuery,
  resolveSearchMatches,
  type DictionarySearchItem,
  type EtymologySearchItem,
} from "../../src/features/dictionary/search-matches";

const item = (
  id: string,
  headword: string,
  partsOfSpeech: string[] = [],
  translationPreview = "",
): DictionarySearchItem => ({
  kind: "dictionary",
  id,
  headword,
  partsOfSpeech,
  translationPreview,
});

const etymologyItem = (id: string, headword: string): EtymologySearchItem => ({
  kind: "etymology",
  id,
  headword,
  partsOfSpeech: [],
  translationPreview: "",
});

test("returns a direct entry only for one exact normalized headword", () => {
  assert.deepEqual(
    resolveSearchMatches("Rest", [item("rest", "rest"), item("result", "result")]),
    { kind: "direct", target: item("rest", "rest") },
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

test("keeps Chinese reverse lookups on the result page even with one match", () => {
  const result = item("pneumonoultramicroscopicsilicovolcanoconiosis", "pneumonoultramicroscopicsilicovolcanoconiosis");
  assert.equal(isChineseSearchQuery("火山矽肺病"), true);
  assert.equal(isChineseSearchQuery("volcanic lung disease"), false);
  assert.deepEqual(resolveSearchMatches("火山矽肺病", [result]), {
    kind: "candidates",
    items: [result],
  });
});

test("normalizes case, middle dots, and compatibility characters before matching", () => {
  assert.deepEqual(
    resolveSearchMatches("  CO·OPERATE  ", [item("cooperate", "co\u2027operate")]),
    { kind: "direct", target: item("cooperate", "co\u2027operate") },
  );

  assert.deepEqual(
    resolveSearchMatches("\uFF21", [item("a", "a")]),
    { kind: "direct", target: item("a", "a") },
  );
});

test("keeps a dictionary exact match primary and opens a sole etymology exact match", () => {
  const dictionary = item("root", "root");
  const etymology = etymologyItem("root", "root");
  assert.deepEqual(resolveSearchMatches("root", [etymology, dictionary]), {
    kind: "direct",
    target: dictionary,
  });
  assert.deepEqual(resolveSearchMatches("origin", [etymologyItem("origin", "origin")]), {
    kind: "direct",
    target: etymologyItem("origin", "origin"),
  });
});

test("places dictionary candidates before etymology-only candidates without changing group order", () => {
  const firstDictionary = item("alpha", "alpha");
  const secondDictionary = item("alpine", "alpine");
  const etymology = etymologyItem("al", "al");
  assert.deepEqual(resolveSearchMatches("a", [etymology, firstDictionary, secondDictionary]), {
    kind: "candidates",
    items: [firstDictionary, secondDictionary, etymology],
  });
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
