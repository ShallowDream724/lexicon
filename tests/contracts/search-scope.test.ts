import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHINESE_SEARCH_SCOPES,
  dictionarySearchRequestKey,
  hasSelectedChineseSearchScope,
  parseChineseSearchScopes,
  serializeDictionarySearchScopes,
  toggleSearchScopeCategory,
} from "../../src/lib/dictionary-client/search-scope";

test("normalizes the Chinese search scope URL contract in canonical order", () => {
  assert.deepEqual(
    parseChineseSearchScopes("example,form,sense,resource,phrase,unknown,sense"),
    ["sense", "phrase", "form", "example", "resource"],
  );
  assert.deepEqual(parseChineseSearchScopes(null), DEFAULT_CHINESE_SEARCH_SCOPES);
  assert.equal(
    serializeDictionarySearchScopes(["example", "sense", "form", "resource", "phrase"]),
    "sense,phrase,form,example,resource",
  );
  assert.deepEqual(parseChineseSearchScopes(""), []);
  assert.equal(hasSelectedChineseSearchScope([]), false);
  assert.equal(hasSelectedChineseSearchScope(["sense"]), true);
});

test("scope toggles allow an intentionally empty result range and invalidate an older request identity", () => {
  const terms = parseChineseSearchScopes("sense,phrase,form");
  const withExample = toggleSearchScopeCategory(terms, "example");
  const exampleOnly = toggleSearchScopeCategory(withExample, "meaning");
  const empty = toggleSearchScopeCategory(toggleSearchScopeCategory(exampleOnly, "phrase"), "example");

  assert.deepEqual(withExample, ["sense", "phrase", "form", "example"]);
  assert.deepEqual(exampleOnly, ["phrase", "example"]);
  assert.deepEqual(empty, []);
  assert.notEqual(
    dictionarySearchRequestKey("休息", terms),
    dictionarySearchRequestKey("休息", withExample),
  );
  assert.notEqual(
    dictionarySearchRequestKey("休息", terms),
    dictionarySearchRequestKey("休息", terms, "hybrid"),
  );
});
