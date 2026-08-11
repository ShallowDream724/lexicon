import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalEntry, CanonicalForm, CanonicalText } from "../../packages/dictionary-schema/src/index";
import {
  SEARCH_DOCUMENT_MAX_HEADWORD_FORMS,
  SEARCH_DOCUMENT_SCHEMA_VERSION,
  SEARCH_DOCUMENT_WEIGHTS,
  indexCanonicalEntrySearchLocations,
  projectCanonicalEntryHeadwordForms,
  projectCanonicalEntrySearchDocuments,
  searchDocumentsSchema,
} from "../../packages/dictionary-search/src/index";
import { enrichSearchDocumentsWithObservedHeadwordForms } from "../../packages/dictionary-search/src/build-headword-forms";

const text = (value: string): CanonicalText => ({ text: value, tokens: [], raw: value });
const taggedText = (...tokens: Array<{ tag?: string; text: string }>): CanonicalText => ({
  text: tokens.map((token) => token.text).join(""),
  tokens: tokens.map((token) => ({ ...token, raw: {} })),
  raw: {},
});
const raw = {};

function form(text: string, kind = "inflection"): CanonicalForm {
  return { kind, text, tokens: [], variants: [], inflectedForms: [], senses: [], raw };
}

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
  assert.equal(SEARCH_DOCUMENT_SCHEMA_VERSION, "2.2");

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
  assert.equal(phrase?.candidateText, "set the record straight");
  assert.equal(phrase?.definitionText, "to correct a false account");
  assert.equal(phrase?.chineseText, "澄清事实");
  assert.equal(phrase?.weight, SEARCH_DOCUMENT_WEIGHTS.phrase);
  assert.equal(phrase?.semanticRole, "definition");

  assert.equal(documents.some((document) => document.location.ownerId === "example-root" && document.scope === "example"), true);
  assert.equal(documents.some((document) =>
    document.location.ownerId === "box-list-example" &&
    document.scope === "resource" &&
    document.semanticRole === "example" &&
    document.resourceCategory === "other",
  ), true);
  assert.equal(documents.some((document) => document.location.ownerId === "box-table-example" && document.scope === "resource"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "form-recorder-variant" && document.scope === "form"), true);
  assert.equal(documents.some((document) => document.location.ownerId === "form-sense" && document.scope === "sense"), true);
	  const nested = documents.find((document) => document.location.ownerId === "nested-sense");
	  assert.equal(nested?.entryId, "entry-root");
	  assert.equal(nested?.headword, "record");
	  assert.equal(nested?.location.part, "noun");
	  assert.deepEqual(nested?.location.path, ["subentries", "0", "senses", "0"]);
  assert.equal(documents.some((document) => document.chineseText.includes("原始中文不得进入索引")), false);
});

test("attaches canonical grammar patterns as English lookup metadata without adding search documents", () => {
  const entry = entryFixture();
  entry.headwordPatterns = [text("record sth as sth")];
  entry.senses[0]!.patterns = [text("record sth")];
  const withoutPatterns = entryFixture();

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const baseline = projectCanonicalEntrySearchDocuments(withoutPatterns);
  const rootSense = documents.find((document) => document.location.ownerId === "sense-root");

  assert.equal(documents.length, baseline.length);
  assert.deepEqual(rootSense?.englishLookupTerms, [
    { kind: "pattern", text: "record sth as sth" },
    { kind: "pattern", text: "record sth" },
  ]);
  searchDocumentsSchema.parse(documents);
  assert.throws(() => searchDocumentsSchema.parse([{
    ...rootSense,
    englishLookupTerms: [{ kind: "unknown", text: "record sth" }],
  }]));
});

test("keeps definition qualifiers and true usage notes attached to their owning sense", () => {
  const entry = entryFixture();
  entry.senses[0]!.inlineUsage = [
    { ...text("usually disapproving 通常含贬义"), origin: "dis-g" },
    { ...text("not usually before a noun 通常不用于名词前"), origin: "use" },
  ];

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const qualifier = documents.find((document) => document.origin === "dis-g");
  const guidance = documents.find((document) => document.origin === "use");

  assert.equal(qualifier?.scope, "sense");
  assert.equal(qualifier?.semanticRole, "qualifier");
  assert.equal(guidance?.scope, "sense");
  assert.equal(guidance?.semanticRole, "guidance");
});

test("projects bilingual sense guidewords as qualifiers of their owning result", () => {
  const entry = entryFixture();
  entry.senses[0]!.groupHeading = text("LIQUID/GAS 液体；气体");

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const guideword = documents.find((document) =>
    document.location.path.join("/") === "senses/0/groupHeading",
  );

  assert.equal(guideword?.scope, "sense");
  assert.equal(guideword?.englishText, "LIQUID/GAS");
  assert.equal(guideword?.chineseText, "液体；气体");
  assert.equal(guideword?.semanticRole, "qualifier");
  assert.equal(guideword?.location.ownerId, "sense-root");
});

test("collects authoritative headword forms without admitting constructions or derivatives", () => {
  const think = entryFixture();
  think.headword = "think";
  think.displayHeadword = "think";
  think.searchKey = "think";
  think.partsOfSpeech = [{ text: "verb", tokens: [], raw }];
  think.inflectedForms = [form("thought"), form("  THOUGHT  ")];
  think.variants = [form("think", "variant"), form("think about", "variant")];
  think.derivedForms = [form("thinker", "derivative")];
  think.senses[0]!.variants = [form("suppose", "variant"), form("not think", "variant")];
  think.senses[0]!.inflectedForms = [form("thinks")];
  think.senses[0]!.subsenses[0]!.inflectedForms = [form("thinking")];
  think.subentries[0]!.headword = "color";
  think.subentries[0]!.variants = [form("colour", "variant")];

  const thinkForms = projectCanonicalEntryHeadwordForms(think);
  assert.deepEqual(thinkForms, ["thought", "thinks", "thinking"]);
  assert.equal(thinkForms.includes("thinker"), false);
  assert.equal(thinkForms.includes("suppose"), false);
  assert.equal(thinkForms.includes("not think"), false);
  assert.equal(thinkForms.includes("colour"), false);
  assert.equal(thinkForms.includes("think"), false);
  assert.equal(thinkForms.includes("thinked"), false);

  const documents = projectCanonicalEntrySearchDocuments(think);
  assert.equal(documents.length > 0, true);
  assert.equal(documents.every((document) => document.headwordForms === documents[0]!.headwordForms), true);
  assert.deepEqual(documents[0]!.headwordForms, thinkForms);

  const twist = entryFixture();
  twist.headword = "twist";
  twist.displayHeadword = "twist";
  twist.searchKey = "twist";
  twist.partsOfSpeech = [{ text: "verb", tokens: [], raw }];
  twist.senses[0]!.examples[0]!.text = text("I twisted around.");
  assert.deepEqual(projectCanonicalEntryHeadwordForms(twist), []);
  const twistDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    twist,
    projectCanonicalEntrySearchDocuments(twist),
  );
  assert.deepEqual(twistDocuments[0]!.headwordForms, ["twisted"]);

  const color = entryFixture();
  color.headword = "color";
  color.displayHeadword = "color";
  color.searchKey = "color";
  color.variants = [form("colour", "variant")];
  color.partsOfSpeech = [{ text: "noun", tokens: [], raw }];
  color.senses[0]!.partOfSpeech = "noun";
  color.senses[0]!.examples[0]!.text = text("The colours faded.");
  assert.deepEqual(projectCanonicalEntryHeadwordForms(color), ["colour"]);
  const colorDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    color,
    projectCanonicalEntrySearchDocuments(color),
  );
  assert.deepEqual(colorDocuments[0]!.headwordForms, ["colour", "colours"]);
});

test("recognizes observed regular forms without inventing malformed inflections", () => {
  const observed = (headword: string, part: string, example: string, declared: string[] = []): string[] => {
    const entry = entryFixture();
    entry.headword = headword;
    entry.displayHeadword = headword;
    entry.searchKey = headword;
    entry.partsOfSpeech = [{ text: part, tokens: [], raw }];
    entry.senses[0]!.partOfSpeech = part;
    entry.senses[0]!.examples[0]!.text = text(example);
    entry.inflectedForms = declared.map((value) => form(value));
    const documents = enrichSearchDocumentsWithObservedHeadwordForms(
      entry,
      projectCanonicalEntrySearchDocuments(entry),
    );
    return documents[0]?.headwordForms ?? [];
  };

  assert.deepEqual(observed("child", "noun", "The children laughed.", ["children"]), ["children"]);
  assert.deepEqual(observed("run", "verb", "She was running."), ["running"]);
  assert.deepEqual(observed("write", "verb", "She wrote it.", ["wrote", "written"]), ["wrote", "written", "writing"]);
  assert.equal(observed("child", "noun", "The children laughed.", ["children"]).includes("childs"), false);
  assert.equal(observed("run", "verb", "She was running.").includes("runing"), false);
  assert.equal(observed("write", "verb", "She wrote it.", ["wrote", "written"]).includes("writed"), false);
});

test("binds observed morphology to same-headword entry paths and known parts of speech", () => {
  const root = entryFixture();
  root.subentries[0]!.senses[0]!.examples = [{
    id: "nested-example",
    text: text("The records survived."),
    translation: text("这些记录保留了下来。"),
    audio: [],
    raw,
  }];
  const rootDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    root,
    projectCanonicalEntrySearchDocuments(root),
  );
  assert.equal(rootDocuments[0]?.headwordForms?.includes("records") ?? false, false);

  root.subentries[0]!.headword = "record";
  root.subentries[0]!.displayHeadword = "record";
  root.subentries[0]!.searchKey = "record";
  const sameHeadwordDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    root,
    projectCanonicalEntrySearchDocuments(root),
  );
  assert.equal(sameHeadwordDocuments[0]?.headwordForms?.includes("records"), true);

  const unknownPart = entryFixture();
  unknownPart.headword = "twist";
  unknownPart.displayHeadword = "twist";
  unknownPart.searchKey = "twist";
  unknownPart.partsOfSpeech = [];
  unknownPart.senses[0]!.partOfSpeech = undefined;
  unknownPart.senses[0]!.examples[0]!.text = text("It twisted.");
  const unknownPartDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    unknownPart,
    projectCanonicalEntrySearchDocuments(unknownPart),
  );
  assert.equal(unknownPartDocuments[0]?.headwordForms?.includes("twisted") ?? false, false);

  const accented = entryFixture();
  accented.headword = "café";
  accented.displayHeadword = "café";
  accented.searchKey = "café";
  accented.partsOfSpeech = [{ text: "noun", tokens: [], raw }];
  accented.senses[0]!.partOfSpeech = "noun";
  accented.senses[0]!.examples[0]!.text = text("Two cafés closed.");
  const accentedDocuments = enrichSearchDocumentsWithObservedHeadwordForms(
    accented,
    projectCanonicalEntrySearchDocuments(accented),
  );
  assert.equal(accentedDocuments[0]?.headwordForms?.includes("cafés"), true);
});

test("bounds the self-contained headword form projection deterministically", () => {
  const entry = entryFixture();
  entry.inflectedForms = Array.from(
    { length: SEARCH_DOCUMENT_MAX_HEADWORD_FORMS + 6 },
    (_, index) => form(`recorded-${String(index).padStart(2, "0")}`),
  );
  entry.inflectedForms.splice(1, 0, form("x".repeat(257)));

  const forms = projectCanonicalEntryHeadwordForms(entry);
  assert.equal(forms.length, SEARCH_DOCUMENT_MAX_HEADWORD_FORMS);
  assert.equal(forms.includes("x".repeat(257)), false);
  assert.deepEqual(forms.slice(0, 2), ["recorded-00", "recorded-01"]);

  const document = projectCanonicalEntrySearchDocuments(entry)[0]!;
  assert.throws(() => searchDocumentsSchema.parse([{ ...document, headwordForms: [...forms, "overflow"] }]));
  assert.throws(() => searchDocumentsSchema.parse([{ ...document, headwordForms: [" "] }]));
});

test("uses canonical proficiency and frequency labels as a source-neutral ranking prior", () => {
  const common = entryFixture();
  common.labels = [
    { text: "A1", kind: "level", raw },
    { text: "3000", kind: "frequency", raw },
  ];
  const advanced = entryFixture();
  advanced.labels = [{ text: "C1", kind: "level", raw }];

  const commonSense = projectCanonicalEntrySearchDocuments(common).find((document) => document.scope === "sense");
  const advancedSense = projectCanonicalEntrySearchDocuments(advanced).find((document) => document.scope === "sense");
  assert.equal((commonSense?.weight ?? 0) > (advancedSense?.weight ?? 0), true);
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

test("projects rich box segments without aggregate duplicates and preserves token language boundaries", () => {
  const entry = entryFixture();
  const box = entry.grammarUsageBoxes[0]!;
  box.resourceCategory = "express-yourself";
  const paragraph = box.blocks[0]!;
  assert.equal(paragraph.kind, "paragraph");
  box.title = taggedText({ tag: "eng", text: "Object-like detail" }, { tag: "simp", text: "对象式细节。" });
  paragraph.value = taggedText({ tag: "eng", text: "Object-like summary" }, { tag: "simp", text: "对象式摘要。" });
  paragraph.segments = [{
    kind: "text",
    value: taggedText({ tag: "eng", text: "Object-like detail" }, { tag: "simp", text: "对象式细节。" }),
    raw,
  }, {
    kind: "term",
    headword: taggedText({ tag: "eng", text: "object form" }, { tag: "simp", text: "对象形式。" }),
    raw,
  }];

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const boxDocuments = documents.filter((document) => document.location.ownerId === "box-record");
  assert.equal(boxDocuments.some((document) => document.location.path.join("/").endsWith("blocks/0/value")), false);
  assert.equal(boxDocuments.some((document) => document.location.path.join("/").endsWith("blocks/0/segments/0")), true);
  assert.equal(boxDocuments.some((document) => document.location.path.join("/").endsWith("blocks/0/segments/1")), true);
  const detail = boxDocuments.find((document) => document.location.path.join("/").endsWith("blocks/0/segments/0"));
  assert.equal(boxDocuments.filter((document) => document.chineseText === "对象式细节。").length, 1);
  assert.equal(detail?.englishText, "Object-like detail");
  assert.equal(detail?.chineseText, "对象式细节。");
  assert.equal(detail?.scope, "resource");
  assert.equal(detail?.semanticRole, "context");
  assert.equal(detail?.origin, "grammar-usage-box");
  assert.equal(detail?.resourceCategory, "express-yourself");
  assert.equal(/[，。！？；：、】【、】【（）《》〈〉「」『』]/u.test(detail?.englishText ?? ""), false);
  assert.equal(boxDocuments.some((document) => document.location.path.includes("rows")), false);
  assert.equal(documents.some((document) => document.location.ownerId === "box-list-example" && document.scope === "resource"), true);
  assert.equal(documents.some((document) =>
    document.location.ownerId === "box-list-example" &&
    document.scope === "resource" &&
    document.semanticRole === "example" &&
    document.resourceCategory === "express-yourself",
  ), true);
  assert.equal(documents.some((document) => document.location.ownerId === "box-table-example" && document.scope === "resource"), true);
});

test("assigns stable semantic roles to resource evidence and usage guidance", () => {
  const entry = entryFixture();
  const box = entry.grammarUsageBoxes[0]!;
  box.title = taggedText(
    { tag: "eng", text: "Agreeing" },
    { tag: "simp", text: "表示赞同" },
  );
  box.blocks = [{
    kind: "list",
    items: [{
      segments: [{
        kind: "text",
        value: text("I couldn't agree more."),
        term: text("I couldn't agree more"),
        raw,
      }],
      raw,
    }, {
      segments: [{ kind: "text", value: text("English-only background."), raw }],
      raw,
    }],
    raw,
  }];

  const documents = projectCanonicalEntrySearchDocuments(entry);
  searchDocumentsSchema.parse(documents);
  const direct = documents.find((document) => document.candidateText === "I couldn't agree more");
  assert.equal(direct?.scope, "resource");
  assert.equal(direct?.chineseText, "表示赞同");
  assert.equal(direct?.semanticRole, "expression");
  assert.equal(direct?.origin, "grammar-usage-box");
  assert.equal(documents.some((document) => document.englishText === "English-only background."), false);

  const title = documents.find((document) => document.location.path.at(-1) === "title");
  assert.equal(title?.semanticRole, "heading");
  assert.equal(title?.resourceCategory, "other");
  const inline = documents.find((document) => document.location.path.includes("inlineUsage"));
  assert.equal(inline?.scope, "sense");
  assert.equal(inline?.semanticRole, "guidance");
  assert.equal(documents.every((document) => document.semanticRole.length > 0), true);

  const sense = documents.find((document) => document.scope === "sense")!;
  assert.throws(() => searchDocumentsSchema.parse([{ ...sense, resourceCategory: "grammar" }]));
  assert.throws(() => searchDocumentsSchema.parse([{ ...direct, resourceCategory: undefined }]));
});

test("treats an empty structured term as missing and falls back to the owning expression", () => {
  const entry = entryFixture();
  const derived = entry.derivedForms[0]!;
  derived.senses![0]!.grammarUsageBoxes = [{
    id: "box-empty-term",
    title: text("Construction 构式"),
    blocks: [{
      kind: "list",
      items: [{
        segments: [{
          kind: "text",
          value: text("usually singular 通常用单数"),
          term: text("   "),
          raw,
        }],
        raw,
      }],
      raw,
    }],
    body: [],
    raw,
  }];

  const match = projectCanonicalEntrySearchDocuments(entry).find((document) =>
    document.location.ownerId === "box-empty-term" &&
    document.semanticRole === "context",
  );

  assert.equal(match?.candidateText, "recorder");
  assert.equal(match?.definitionText, "usually singular");
  assert.equal(match?.scope, "resource");
});

test("keeps the owning phrase or form visible for contextual usage evidence", () => {
  const entry = entryFixture();
  const phrase = entry.idioms[0]!;
  phrase.leadingUsage = [text("(used for emphasis) 用于强调")];
  phrase.senses[0]!.inlineUsage = [text("(not for any reason) 表示绝不")];

  const derived = entry.derivedForms[0]!;
  derived.usage = [text("(usually singular) 通常用单数")];
  derived.senses![0]!.usage = [text("(mainly British English) 主要用于英式英语")];
  const sameHeadwordSubentry = entry.subentries[0]!;
  sameHeadwordSubentry.headword = "record";
  sameHeadwordSubentry.displayHeadword = "re·cord";
  sameHeadwordSubentry.headwordUsage = [text("(technical) 技术用语")];

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const contextual = documents.filter((document) =>
    ["sense", "phrase", "form"].includes(document.scope) && document.semanticRole === "guidance",
  );

  assert.deepEqual(
    contextual.map((document) => [
      document.scope,
      document.candidateText,
      document.definitionText,
      document.chineseText,
    ]),
    [
      ["sense", undefined, undefined, "使用于口语"],
      ["phrase", "set the record straight", "(used for emphasis)", "用于强调"],
      ["phrase", "set the record straight", "(not for any reason)", "表示绝不"],
      ["form", "recorder", "(usually singular)", "通常用单数"],
      ["sense", "recorder", "(mainly British English)", "主要用于英式英语"],
      ["sense", undefined, undefined, "技术用语"],
    ],
  );
  const sameHeadwordUsage = documents.find((document) =>
    document.scope === "sense" && document.semanticRole === "guidance" &&
    document.location.path[0] === "subentries",
  );
  assert.equal(sameHeadwordUsage?.candidateText, undefined);
  assert.equal(sameHeadwordUsage?.definitionText, undefined);
});

test("coalesces compatibility text with its structured segment under the same owner", () => {
  const entry = entryFixture();
  const repeated = taggedText(
    { tag: "eng", text: "Use this form carefully." },
    { tag: "simp", text: "谨慎使用这一形式。" },
  );
  entry.senses[0]!.usage = [repeated];
  entry.senses[0]!.usageSegments = [{ kind: "text", value: repeated, raw }];

  const matches = projectCanonicalEntrySearchDocuments(entry).filter((document) =>
    document.scope === "sense" && document.semanticRole === "guidance" &&
    document.location.ownerId === "sense-root" &&
    document.chineseText === "谨慎使用这一形式。",
  );

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.location.path, ["senses", "0", "usageSegments", "0"]);
});

test("keeps one deepest projection for a repeated box id while retaining equal text for distinct owners", () => {
  const entry = entryFixture();
  const repeated = entry.grammarUsageBoxes[0]!;
  entry.senses[0]!.grammarUsageBoxes.push(repeated);
  entry.senses.push({
    id: "sense-equal-text",
    order: 4,
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
  });

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const repeatedDocuments = documents.filter((document) =>
    document.location.path.includes("grammarUsageBoxes") &&
    document.location.ownerId === "box-record",
  );
  assert.equal(repeatedDocuments.length > 0, true);
  assert.equal(repeatedDocuments.every((document) => document.location.path[0] === "senses"), true);
  assert.equal(documents.filter((document) => document.chineseText === "记录信息").length, 2);

  const index = indexCanonicalEntrySearchLocations(entry);
  assert.deepEqual(index.get(repeated), {
    section: "grammar-usage",
    part: "verb",
    ownerId: "box-record",
    path: ["senses", "0", "grammarUsageBoxes", "0"],
  });
});

test("uses tagged Chinese text once when examples carry a language-like duplicate", () => {
  const entry = entryFixture();
  entry.senses[0]!.examples[0] = {
    id: "language-duplicate",
    text: taggedText(
      { tag: "eng", text: "The process works." },
      { tag: "simp", text: "过程有效。" },
    ),
    translation: taggedText({ tag: "simp", text: "过程有效。" }),
    audio: [],
    raw,
  };

  const document = projectCanonicalEntrySearchDocuments(entry).find(
    (candidate) => candidate.location.ownerId === "language-duplicate",
  );
  assert.equal(document?.englishText, "The process works.");
  assert.equal(document?.chineseText, "过程有效。");
});

test("preserves traditional and unlabelled bilingual tokens without weakening language boundaries", () => {
  const entry = entryFixture();
  entry.senses[0]!.definition = taggedText(
    { tag: "strong", text: "a lexical" },
    { tag: "custom-br", text: "" },
    { tag: "eng", text: "item" },
  );
  entry.senses[0]!.translation = taggedText({ tag: "trad", text: "詞彙" });
  entry.senses[0]!.inlineUsage = [taggedText({ tag: "strong", text: "formal 正式" })];

  const documents = projectCanonicalEntrySearchDocuments(entry);
  const sense = documents.find((document) => document.location.ownerId === "sense-root" && document.scope === "sense");
  const usage = documents.find((document) => document.location.ownerId === "sense-root" && document.scope === "sense" && document.semanticRole === "guidance");

  assert.equal(sense?.englishText, "a lexical item");
  assert.equal(sense?.chineseText, "詞彙");
  assert.equal(usage?.englishText, "formal");
  assert.equal(usage?.chineseText, "正式");
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
