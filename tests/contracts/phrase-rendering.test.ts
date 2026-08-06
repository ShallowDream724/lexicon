import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CanonicalEntry } from "../../packages/dictionary-schema/src/index";
import { EntryView } from "../../src/features/dictionary/components/EntryView";
import { projectEntryPart } from "../../src/features/dictionary/entry-sections";

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
