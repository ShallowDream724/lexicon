import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalEntry, CanonicalText } from "../../packages/dictionary-schema/src/index";
import {
  SEARCH_DOCUMENT_SCHEMA_VERSION,
  SEARCH_DOCUMENT_WEIGHTS,
  indexCanonicalEntrySearchLocations,
  projectCanonicalEntrySearchDocuments,
  searchDocumentsSchema,
} from "../../packages/dictionary-search/src/index";

const text = (value: string): CanonicalText => ({ text: value, tokens: [], raw: value });
const raw = {};

function entryFixture(): CanonicalEntry {
  return {
    schemaVersion: "1.0",
    dictionaryId: "contract-dictionary",
    sourceVersion: "test",
    id: "entry-root",
    headword: "record",
    displayHeadword: "record",
    searchKey: "record",
    labels: [],
    pronunciations: [],
    partsOfSpeech: [],
    senses: [{
      id: "sense-root",
      order: 0,
      partOfSpeech: "verb",
      labels: [],
      definition: text("to store information"),
      translation: text("记录信息"),
      examples: [{
        id: "example-root",
        text: text("Record the result."),
        translation: text("记录结果。"),
        audio: [],
        raw,
      }],
      inlineUsage: [text("spoken 使用于口语")],
      usage: [],
      usageSegments: [],
      crossReferences: [],
      illustrations: [],
      grammarUsageBoxes: [],
      subsenses: [{
        id: "sense-child",
        order: 1,
        partOfSpeech: "verb",
        labels: [],
        definition: text("to make a copy"),
        translation: text("制作副本"),
        examples: [],
        usage: [],
        usageSegments: [],
        crossReferences: [],
        illustrations: [],
        grammarUsageBoxes: [],
        subsenses: [],
        raw,
      }],
      raw,
    }],
	  subentries: [{
	    schemaVersion: "1.0",
	    dictionaryId: "contract-dictionary",
	    sourceVersion: "test",
	    id: "nested-entry",
	    headword: "recording",
	    displayHeadword: "recording",
	    searchKey: "recording",
	    labels: [],
	    pronunciations: [],
	    partsOfSpeech: [{ text: "noun", tokens: [], raw }],
	    senses: [{
	      id: "nested-sense",
	      order: 0,
	      labels: [],
	      definition: text("stored sound"),
	      translation: text("录制的声音"),
	      examples: [],
	      usage: [],
	      usageSegments: [],
	      crossReferences: [],
	      illustrations: [],
	      grammarUsageBoxes: [],
	      subsenses: [],
	      raw,
	    }],
	    subentries: [],
	    idioms: [],
	    phrasalVerbs: [],
	    derivedForms: [],
	    inflectedForms: [],
	    crossReferences: [],
	    illustrations: [],
	    grammarUsageBoxes: [],
	    raw,
	  }],
    idioms: [{
      id: "idiom-record-straight",
      display: text("set the record straight"),
      labels: [],
      variants: [],
      leadingUsage: [],
      senses: [{
        id: "idiom-sense",
        order: 0,
        labels: [],
        definition: text("to correct a false account"),
        translation: text("澄清事实"),
        examples: [],
        usage: [],
        usageSegments: [],
        crossReferences: [],
        illustrations: [],
        grammarUsageBoxes: [],
        subsenses: [],
        raw,
      }],
      trailingCrossReferences: [],
      raw,
    }],
    phrasalVerbs: [],
    derivedForms: [{
      id: "form-recorder",
      kind: "derivative",
      text: "recorder",
      note: text("记录装置"),
      tokens: [],
      variants: [{
        id: "form-recorder-variant",
        kind: "variant",
        text: "recording device",
        note: text("录音设备"),
        tokens: [],
        raw,
      }],
      inflectedForms: [],
      senses: [{
        id: "form-sense",
        order: 0,
        labels: [],
        definition: text("a device that records sound"),
        translation: text("录音机"),
        examples: [],
        usage: [],
        usageSegments: [],
        crossReferences: [],
        illustrations: [],
        grammarUsageBoxes: [],
        subsenses: [],
        raw,
      }],
      raw,
    }],
    inflectedForms: [],
    variants: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [{
      id: "box-record",
      title: text("Recording 录音说明"),
      blocks: [{
        kind: "paragraph",
        value: text("Use this form 这样使用"),
        segments: [{ kind: "text", value: text("in formal writing 正式书写中"), raw }],
        raw,
      }, {
        kind: "list",
        items: [{
          segments: [{
            kind: "example",
            value: { id: "box-list-example", text: text("Keep a record."), translation: text("保留记录。"), audio: [], raw },
            raw,
          }],
          raw,
        }],
        raw,
      }, {
        kind: "table",
        rows: [{
          cells: [{
            header: false,
            value: text("written record 书面记录"),
            segments: [{
              kind: "example",
              value: { id: "box-table-example", text: text("The record remains."), translation: text("记录仍然存在。"), audio: [], raw },
              raw,
            }],
            raw,
          }],
          raw,
        }],
        raw,
      }],
      body: [],
      raw,
    }],
    raw: { hiddenChinese: "原始中文不得进入索引" },
  };
}

test("projects canonical bilingual content recursively with stable document locations", () => {
  const documents = projectCanonicalEntrySearchDocuments(entryFixture());
  searchDocumentsSchema.parse(documents);
  assert.equal(SEARCH_DOCUMENT_SCHEMA_VERSION, "1.0");

  const rootSense = documents.find((document) => document.location.ownerId === "sense-root");
  assert.deepEqual(rootSense?.location, {
    section: "definitions",
    part: "verb",
    ownerId: "sense-root",
    path: ["senses", "0"],
  });
  assert.equal(rootSense?.weight, SEARCH_DOCUMENT_WEIGHTS.sense);
  assert.equal(documents.some((document) => document.location.ownerId === "sense-child"), true);

  const phrase = documents.find((document) => document.location.ownerId === "idiom-record-straight");
  assert.equal(phrase?.scope, "phrase");
  assert.equal(phrase?.englishText, "set the record straight to correct a false account");
  assert.equal(phrase?.chineseText, "澄清事实");
  assert.equal(phrase?.weight, SEARCH_DOCUMENT_WEIGHTS.phrase);

  assert.equal(documents.some((document) => document.location.ownerId === "example-root" && document.scope === "example"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "box-list-example" && document.scope === "example"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "box-table-example" && document.scope === "example"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "form-recorder-variant" && document.scope === "form"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "form-sense" && document.scope === "sense"), true);
	  const nested = documents.find((document) => document.location.ownerId === "nested-sense");
	  assert.equal(nested?.entryId, "entry-root");
	  assert.equal(nested?.headword, "record");
	  assert.equal(nested?.location.part, "noun");
	  assert.deepEqual(nested?.location.path, ["subentries", "0", "senses", "0"]);
  assert.equal(documents.some((document) => document.chineseText.includes("原始中文不得进入索引")), false);
});

test("keeps identical text at distinct locations and omits content without Chinese", () => {
  const entry = entryFixture();
  entry.senses.push({
    id: "sense-duplicate-text",
    order: 2,
    labels: [],
    definition: text("to store information"),
    translation: text("记录信息"),
    examples: [],
    usage: [],
    usageSegments: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    subsenses: [],
    raw,
  }, {
    id: "sense-english-only",
    order: 3,
    labels: [],
    definition: text("English-only definition"),
    examples: [],
    usage: [text("English-only usage")],
    usageSegments: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    subsenses: [],
    raw,
  });

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const sameText = documents.filter((document) => document.chineseText === "记录信息");
  assert.equal(sameText.length, 2);
  assert.deepEqual(sameText.map((document) => document.location.path), [["senses", "0"], ["senses", "1"]]);
  assert.equal(documents.some((document) => document.englishText.includes("English-only")), false);
  assert.equal(documents.every((document) => /\p{Script=Han}/u.test(document.chineseText)), true);
});

test("indexes rendered canonical objects with the projector's exact locations", () => {
  const entry = entryFixture();
  const index = indexCanonicalEntrySearchLocations(entry);

  assert.deepEqual(index.get(entry.senses[0]!), {
    section: "definitions",
    part: "verb",
    ownerId: "sense-root",
    path: ["senses", "0"],
  });
  assert.deepEqual(index.get(entry.senses[0]!.examples[0]!), {
    section: "definitions",
    part: "verb",
    ownerId: "example-root",
    path: ["senses", "0", "examples", "0"],
  });
  assert.deepEqual(index.get(entry.derivedForms[0]!.variants![0]!), {
    section: "derived-forms",
    ownerId: "form-recorder-variant",
    path: ["derivedForms", "0", "variants", "0"],
  });
  assert.deepEqual(index.get(entry.grammarUsageBoxes[0]!), {
    section: "grammar-usage",
    ownerId: "box-record",
    path: ["grammarUsageBoxes", "0"],
  });
});
