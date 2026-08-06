import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalGrammarUsageBox } from "../../packages/dictionary-schema/src/index";
import { grammarUsageBoxLabels } from "../../src/features/dictionary/box-presentation";

function box(type: string, title?: string): CanonicalGrammarUsageBox {
  return {
    type,
    title: title ? { text: title, tokens: [], raw: title } : undefined,
    blocks: [],
    body: [],
    raw: {},
  };
}

test("splits every punctuation-bearing resource type at its localized label", () => {
  assert.deepEqual(grammarUsageBoxLabels(box("WHICH WORD? 词语辨析")), {
    primary: "词语辨析",
    secondary: "WHICH WORD?",
  });
  assert.deepEqual(grammarUsageBoxLabels(box("BRITISH/AMERICAN 英式 / 美式英语")), {
    primary: "英式 / 美式英语",
    secondary: "BRITISH/AMERICAN",
  });
  assert.deepEqual(grammarUsageBoxLabels(box("MORE ABOUT ... 补充说明")), {
    primary: "补充说明",
    secondary: "MORE ABOUT ...",
  });
});

test("uses a box title when the source type has no localized label", () => {
  assert.deepEqual(grammarUsageBoxLabels(box("GRAMMAR POINT", "Countable nouns")), {
    primary: "Countable nouns",
    secondary: "GRAMMAR POINT",
  });
});
