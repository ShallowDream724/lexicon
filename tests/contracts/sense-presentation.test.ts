import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalSense } from "../../packages/dictionary-schema/src/index";
import {
  senseDefinitionFlow,
  senseReferencePlacement,
} from "../../src/features/dictionary/sense-presentation";

function sense(patterns: CanonicalSense["patterns"] = []): CanonicalSense {
  return {
    order: 0,
    patterns,
    labels: [],
    examples: [],
    inlineUsage: [],
    usage: [],
    usageSegments: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    subsenses: [],
    raw: {},
  };
}

test("keeps labels and qualifiers with a definition unless a construction owns the lead line", () => {
  assert.equal(senseDefinitionFlow(sense()), "inline");
  assert.equal(
    senseDefinitionFlow(sense([{ text: "   ", tokens: [], raw: [] }])),
    "inline",
  );
  assert.equal(
    senseDefinitionFlow(sense([{ text: "bring sb/sth to sth", tokens: [], raw: [] }])),
    "stacked",
  );
});

test("places synonyms and antonyms after a definition while keeping navigation references separate", () => {
  const value = sense();
  value.definition = { text: "to achieve sth difficult", tokens: [], raw: [] };
  value.translation = { text: "完成困难的事情", tokens: [], raw: [] };
  value.crossReferences = [
    { kind: "synonym", label: "SYN", text: "pull sth off", raw: {} },
    { kind: "antonym", label: "OPP", text: "fail", raw: {} },
    { kind: "see-also", label: "see also", text: "achievement", raw: {} },
  ];

  const placement = senseReferencePlacement(value);
  assert.deepEqual(placement.definition.map((reference) => reference.text), [
    "pull sth off",
    "fail",
  ]);
  assert.deepEqual(placement.trailing.map((reference) => reference.text), ["achievement"]);

  value.definition = undefined;
  value.translation = undefined;
  const withoutDefinition = senseReferencePlacement(value);
  assert.deepEqual(withoutDefinition.definition, []);
  assert.deepEqual(withoutDefinition.trailing, value.crossReferences);
});
