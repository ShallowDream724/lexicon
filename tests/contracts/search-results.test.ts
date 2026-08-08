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
