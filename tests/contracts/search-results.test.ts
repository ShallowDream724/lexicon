import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchResults } from "../../src/features/dictionary/components/SearchResults";
import type { DictionarySearchItem } from "../../src/lib/dictionary-client/search-target";

test("renders grouped Chinese evidence without repeating the generic preview", () => {
  const item: DictionarySearchItem = {
    kind: "dictionary",
    id: "rest",
    headword: "rest",
    partsOfSpeech: ["noun", "verb"],
    translationPreview: "generic-preview-should-not-repeat",
    matches: [{
      scope: "sense",
      englishText: "a period of relaxing",
      chineseText: "休息；歇息",
      location: {
        section: "definitions",
        part: "noun",
        ownerId: "sense-rest",
        path: ["senses", "0"],
      },
    }],
  };

  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [item],
    pending: false,
    onSelect: () => undefined,
  }));

  assert.match(html, /“休息”的相关英文词条/);
  assert.match(html, /a period of relaxing/);
  assert.match(html, /休息；歇息/);
  assert.doesNotMatch(html, /generic-preview-should-not-repeat/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

test("renders scope controls only for Chinese reverse search", () => {
  const chinese = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [],
    pending: false,
    scope: ["sense", "phrase", "form"],
    onScopeChange: () => undefined,
    onSelect: () => undefined,
  }));
  const english = renderToStaticMarkup(createElement(SearchResults, {
    query: "rest",
    items: [],
    pending: false,
    scope: ["sense", "phrase", "form"],
    onScopeChange: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(chinese, /词义与短语/);
  assert.match(chinese, /用法/);
  assert.match(chinese, /例句/);
  assert.doesNotMatch(english, /词义与短语/);
});

test("renders one bounded continuation control for incremental Chinese results", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [],
    pending: false,
    hasMore: true,
    nextResultCount: 64,
    onLoadMore: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /继续显示至 64 条/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
