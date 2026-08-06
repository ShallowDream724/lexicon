import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_CROSS_REFERENCE_KINDS } from "../../packages/dictionary-schema/src/index";
import { projectGrammarUsageBox } from "../../src/features/dictionary/box-presentation";
import { crossReferenceMarker } from "../../src/features/dictionary/cross-reference-presentation";

test("assigns a stable marker to every canonical cross-reference kind", () => {
  assert.equal(
    CANONICAL_CROSS_REFERENCE_KINDS.map(crossReferenceMarker).length,
    CANONICAL_CROSS_REFERENCE_KINDS.length,
  );
  assert.deepEqual(crossReferenceMarker("synonym"), { kind: "badge", text: "SYN" });
  assert.deepEqual(crossReferenceMarker("antonym"), { kind: "badge", text: "OPP" });
  assert.deepEqual(crossReferenceMarker("compare"), { kind: "arrow" });
  assert.deepEqual(crossReferenceMarker("inflection"), { kind: "none" });
});

test("removes only a box heading that duplicates its canonical title", () => {
  const title = { text: " rest ", tokens: [], raw: " rest " };
  const duplicate = {
    kind: "heading" as const,
    level: 1 as const,
    value: { text: "REST", tokens: [], raw: "REST" },
    raw: {},
  };
  const distinct = {
    kind: "paragraph" as const,
    value: { text: "A short pause.", tokens: [], raw: "A short pause." },
    segments: [],
    raw: {},
  };
  const presentation = projectGrammarUsageBox({
    type: "SYNONYMS",
    title,
    blocks: [duplicate, distinct],
    body: [],
    raw: {},
  });

  assert.equal(presentation.title, title);
  assert.deepEqual(presentation.blocks, [distinct]);

  const nonDuplicate = projectGrammarUsageBox({
    title,
    blocks: [{ ...duplicate, value: { ...duplicate.value, text: "Break" } }],
    body: [],
    raw: {},
  });
  assert.equal(nonDuplicate.blocks.length, 1);
});

test("projects wordfinder references once and removes an exactly duplicated body list", () => {
  const references = [
    { kind: "related" as const, text: "baby", entryId: "entry-baby", raw: {} },
    { kind: "related" as const, text: "birth", entryId: "entry-birth", raw: {} },
  ];
  const duplicateList = {
    kind: "list" as const,
    items: ["BABY", "BIRTH"].map((text) => ({
      segments: [{
        kind: "text" as const,
        value: { text, tokens: [], raw: text },
        raw: text,
      }],
      raw: {},
    })),
    raw: {},
  };
  const presentation = projectGrammarUsageBox({
    type: "WORDFINDER 联想词",
    references,
    blocks: [duplicateList],
    body: [],
    raw: {},
  });

  assert.deepEqual(presentation.references, references);
  assert.deepEqual(presentation.blocks, []);
});
