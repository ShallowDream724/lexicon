import assert from "node:assert/strict";
import test from "node:test";

import {
  DictionaryClientError,
  dictionaryClient,
  dictionarySearchQueryLimit,
  dictionarySearchQueryTooLongCode,
  parseSearchPage,
  parseSearchTargets,
} from "../../src/lib/dictionary-client/client";
import { dictionarySearchErrorMessage } from "../../src/features/dictionary/search-errors";

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

test("serializes one canonical scope for every Chinese page and omits it for English search", async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)));
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  try {
    await dictionaryClient.searchPage("休息", {
      limit: 32,
      scope: ["example", "usage", "sense", "phrase", "form"],
    });
    await dictionaryClient.searchPage("休息", {
      limit: 32,
      offset: 32,
      scope: ["form", "sense", "phrase", "usage", "example"],
    });
    await dictionaryClient.search("rest", { scope: ["usage"] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0]?.searchParams.get("scope"), "sense,phrase,form,usage,example");
  assert.equal(requests[1]?.searchParams.get("scope"), "sense,phrase,form,usage,example");
  assert.equal(requests[1]?.searchParams.get("offset"), "32");
  assert.equal(requests[2]?.searchParams.has("scope"), false);
});

test("rejects oversized search text before a request and reports an input error", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  try {
    await dictionaryClient.search("中".repeat(dictionarySearchQueryLimit));
    await assert.rejects(
      dictionaryClient.searchPage("中".repeat(dictionarySearchQueryLimit + 1)),
      (error) => {
        assert.ok(error instanceof DictionaryClientError);
        assert.equal(error.code, dictionarySearchQueryTooLongCode);
        assert.equal(dictionarySearchErrorMessage(error), "查询内容最多 200 个字符，请缩短后重试");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestCount, 1);
});
