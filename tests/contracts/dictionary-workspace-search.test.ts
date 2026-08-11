import assert from "node:assert/strict";
import test from "node:test";

import {
  hasContextualEnglishSearchResults,
  isCurrentSearchResultRequest,
} from "../../src/features/dictionary/components/DictionaryWorkspace";
import { dictionarySearchRequestKey } from "../../src/lib/dictionary-client/search-scope";

test("ignores a completed response for an older Chinese search scope", () => {
  const priorRequest = dictionarySearchRequestKey("休息", ["sense", "form"]);
  const activeRequest = dictionarySearchRequestKey("休息", ["phrase"]);

  assert.equal(isCurrentSearchResultRequest(activeRequest, priorRequest), false);
  assert.equal(isCurrentSearchResultRequest(activeRequest, activeRequest), true);
});

test("distinguishes exact English lookup from sentence context groups", () => {
  assert.equal(hasContextualEnglishSearchResults([
    { kind: "exact", text: "thought", items: [] },
  ]), false);
  assert.equal(hasContextualEnglishSearchResults([
    { kind: "exact", text: "put me through", items: [] },
    { kind: "phrase", text: "put through", items: [{
      kind: "dictionary",
      id: "put",
      headword: "put",
      partsOfSpeech: ["verb"],
      translationPreview: "放",
    }] },
  ]), true);
});
