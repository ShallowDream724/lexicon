import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalEntry,
  CanonicalPhrase,
} from "../../packages/dictionary-schema/src/index";
import {
  buildEntryNavigation,
  collectEntryPhrases,
  entryPartIndexFor,
  entryPartOptions,
  partOfSpeechTabLabel,
  projectEntryPart,
} from "../../src/features/dictionary/entry-sections";

const phrase = (id: string, display: string): CanonicalPhrase => ({
  id,
  display: { text: display, tokens: [], raw: display },
  labels: [],
  variants: [],
  leadingUsage: [],
  senses: [],
  trailingCrossReferences: [],
  raw: {},
});

test("uses compact dictionary abbreviations for sticky part-of-speech tabs", () => {
  assert.equal(partOfSpeechTabLabel("verb"), "v.");
  assert.equal(partOfSpeechTabLabel("Noun"), "n.");
  assert.equal(partOfSpeechTabLabel("adjective"), "adj.");
  assert.equal(partOfSpeechTabLabel("phrasal verb"), "phr. v.");
  assert.equal(partOfSpeechTabLabel("modal verb"), "modal verb");
});

test("resolves reverse-search parts from canonical names or display abbreviations", () => {
  const root = entry({
    partsOfSpeech: [
      { text: "noun", tokens: [], raw: "noun" },
      { text: "verb", tokens: [], raw: "verb" },
    ],
  });
  assert.equal(entryPartIndexFor(root, "noun"), 0);
  assert.equal(entryPartIndexFor(root, "n."), 0);
  assert.equal(entryPartIndexFor(root, "verb"), 1);
  assert.equal(entryPartIndexFor(root, "v."), 1);
  assert.equal(entryPartIndexFor(root, "unknown"), 0);
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
  partsOfSpeech: [],
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

test("derives semantic navigation and preserves nested phrase order", () => {
  const nested = entry({
    id: "nested",
    partsOfSpeech: [{ text: "verb", tokens: [], raw: "verb" }],
    idioms: [phrase("idiom-nested", "nested idiom")],
    phrasalVerbs: [phrase("pv-one", "first"), phrase("pv-two", "second")],
  });
  const root = entry({
    idioms: [phrase("idiom-root", "root idiom")],
    subentries: [nested],
    derivedForms: [{ kind: "derived", text: "entrywise", tokens: [], raw: "entrywise" }],
  });

  assert.deepEqual(
    buildEntryNavigation(root).map((item) => item.id),
    ["definitions", "idioms", "phrasal-verbs", "derived-forms"],
  );
  assert.deepEqual(
    collectEntryPhrases(root, "idioms").map((item) => item.id),
    ["idiom-root", "idiom-nested"],
  );
  assert.deepEqual(
    collectEntryPhrases(root, "phrasalVerbs").map((item) => item.display.text),
    ["first", "second"],
  );
  assert.deepEqual(
    entryPartOptions(root).map((part) => part.text),
    ["verb"],
  );
});

test("projects navigation and auxiliary resources within the active part of speech", () => {
  const noun = entry({
    id: "rest-noun",
    partsOfSpeech: [{ text: "noun", tokens: [], raw: "noun" }],
    idioms: [phrase("noun-idiom", "and the rest")],
    illustrations: [{ key: "musicalnotation", raw: "musicalnotation" }],
    grammarUsageBoxes: [
      {
        id: "rest-synonyms",
        type: "SYNONYMS 同义词辨析",
        blocks: [],
        body: [],
        raw: {},
      },
    ],
  });
  const verb = entry({
    id: "rest-verb",
    partsOfSpeech: [{ text: "verb", tokens: [], raw: "verb" }],
    idioms: [phrase("verb-idiom", "rest easy")],
    phrasalVerbs: [phrase("verb-pv", "rest on")],
  });
  const root = entry({ subentries: [noun, verb] });

  const nounProjection = projectEntryPart(root, 0);
  assert.equal(nounProjection.selectedPart, "noun");
  assert.deepEqual(nounProjection.subentries.map((item) => item.id), ["rest-noun"]);
  assert.deepEqual(nounProjection.navigation.map((item) => item.id), [
    "definitions",
    "idioms",
  ]);
  assert.deepEqual(nounProjection.illustrations.map((item) => item.key), [
    "musicalnotation",
  ]);
  assert.deepEqual(nounProjection.grammarUsageBoxes.map((item) => item.id), [
    "rest-synonyms",
  ]);

  const verbProjection = projectEntryPart(root, 1);
  assert.equal(verbProjection.selectedPart, "verb");
  assert.deepEqual(verbProjection.subentries.map((item) => item.id), ["rest-verb"]);
  assert.deepEqual(verbProjection.navigation.map((item) => item.id), [
    "definitions",
    "idioms",
    "phrasal-verbs",
  ]);
  assert.deepEqual(verbProjection.illustrations, []);
  assert.deepEqual(verbProjection.grammarUsageBoxes, []);
});

test("projects part-scoped headword metadata and variants", () => {
  const noun = entry({
    id: "report-noun",
    partsOfSpeech: [{ text: "noun", tokens: [], raw: "noun" }],
    labels: [
      { text: "3000", kind: "frequency", raw: "[Ox3000]" },
      { text: "A1", kind: "level", raw: "[CEFR_A1]" },
      { text: "W", kind: "academic-register", raw: "[OPAL_W]" },
    ],
    variants: [{ kind: "variant", text: "noun form", tokens: [], raw: [] }],
  });
  const verb = entry({
    id: "report-verb",
    partsOfSpeech: [{ text: "verb", tokens: [], raw: "verb" }],
    labels: [
      { text: "3000", kind: "frequency", raw: "[Ox3000]" },
      { text: "B1", kind: "level", raw: "[CEFR_B1]" },
      { text: "S", kind: "academic-register", raw: "[OPAL_S]" },
    ],
    variants: [{ kind: "variant", text: "verb form", tokens: [], raw: [] }],
  });
  const root = entry({
    labels: [
      { text: "3000", kind: "frequency", raw: "[Ox3000]" },
      { text: "A2", kind: "level", raw: "[CEFR_A2]" },
      { text: "CET4", kind: "exam", raw: "[CET4]" },
    ],
    subentries: [noun, verb],
  });

  const nounProjection = projectEntryPart(root, 0);
  assert.deepEqual(nounProjection.headerLabels.map((label) => [label.text, label.kind]), [
    ["3000", "frequency"],
    ["A1", "level"],
    ["W", "academic-register"],
    ["CET4", "exam"],
  ]);
  assert.deepEqual(nounProjection.variants.map((form) => form.text), ["noun form"]);

  const verbProjection = projectEntryPart(root, 1);
  assert.deepEqual(verbProjection.headerLabels.map((label) => [label.text, label.kind]), [
    ["3000", "frequency"],
    ["B1", "level"],
    ["S", "academic-register"],
    ["CET4", "exam"],
  ]);
  assert.deepEqual(verbProjection.variants.map((form) => form.text), ["verb form"]);
});

test("coalesces matching word-family and detailed derivative records without losing detail", () => {
  const familyNote = { text: "(opposite ungrateful)", tokens: [], raw: [] };
  const derivativeSense = {
    id: "gratefully-sense",
    order: 0,
    labels: [],
    examples: [],
    usage: [],
    usageSegments: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    subsenses: [],
    raw: {},
  };
  const root = entry({
    partsOfSpeech: [{ text: "adj.", tokens: [], raw: "adj." }],
    derivedForms: [
      {
        kind: "word-family",
        text: "entry",
        partOfSpeech: "adj.",
        note: { text: "(opposite nonentry)", tokens: [], raw: [] },
        tokens: [],
        raw: {},
      },
      {
        kind: "word-family",
        text: "gratefully",
        partOfSpeech: "adv.",
        note: familyNote,
        tokens: [],
        raw: {},
      },
      {
        id: "derived-gratefully",
        kind: "derivative",
        text: "grate\u00b7ful\u00b7ly",
        partOfSpeech: "adv.",
        tokens: [],
        pronunciations: [{ transcription: "greitfeli", raw: {} }],
        senses: [derivativeSense],
        raw: {},
      },
    ],
  });

  const projection = projectEntryPart(root, 0);
  assert.equal(projection.derivedForms.length, 1);
  assert.equal(projection.derivedForms[0]?.id, "derived-gratefully");
  assert.equal(projection.derivedForms[0]?.note, familyNote);
  assert.equal(projection.derivedForms[0]?.senses?.[0], derivativeSense);
  assert.deepEqual(
    projection.headwordFamilyNotes.map((note) => note.text),
    ["(opposite nonentry)"],
  );
});
