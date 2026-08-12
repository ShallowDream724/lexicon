import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHINESE_SEARCH_SCOPES,
  dictionarySearchExampleEvidenceLabel,
  dictionarySearchRequestKey,
  hasSelectedChineseSearchScope,
  parseChineseSearchScopes,
  serializeDictionarySearchScopes,
  toggleSearchScopeCategory,
} from "../../src/lib/dictionary-client/search-scope";

test("labels obvious sentence examples and unpunctuated collocations", () => {
  assert.equal(
    dictionarySearchExampleEvidenceLabel("I’ll belt you if you do that again.", "你要是再这样，我就揍你。"),
    "例句",
  );
  assert.equal(
    dictionarySearchExampleEvidenceLabel("‘I must be crazy,’ she thought.", "“我准是疯了。”她想。"),
    "例句",
  );
  assert.equal(dictionarySearchExampleEvidenceLabel("to give sb a sound beating", "痛打某人一顿"), "搭配");
  assert.equal(dictionarySearchExampleEvidenceLabel("Westminster Abbey", "威斯敏斯特教堂"), "搭配");
  assert.equal(dictionarySearchExampleEvidenceLabel("Fifth Ave.", "第五大街"), "例证");
  assert.equal(
    dictionarySearchExampleEvidenceLabel("We are here to provide the public with a service", "我们来这里是为公众服务。"),
    "例证",
  );
  assert.equal(
    dictionarySearchExampleEvidenceLabel("(formal) They stand accused of crimes against humanity.", "他们被控犯有反人类罪。"),
    "例句",
  );
  assert.equal(
    dictionarySearchExampleEvidenceLabel("What's up? (= What is the matter?)", "怎么了？"),
    "例句",
  );
});

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
