import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BundledBilingualAdapter } from "../../packages/adapters/src/index";
import type { CanonicalEntry } from "../../packages/dictionary-schema/src/index";
import { EntryView } from "../../src/features/dictionary/components/EntryView";
import { projectEntryPart } from "../../src/features/dictionary/entry-sections";

test("renders one separator between adjacent inflection labels", () => {
  const entry = new BundledBilingualAdapter({ dictionaryId: "fixture" }).parse({
    entryId: "round-adjective",
    headword: "round",
    sourceVersion: "fixture-v1",
    body: {
      top_data: {
        h: [{ tag: "h", value: "round" }],
        pos: [{ tag: "pos", value: "adj." }],
        top_text: [
          { tag: "if-gs", value: " (", path: "top-g/if-gs" },
          { tag: "if-g", value: "comparative ", path: "top-g/if-gs/if-g" },
          { tag: "if", value: "rounder", path: "top-g/if-gs/if-g/if" },
          { tag: "if-g", value: ", superlative ", path: "top-g/if-gs/if-g" },
          { tag: "if", value: "roundest", path: "top-g/if-gs/if-g/if" },
          { tag: "if-gs", value: ")", path: "top-g/if-gs" },
        ],
      },
      sngs_data: [],
    },
  });
  const html = renderToStaticMarkup(
    createElement(EntryView, {
      entry,
      projection: projectEntryPart(entry, 0),
      favorite: false,
      entryPending: false,
      activeSectionId: "definitions",
      audioError: null,
      resolveIllustration: (key: string) => key,
      onPartChange() {},
      onJump() {},
      onToggleFavorite() {},
      onOpenNote() {},
      onSelectEntry() {},
      onPlayAudio() {},
    }),
  );
  const visibleText = html.replace(/<[^>]*>/g, "");

  assert.match(visibleText, /\(comparative rounder, superlative roundest\)/);
  assert.doesNotMatch(visibleText, /rounder,\s*,\s*superlative/);
});

test("renders primary phrase labels before regional equivalent forms", () => {
  const entry: CanonicalEntry = {
    schemaVersion: "1.0",
    dictionaryId: "fixture",
    sourceVersion: "fixture-v1",
    id: "pull",
    headword: "pull",
    displayHeadword: "pull",
    searchKey: "pull",
    labels: [],
    pronunciations: [],
    partsOfSpeech: [],
    senses: [],
    subentries: [],
    idioms: [
      {
        id: "pull-up-stakes",
        display: { text: "ˌpull up ˈstakes", tokens: [], raw: {} },
        labels: [{ text: "NAmE", kind: "geo", raw: {} }],
        variants: [
          {
            kind: "variant",
            text: "ˌup ˈsticks",
            relation: "equivalent",
            labels: [{ text: "BrE", kind: "geo", raw: {} }],
            tokens: [],
            raw: {},
          },
        ],
        leadingUsage: [],
        senses: [],
        trailingCrossReferences: [],
        raw: {},
      },
    ],
    phrasalVerbs: [],
    derivedForms: [],
    inflectedForms: [],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    raw: {},
  };

  const html = renderToStaticMarkup(
    createElement(EntryView, {
      entry,
      projection: projectEntryPart(entry, 0),
      favorite: false,
      entryPending: false,
      activeSectionId: "definitions",
      audioError: null,
      resolveIllustration: (key: string) => key,
      onPartChange() {},
      onJump() {},
      onToggleFavorite() {},
      onOpenNote() {},
      onSelectEntry() {},
      onPlayAudio() {},
    }),
  );

  const primaryLabel = html.indexOf("(NAmE)");
  const regionalVariant = html.indexOf('class="phrase-variant-label">BrE</em>');
  assert.ok(primaryLabel >= 0, "primary phrase label is missing");
  assert.ok(regionalVariant > primaryLabel, "regional variant rendered before primary label");
  assert.doesNotMatch(html, /phrase-variant-equivalence/);
});

test("renders semantic or-relations and source-owned label separators without synthetic commas", () => {
  const entry: CanonicalEntry = {
    schemaVersion: "1.0",
    dictionaryId: "fixture",
    sourceVersion: "fixture-v1",
    id: "labels",
    headword: "labels",
    displayHeadword: "labels",
    searchKey: "labels",
    labels: [
      { text: "formal", kind: "reg", raw: {} },
      { text: "or", kind: "or", raw: {} },
      { text: "humorous", kind: "reg", raw: {} },
    ],
    pronunciations: [],
    partsOfSpeech: [],
    senses: [{
      id: "sense-with-variant",
      order: 0,
      labels: [],
      patterns: [],
      variants: [{
        kind: "variant",
        text: "a/c",
        labels: [{ text: "especially in BrE", kind: "geo", raw: {} }],
        presentation: [
          {
            kind: "introducer",
            value: { text: "abbr.", tokens: [], raw: {} },
          },
          { kind: "target" },
          {
            kind: "label",
            value: { text: "especially in BrE", kind: "geo", raw: {} },
          },
        ],
        tokens: [],
        raw: {},
      }],
      examples: [],
      inlineUsage: [],
      usage: [],
      usageSegments: [],
      crossReferences: [],
      illustrations: [],
      grammarUsageBoxes: [],
      subsenses: [],
      raw: {},
    }],
    subentries: [],
    idioms: [],
    phrasalVerbs: [],
    derivedForms: [{
      kind: "derivative",
      text: "anarchic",
      labels: [
        { text: "countable", kind: "gram", raw: {} },
        { text: "uncountable", kind: "gram", separatorBefore: ";", raw: {} },
      ],
      variants: [{
        kind: "variant",
        text: "anarchical",
        introducer: { text: "also", tokens: [], raw: {} },
        labels: [{ text: "less frequent", kind: "reg", raw: {} }],
        presentation: [
          {
            kind: "introducer",
            value: { text: "also", tokens: [], raw: {} },
          },
          {
            kind: "label",
            value: { text: "less frequent", kind: "reg", raw: {} },
          },
          { kind: "target" },
        ],
        tokens: [],
        raw: {},
      }],
      tokens: [],
      raw: {},
    }],
    inflectedForms: [],
    variants: [{
      kind: "variant",
      text: "labelled",
      labels: [
        { text: "NAmE", kind: "geo", raw: {} },
        { text: "BrE", kind: "geo", separatorBefore: ",", raw: {} },
      ],
      tokens: [],
      raw: {},
    }],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    raw: {},
  };

  const html = renderToStaticMarkup(
    createElement(EntryView, {
      entry,
      projection: projectEntryPart(entry, 0),
      favorite: false,
      entryPending: false,
      activeSectionId: "definitions",
      audioError: null,
      resolveIllustration: (key: string) => key,
      onPartChange() {},
      onJump() {},
      onToggleFavorite() {},
      onOpenNote() {},
      onSelectEntry() {},
      onPlayAudio() {},
    }),
  );

  assert.match(html, /\(formal or humorous\)/);
  assert.doesNotMatch(html, /formal, or, humorous/);
  assert.match(html, /NAmE<\/em><em[^>]*>, BrE<\/em> <strong/);
  assert.doesNotMatch(html, /NAmE , BrE/);
  assert.match(html, /also<\/em><em[^>]*> less frequent<\/em> <strong[^>]*>anarchical/);
  assert.doesNotMatch(html, /less frequent<\/em><em[^>]*> also/);
  assert.match(html, /\[countable; uncountable\]/);
  assert.doesNotMatch(html, /\[countable, uncountable\]/);
  assert.match(
    html,
    /class="sense-variants"[^]*abbr\.<\/em> <strong[^>]*>a\/c<\/strong><em[^>]*> especially in BrE/,
  );
});

test("renders usage and inflection groups at headword, sense, and derivative scopes", () => {
  const entry: CanonicalEntry = {
    schemaVersion: "1.0",
    dictionaryId: "fixture",
    sourceVersion: "fixture-v1",
    id: "scoped-forms",
    headword: "slow",
    displayHeadword: "slow",
    searchKey: "slow",
    labels: [],
    pronunciations: [],
    partsOfSpeech: [],
    headwordUsage: [{ text: "(not usually before a noun)", tokens: [], raw: {} }],
    inflectedForms: [
      {
        kind: "inflection",
        text: "slower",
        introducer: { text: "comparative", tokens: [], raw: {} },
        tokens: [],
        raw: {},
      },
      {
        kind: "inflection-constraint",
        text: "no superlative",
        tokens: [],
        raw: {},
      },
    ],
    senses: [{
      id: "slow-sense",
      order: 0,
      labels: [],
      pronunciations: [{
        region: "BrE",
        transcription: "sl\u0259\u028a",
        audioKey: "slow#_gb_2",
        raw: {},
      }],
      inflectedForms: [{
        kind: "inflection",
        text: "examples",
        introducer: { text: "plural", tokens: [], raw: {} },
        tokens: [],
        raw: {},
      }],
      examples: [],
      usage: [],
      usageSegments: [],
      crossReferences: [],
      illustrations: [],
      grammarUsageBoxes: [],
      subsenses: [],
      raw: {},
    }],
    subentries: [],
    idioms: [],
    phrasalVerbs: [],
    derivedForms: [{
      kind: "derivative",
      text: "slowness",
      usage: [{ text: "(in nouns)", tokens: [], raw: {} }],
      inflectedForms: [{
        kind: "inflection",
        text: "slownesses",
        introducer: { text: "plural", tokens: [], raw: {} },
        tokens: [],
        raw: {},
      }],
      tokens: [],
      raw: {},
    }],
    crossReferences: [],
    illustrations: [],
    grammarUsageBoxes: [],
    raw: {},
  };

  const html = renderToStaticMarkup(
    createElement(EntryView, {
      entry,
      projection: projectEntryPart(entry, 0),
      favorite: false,
      entryPending: false,
      activeSectionId: "definitions",
      audioError: null,
      resolveIllustration: (key: string) => key,
      onPartChange() {},
      onJump() {},
      onToggleFavorite() {},
      onOpenNote() {},
      onSelectEntry() {},
      onPlayAudio() {},
    }),
  );

  assert.match(html, /entry-headword-usage">\(not usually before a noun\)<\/span>/);
  assert.match(html, /comparative <\/em><strong>slower<\/strong>/);
  assert.match(html, /entry-inflection-constraint">no superlative<\/em>/);
  assert.doesNotMatch(html, /<strong>no superlative<\/strong>/);
  assert.match(html, /sense-pronunciation[^]*BrE[^]*\/sl\u0259\u028a\/[^]*播放该词义BrE发音/);
  assert.match(html, /sense-inflected-forms[^]*plural <\/em><strong>examples<\/strong>/);
  assert.match(html, /derived-form-inflected-forms[^]*plural <\/em><strong>slownesses<\/strong>/);
  assert.match(html, /derived-form-usage">\(in nouns\)<\/p>/);
});
