import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalEntry,
  CanonicalPhrase,
  CanonicalSense,
} from "../../packages/dictionary-schema/src/index";
import { projectEntryPart } from "../../src/features/dictionary/entry-sections";
import {
  phraseQuickFindAnchor,
  projectQuickFind,
  senseQuickFindAnchor,
} from "../../src/features/dictionary/quick-find-model";

const sense = (groupHeading?: string, overrides: Partial<CanonicalSense> = {}): CanonicalSense => ({
  order: 0,
  groupHeading: groupHeading ? { text: groupHeading, tokens: [], raw: groupHeading } : undefined,
  labels: [],
  examples: [],
  usage: [],
  crossReferences: [],
  illustrations: [],
  grammarUsageBoxes: [],
  subsenses: [],
  raw: {},
  ...overrides,
  usageSegments: overrides.usageSegments ?? [],
});

const phrase = (display: string, id?: string): CanonicalPhrase => ({
  id,
  display: { text: display, tokens: [], raw: display },
  labels: [],
  variants: [],
  leadingUsage: [],
  senses: [],
  trailingCrossReferences: [],
  raw: {},
});

const entry = (overrides: Partial<CanonicalEntry> = {}): CanonicalEntry => ({
  schemaVersion: "1.0",
  dictionaryId: "test",
  sourceVersion: "test",
  id: "entry",
  headword: "entry",
  displayHeadword: "entry",
  searchKey: "entry",
  labels: [],
  pronunciations: [],
  partsOfSpeech: [{ text: "noun", tokens: [], raw: "noun" }],
  senses: [],
  subentries: [],
  idioms: [],
  phrasalVerbs: [],
  derivedForms: [],
  inflectedForms: [],
  crossReferences: [],
  illustrations: [],
  grammarUsageBoxes: [],
  raw: {},
  ...overrides,
});

test("projects quick-find content in display order and omits empty resource blocks", () => {
  const nested = entry({
    id: "nested",
    senses: [sense("Nested guide", { id: "nested-sense" })],
  });
  const projection = projectEntryPart(entry({
    senses: [
      sense("First guide", { id: "first" }),
      sense("First guide"),
      sense(undefined, { subsenses: [sense("Nested guide")] }),
    ],
    subentries: [nested],
    illustrations: [{ key: "image", text: "Picture", raw: "image" }],
    grammarUsageBoxes: [{
      id: "usage",
      title: { text: "Usage note", tokens: [], raw: "Usage note" },
      blocks: [],
      body: [],
      raw: {},
    }],
    idioms: [phrase("first idiom", "idiom-source"), phrase("second idiom")],
    phrasalVerbs: [phrase("first phrasal verb")],
  }), 0);

  const model = projectQuickFind(projection);

  assert.deepEqual(model.sections.map((section) => section.id), [
    "parts",
    "resources",
    "senses",
    "idioms",
    "phrasal-verbs",
  ]);
  assert.deepEqual(model.senseGroups.map((item) => [item.label, item.anchor]), [
    ["First guide", "sense-first"],
    ["Nested guide", "sense-root-2-0"],
  ]);
  assert.deepEqual(model.resources.map((item) => [item.kind, item.label]), [
    ["illustration", "图解词汇"],
    ["box", "Usage note"],
  ]);
  assert.deepEqual(model.idioms.map((item) => item.anchor), [
    "phrase-idiom-source",
    "phrase-idioms-1",
  ]);
  assert.deepEqual(model.phrasalVerbs.map((item) => item.anchor), ["phrase-phrasalVerbs-0"]);
});

test("uses source IDs and stable fallback paths for quick-find anchors", () => {
  assert.equal(senseQuickFindAnchor(sense(undefined, { id: "source-sense" }), ["root", 3]), "sense-source-sense");
  assert.equal(senseQuickFindAnchor(sense(), ["subentry", 1, 2]), "sense-subentry-1-2");
  assert.equal(phraseQuickFindAnchor("idioms", phrase("known", "source-phrase"), 4), "phrase-source-phrase");
  assert.equal(phraseQuickFindAnchor("phrasalVerbs", phrase("unknown"), 4), "phrase-phrasalVerbs-4");
});
