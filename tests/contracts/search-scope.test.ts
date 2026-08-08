import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHINESE_SEARCH_SCOPES,
  dictionarySearchRequestKey,
  parseChineseSearchScopes,
  serializeDictionarySearchScopes,
  toggleSearchScopeCategory,
} from "../../src/lib/dictionary-client/search-scope";

test("normalizes the Chinese search scope URL contract in canonical order", () => {
  assert.deepEqual(
    parseChineseSearchScopes("example,form,sense,usage,phrase,unknown,sense"),
    ["sense", "phrase", "form", "usage", "example"],
  );
  assert.deepEqual(parseChineseSearchScopes(null), DEFAULT_CHINESE_SEARCH_SCOPES);
  assert.equal(
    serializeDictionarySearchScopes(["example", "sense", "form", "phrase"]),
    "sense,phrase,form,example",
  );
});

test("scope toggles retain at least one category and invalidate an older request identity", () => {
  const terms = parseChineseSearchScopes("sense,phrase,form");
  const withUsage = toggleSearchScopeCategory(terms, "usage");
  const usageOnly = toggleSearchScopeCategory(withUsage, "terms");

  assert.deepEqual(withUsage, ["sense", "phrase", "form", "usage"]);
  assert.deepEqual(usageOnly, ["usage"]);
  assert.deepEqual(toggleSearchScopeCategory(usageOnly, "usage"), usageOnly);
  assert.notEqual(
    dictionarySearchRequestKey("休息", terms),
    dictionarySearchRequestKey("休息", withUsage),
  );
});
