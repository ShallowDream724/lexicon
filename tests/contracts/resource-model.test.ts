import assert from "node:assert/strict";
import test from "node:test";

import { etymologyArticleLabel } from "../../src/features/dictionary/resource-model";

test("etymology article labels retain source labels and fall back for blank labels", () => {
  assert.equal(etymologyArticleLabel({ label: " n.1 " }, 0), "n.1");
  assert.equal(etymologyArticleLabel({ label: "  " }, 1), "词源 2");
  assert.equal(etymologyArticleLabel({ label: "adj., adv." }, 2), "adj., adv.");
});
