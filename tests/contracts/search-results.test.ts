import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  compactEvidencePartLabel,
  SearchResults,
} from "../../src/features/dictionary/components/SearchResults";
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

test("keeps scope controls and current results mounted during a scope refresh", () => {
  const item: DictionarySearchItem = {
    kind: "dictionary",
    id: "rest",
    headword: "rest",
    partsOfSpeech: ["noun"],
    translationPreview: "休息",
  };
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [item],
    pending: true,
    scope: ["sense", "phrase", "form", "example"],
    onScopeChange: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /aria-busy="true"/);
  assert.match(html, /正在查询/);
  assert.match(html, /词义与短语/);
  assert.match(html, /例句/);
  assert.match(html, /aria-label="词条"/);
  assert.match(html, />rest</);
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

test("renders structured phrase evidence with a neutral degraded status and expandable matches", () => {
  const item: DictionarySearchItem = {
    kind: "dictionary",
    id: "take-a-break",
    headword: "take a break",
    partsOfSpeech: ["verb"],
    translationPreview: "休息",
    matchesTotal: 4,
    matches: [0, 1, 2, 3].map((index) => ({
      scope: "phrase" as const,
      candidateText: `take a break ${index + 1}`,
      chineseText: `休息 ${index + 1}`,
      definitionText: `stop working ${index + 1}`,
      part: "verb",
      englishText: "",
      location: {
        section: "definitions" as const,
        part: "verb",
        ownerId: `phrase-${index}`,
        path: ["phrases", String(index)],
      },
    })),
  };
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [item],
    pending: false,
    mode: "hybrid",
    semanticStatus: "degraded",
    onSelect: () => undefined,
  }));

  assert.match(html, /部分相关结果暂未显示/);
  assert.match(html, /data-scope="phrase"/);
  assert.match(html, /短语/);
  assert.match(html, /search-result-scope-part">v\.<\/span>/);
  assert.doesNotMatch(html, / · /);
  assert.match(html, /search-result-match-term">take a break<\/strong> 1/);
  assert.match(html, /休息 1/);
  assert.match(html, /stop working 1/);
  assert.doesNotMatch(html, /take a break 4/);
  assert.match(html, /显示全部 4 条匹配/);
  assert.match(html, /aria-expanded="false"/);
});

test("keeps headword parts complete while compacting every evidence part label", () => {
  const expected = new Map([
    ["noun", "n."],
    ["verb", "v."],
    ["adj.", "adj."],
    ["adv.", "adv."],
    ["prep.", "prep."],
    ["abbr.", "abbr."],
    ["pron.", "pron."],
    ["exclamation", "excl."],
    ["suffix", "suff."],
    ["combining form", "comb. form"],
    ["modal verb", "modal v."],
    ["conj.", "conj."],
    ["prefix", "pref."],
    ["det.", "det."],
    ["number", "num."],
    ["short form", "short f."],
    ["auxiliary verb", "aux. v."],
    ["definite article", "def. art."],
    ["symbol", "symb."],
    ["ordinal number", "ord. num."],
    ["indefinite article", "indef. art."],
    ["infinitive marker", "inf. marker"],
    ["linking verb", "linking v."],
  ]);

  for (const [part, compact] of expected) {
    assert.equal(compactEvidencePartLabel(part), compact);
  }

  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "需要",
    items: [{
      kind: "dictionary",
      id: "need",
      headword: "need",
      partsOfSpeech: ["verb", "noun", "modal verb"],
      translationPreview: "需要",
      matches: [{
        scope: "sense",
        englishText: "require something",
        chineseText: "需要",
        part: "modal verb",
        location: {
          section: "definitions",
          part: "modal verb",
          ownerId: "need-sense",
          path: ["senses", "0"],
        },
      }],
    }],
    pending: false,
    onSelect: () => undefined,
  }));

  assert.match(html, /verb, noun, modal verb/);
  assert.match(html, /data-scope="sense"/);
  assert.match(html, /search-result-scope-part">modal v\.<\/span>/);
  assert.doesNotMatch(html, / · /);
});

test("emphasizes canonical headword forms inside English evidence", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "我要疯了",
    items: [{
      kind: "dictionary",
      id: "twist",
      headword: "twist",
      partsOfSpeech: ["verb", "noun"],
      translationPreview: "扭转",
      headwordForms: ["twisted", "twisting"],
      matches: [{
        scope: "example",
        englishText: "I twisted around the twist, but resisted turning again.",
        chineseText: "我绕着弯转了一圈，但没有再转。",
        location: {
          section: "grammar-usage",
          part: "verb",
          ownerId: "twist-example",
          path: ["senses", "0", "grammarUsageBoxes", "0", "blocks", "0"],
        },
      }],
    }],
    pending: false,
    onSelect: () => undefined,
  }));

  assert.match(html, /<strong class="search-result-match-term">twisted<\/strong>/);
  assert.match(html, /the <strong class="search-result-match-term">twist<\/strong>/);
  assert.doesNotMatch(html, /<strong class="search-result-match-term">resisted<\/strong>/);
});

test("emphasizes canonical irregular forms without client-side morphology rules", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "我要疯了",
    items: [{
      kind: "dictionary",
      id: "think",
      headword: "think",
      partsOfSpeech: ["verb", "noun"],
      translationPreview: "认为",
      headwordForms: ["thought", "thinking"],
      matches: [{
        scope: "example",
        englishText: "‘I must be crazy,’ she thought.",
        chineseText: "“我准是疯了。”她想。",
        location: {
          section: "definitions",
          part: "verb",
          ownerId: "think-example",
          path: ["senses", "0", "examples", "0"],
        },
      }],
    }],
    pending: false,
    onSelect: () => undefined,
  }));

  assert.match(html, /she <strong class="search-result-match-term">thought<\/strong>\./);
});

test("includes Oxford stress marks when emphasizing a headword", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, {
    query: "发疯",
    items: [{
      kind: "dictionary",
      id: "mind",
      headword: "mind",
      partsOfSpeech: ["noun", "verb"],
      translationPreview: "头脑",
      headwordForms: ["minds"],
      matches: [
        {
          scope: "phrase",
          candidateText: "lose your ˈmind",
          englishText: "",
          chineseText: "发疯",
          location: {
            section: "definitions",
            part: "noun",
            ownerId: "mind-primary-stress",
            path: ["idioms", "0"],
          },
        },
        {
          scope: "phrase",
          candidateText: "be of two ˌminds",
          englishText: "",
          chineseText: "拿不定主意",
          location: {
            section: "definitions",
            part: "noun",
            ownerId: "mind-secondary-stress",
            path: ["idioms", "1"],
          },
        },
      ],
    }],
    pending: false,
    onSelect: () => undefined,
  }));

  assert.match(html, /search-result-match-term">ˈmind<\/strong>/);
  assert.match(html, /search-result-match-term">ˌminds<\/strong>/);
});

test("does not show degraded status for lexical Chinese or non-Chinese results", () => {
  const lexical = renderToStaticMarkup(createElement(SearchResults, {
    query: "休息",
    items: [],
    pending: false,
    semanticStatus: "degraded",
    onSelect: () => undefined,
  }));
  const english = renderToStaticMarkup(createElement(SearchResults, {
    query: "rest",
    items: [],
    pending: false,
    mode: "hybrid",
    semanticStatus: "degraded",
    onSelect: () => undefined,
  }));

  assert.doesNotMatch(lexical, /部分相关结果暂未显示/);
  assert.doesNotMatch(english, /部分相关结果暂未显示/);
});
