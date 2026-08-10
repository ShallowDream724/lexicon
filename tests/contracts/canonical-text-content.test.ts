import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CanonicalText, SourceToken } from "../../packages/dictionary-schema/src/index";
import { CanonicalTextContent } from "../../src/features/dictionary/components/CanonicalTextContent";

function token(tag: string, text: string): SourceToken {
  return { tag, text, raw: {} };
}

function canonicalText(tokens: SourceToken[]): CanonicalText {
  return {
    text: tokens.map((item) => item.text).join(""),
    tokens,
    raw: {},
  };
}

test("starts an inline usage note on its own line without duplicating an existing break", () => {
  const inline = renderToStaticMarkup(createElement(CanonicalTextContent, {
    value: canonicalText([
      token("eng", "to dislike somebody"),
      token("simp", " 指不喜欢某人"),
      token("un", "[NOTE]"),
      token("eng", "This word is informal."),
    ]),
  }));
  const alreadyBroken = renderToStaticMarkup(createElement(CanonicalTextContent, {
    value: canonicalText([
      token("eng", "to dislike somebody"),
      token("custom-br", ""),
      token("un", "[NOTE]"),
      token("eng", "This word is informal."),
    ]),
  }));

  assert.match(inline, /<br\/><span class="source-token-help">NOTE<\/span>/);
  assert.doesNotMatch(alreadyBroken, /<br\/><br\/>/);
});
