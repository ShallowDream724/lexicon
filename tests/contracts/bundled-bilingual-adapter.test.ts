import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_BILINGUAL_CROSS_REFERENCE_LABELS,
  BundledBilingualAdapter,
  classifyBundledBilingualCrossReference,
  DictionaryAdapterRegistry,
} from "../../packages/adapters/src/index";
import { canonicalEntrySchema } from "../../packages/dictionary-schema/src/index";

const adapter = new BundledBilingualAdapter({ dictionaryId: "test-dictionary" });

test("adapts an ordered normal entry with examples and media keys", () => {
  const entry = adapter.parse({
    entryId: "entry-completion",
    headword: "com·ple·tion",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [
          { tag: "h", value: "com·ple·tion", path: "heading", id: "heading-id" },
          {
            tag: "h-cefr",
            value: "[Ox5000 key_L][CEFR_B2_M]",
            path: "heading",
          },
        ],
        prongs: [
          { phon: "kəmˈpliːʃn", geo: "BrE", audio: "completion_gb" },
          { phon: "kəmˈpliːʃn", geo: "NAmE", audio: "completion_us" },
        ],
        pos: [{ tag: "pos", value: "noun", font_Italic: "1" }],
        ill: [{ tag: "ill", value: "project-cycle", path: "ill-g" }],
      },
      sngs_data: [
        {
          top_data: "",
          sngs_data: {
            sn_g: [
              {
                id: "sense-1",
                sng_text: [
                  { tag: "sn-g", value: "1.[Ox5000 key_S][CEFR_B2_S]" },
                  { tag: "gram-g", value: " [" },
                  { tag: "gram", value: "[uncountable]" },
                  { tag: "gram-g", value: "]" },
                  { tag: "cf", value: " completion" },
                ],
                def_eng: [{ tag: "eng", value: "the act of finishing" }],
                def_simp: [{ tag: "simp", value: "完成" }],
                un: [
                  { tag: "un", value: "[HELP]" },
                  { tag: "eng", value: " Use the noun after " },
                  { tag: "eb", value: "reach" },
                  { tag: "eng", value: "." },
                ],
                x_gs: [
                  {
                    id: "example-1",
                    x_eng: [{ tag: "eng", value: "The task reached completion." }],
                    x_simp: [{ tag: "simp", value: "任务完成了。" }],
                    xaudio: [
                      { tag: "xaudio", value: { geo: "br", url: "completion_example_gb" } },
                      { tag: "xaudio", value: { geo: "na", url: "completion_example_us" } },
                    ],
                  },
                ],
                ill: [{ tag: "ill", value: "completion-chart" }],
              },
            ],
          },
          unbox: [],
          ill: [],
        },
      ],
      unbox: [],
      unrecognized_root_field: { retained: true },
    },
  });

  assert.equal(entry.schemaVersion, "1.0");
  assert.equal(entry.dictionaryId, "test-dictionary");
  assert.equal(entry.headword, "completion");
  assert.equal(entry.displayHeadword, "com·ple·tion");
  assert.equal(entry.searchKey, "completion");
  assert.deepEqual(entry.pronunciations.map((item) => item.audioKey), [
    "completion_gb",
    "completion_us",
  ]);
  assert.equal(entry.partsOfSpeech[0]?.tokens[0]?.raw.font_Italic, "1");
  assert.deepEqual(entry.labels.map((label) => [label.text, label.kind]), [
    ["5000", "frequency"],
    ["B2", "level"],
  ]);
  assert.deepEqual(entry.senses[0]?.labels.map((label) => [label.text, label.kind]), [
    ["5000", "frequency"],
    ["B2", "level"],
    ["uncountable", "gram"],
  ]);
  assert.equal(entry.senses[0]?.patterns?.[0]?.text, " completion");
  assert.equal(entry.senses[0]?.usage.length, 1);
  assert.equal(entry.senses[0]?.usage[0]?.text, "[HELP] Use the noun after reach.");
  assert.equal(entry.senses[0]?.examples[0]?.audio[0]?.key, "completion_example_gb");
  assert.equal(entry.senses[0]?.examples[0]?.audio[1]?.region, "na");
  assert.equal(entry.illustrations[0]?.key, "project-cycle");
  assert.equal(entry.illustrations[0]?.text, undefined);
  assert.equal(entry.senses[0]?.illustrations[0]?.key, "completion-chart");
  assert.equal(entry.senses[0]?.illustrations[0]?.text, undefined);
  assert.deepEqual(entry.raw.unrecognized_root_field, { retained: true });
});

test("keeps illustration resource keys separate from explicit captions", () => {
  const entry = adapter.parse({
    entryId: "entry-apple",
    headword: "apple",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "apple" }],
        ill: [
          { tag: "ill", value: "fruit_misc" },
          { tag: "ill", key: "apple-cutaway", caption: "Apple cross-section" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(
    entry.illustrations.map((illustration) => ({
      key: illustration.key,
      text: illustration.text,
    })),
    [
      { key: "fruit_misc", text: undefined },
      { key: "apple-cutaway", text: "Apple cross-section" },
    ],
  );
});

test("keeps empty root POS separate from recursive subentries", () => {
  const entry = adapter.parse({
    entryId: "entry-take",
    headword: "take",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "take" }],
        pos: [],
        "v-gs": [{ tag: "if", value: "took", source_order: 0 }],
      },
      sngs_data: [
        {
          id: "entry-take-noun",
          top_data: {
            top_text: [{ tag: "pos-g", value: "noun" }],
            pos: [],
            prongs: [{ phon: "teɪk", geo: "BrE", audio: "take_noun_gb" }],
          },
          sngs_data: {
            sn_g: [
              {
                id: "take-sense-1",
                sng_text: [{ tag: "sn", value: "1" }],
                def_eng: [{ tag: "eng", value: "one recording attempt" }],
                def_simp: [{ tag: "simp", value: "一次录制" }],
                x_gs: [],
                un: [],
                xrgs: [],
                unbox: [],
                ill: [],
              },
            ],
            dr_gs: [{ tag: "dr", value: "retake" }],
          },
          unbox: [],
          ill: [],
        },
      ],
      unbox: [],
    },
  });

  assert.equal(entry.partsOfSpeech.length, 0);
  assert.equal(entry.senses.length, 0);
  assert.equal(entry.subentries.length, 1);
  assert.equal(entry.subentries[0]?.id, "entry-take-noun");
  assert.equal(entry.subentries[0]?.headword, "take");
  assert.equal(entry.subentries[0]?.senses[0]?.id, "take-sense-1");
  assert.deepEqual(entry.inflectedForms.map((form) => form.text), ["took"]);
  assert.deepEqual(entry.subentries[0]?.derivedForms.map((form) => form.text), [
    "retake",
  ]);
  assert.equal(entry.subentries[0]?.pronunciations[0]?.audioKey, "take_noun_gb");
});

test("structures flattened inflection pronunciations without leaking transport tokens into labels", () => {
  const entry = adapter.parse({
    entryId: "entry-take-flat",
    headword: "take",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "take" }] },
      sngs_data: [{
        id: "entry-take-verb",
        top_data: {
          pos: [{ tag: "pos", value: "verb" }],
          top_text: [
            { tag: "pos-g", value: "", path: "top-g/pos-g" },
            { tag: "if-gs", value: " (", path: "top-g/if-gs" },
            { tag: "if", value: "took", path: "top-g/if-gs/if-g/if" },
            { tag: "pron-g", value: "BrE", path: "top-g/if-gs/if-g/pron-gs/pron-g" },
            { tag: "phon", value: "tʊk", path: "top-g/if-gs/if-g/pron-gs/pron-g/phon" },
            { tag: "audio", value: "took#_gb_1", path: "top-g/if-gs/if-g/pron-gs/pron-g/audio" },
            { tag: "pron-g", value: "NAmE", path: "top-g/if-gs/if-g/pron-gs/pron-g" },
            { tag: "phon", value: "tʊk", path: "top-g/if-gs/if-g/pron-gs/pron-g/phon" },
            { tag: "audio", value: "took#_us_1", path: "top-g/if-gs/if-g/pron-gs/pron-g/audio" },
            { tag: "if-g", value: ", ", path: "top-g/if-gs/if-g" },
            { tag: "if", value: "taken", path: "top-g/if-gs/if-g/if" },
            { tag: "pron-g", value: "BrE", path: "top-g/if-gs/if-g/pron-gs/pron-g" },
            { tag: "phon", value: "ˈteɪkən", path: "top-g/if-gs/if-g/pron-gs/pron-g/phon" },
            { tag: "audio", value: "taken#_gb_1", path: "top-g/if-gs/if-g/pron-gs/pron-g/audio" },
            { tag: "if-gs", value: ") ", path: "top-g/if-gs" },
          ],
        },
        sngs_data: [],
      }],
    },
  });

  const verb = entry.subentries[0]!;
  assert.deepEqual(verb.labels, []);
  assert.deepEqual(verb.inflectedForms.map((form) => form.text), ["took", "taken"]);
  assert.deepEqual(verb.inflectedForms[0]?.pronunciations?.map((pronunciation) => ({
    region: pronunciation.region,
    transcription: pronunciation.transcription,
    audioKey: pronunciation.audioKey,
  })), [
    { region: "BrE", transcription: "tʊk", audioKey: "took#_gb_1" },
    { region: "NAmE", transcription: "tʊk", audioKey: "took#_us_1" },
  ]);
  assert.equal(verb.inflectedForms[1]?.pronunciations?.[0]?.transcription, "ˈteɪkən");
});

test("keeps inflection labels while removing source-owned group separators", () => {
  const entry = adapter.parse({
    entryId: "entry-round",
    headword: "round",
    sourceVersion: "2026.08",
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

  assert.deepEqual(entry.inflectedForms.map((form) => ({
    text: form.text,
    introducer: form.introducer?.text,
  })), [
    { text: "rounder", introducer: "comparative" },
    { text: "roundest", introducer: "superlative" },
  ]);
  assert.deepEqual(entry.inflectedForms[1]?.introducer?.raw, [
    { tag: "if-g", value: ", superlative ", path: "top-g/if-gs/if-g" },
  ]);
});

test("preserves same-spelling inflections inside one source group while deduplicating repeated groups", () => {
  const inflectionGroup = [
    { tag: "if-gs", value: " (", path: "top-g/if-gs" },
    { tag: "if", value: "brought", path: "top-g/if-gs/if-g/if" },
    { tag: "if-g", value: ", ", path: "top-g/if-gs/if-g" },
    { tag: "if", value: "brought", path: "top-g/if-gs/if-g/if" },
    { tag: "pron-g", value: "BrE", path: "top-g/if-gs/if-g/pron-gs/pron-g" },
    { tag: "phon", value: "brɔːt", path: "top-g/if-gs/if-g/pron-gs/pron-g/phon" },
    { tag: "audio", value: "brought#_gb_1", path: "top-g/if-gs/if-g/pron-gs/pron-g/audio" },
    { tag: "pron-g", value: "NAmE", path: "top-g/if-gs/if-g/pron-gs/pron-g" },
    { tag: "phon", value: "brɔːt", path: "top-g/if-gs/if-g/pron-gs/pron-g/phon" },
    { tag: "audio", value: "brought#_us_1", path: "top-g/if-gs/if-g/pron-gs/pron-g/audio" },
    { tag: "if-gs", value: ")", path: "top-g/if-gs" },
  ];
  const entry = adapter.parse({
    entryId: "entry-bring",
    headword: "bring",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "bring" }],
        pos: [{ tag: "pos", value: "verb" }],
        top_text: inflectionGroup,
        "v-gs": inflectionGroup,
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.inflectedForms.map((form) => form.text), ["brought", "brought"]);
  assert.deepEqual(entry.variants, []);
  assert.deepEqual(entry.inflectedForms.map((form) => form.pronunciations?.map((pronunciation) => ({
    region: pronunciation.region,
    transcription: pronunciation.transcription,
    audioKey: pronunciation.audioKey,
  }))), [
    [],
    [
      { region: "BrE", transcription: "brɔːt", audioKey: "brought#_gb_1" },
      { region: "NAmE", transcription: "brɔːt", audioKey: "brought#_us_1" },
    ],
  ]);
});

test("maps part-scoped OPAL and CEFR metadata without exposing source codes", () => {
  const entry = adapter.parse({
    entryId: "entry-report",
    headword: "report",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [
          { tag: "h", value: "report" },
          { tag: "h-cefr", value: "[Ox3000 key_L][CEFR_A1_L]" },
          { tag: "h-last", value: "[CET4][CET6][NETM]" },
        ],
      },
      sngs_data: [{
        id: "entry-report-verb",
        top_data: {
          pos: [{ tag: "pos", value: "verb" }],
          top_text: [
            { tag: "pos-g", value: "", path: "h-g/subentry-gs/subentry-g/top-g/pos-g" },
            { tag: "topic", value: "[OPAL_W]", path: "h-g/subentry-gs/subentry-g/top-g/topic-g/topic" },
          ],
        },
        sngs_data: {
          pos: [{ tag: "pos", value: "verb" }],
          subentry_cefr: [{ tag: "subentry-cefr", value: "[Ox3000 key_S][CEFR_B1_S]" }],
          sn_g: [],
        },
      }],
    },
  });

  assert.deepEqual(entry.subentries[0]?.labels.map((label) => [label.text, label.kind]), [
    ["3000", "frequency"],
    ["B1", "level"],
    ["W", "academic-register"],
  ]);
  assert.equal(
    entry.subentries[0]?.labels.some((label) => label.text.includes("OPAL_")),
    false,
  );
});

test("structures alternative forms and their audio without treating transport tokens as inflections", () => {
  const entry = adapter.parse({
    entryId: "entry-killer-app",
    headword: "killer app",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "killer app" }],
        top_text: [
          { tag: "label-g", value: " (" },
          { tag: "reg", value: "informal", path: "h-g/top-g/label-g/reg" },
          { tag: "label-g", value: ") " },
        ],
        "v-gs": [
          { tag: "label-g", value: " (", path: "h-g/top-g/label-g" },
          { tag: "geo", value: "especially NAmE", path: "h-g/top-g/label-g/geo" },
          { tag: "label-g", value: ") ", path: "h-g/top-g/label-g/geo" },
          { tag: "v-gs", value: " (", path: "h-g/top-g/v-gs" },
          { tag: "v", value: "also ", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v", value: " ˌkiller appliˈcation", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "pron-g", value: "BrE", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g" },
          { tag: "form", value: "", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/form" },
          { tag: "phon", value: "ˌkɪlər ˌæplɪˈkeɪʃn", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/phon" },
          { tag: "audio", value: "killer_application#1_gb_1", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/audio" },
          { tag: "pron-g", value: "NAmE", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g" },
          { tag: "phon", value: "ˌkɪlər ˌæplɪˈkeɪʃn", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/phon" },
          { tag: "audio", value: "killer_application#1_us_1", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/audio" },
          { tag: "pron-gs", value: "/", path: "h-g/top-g/v-gs/v-g/pron-gs" },
          { tag: "v-gs", value: ") ", path: "h-g/top-g/v-gs" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.labels.map((label) => [label.text, label.kind]), [
    ["informal", "reg"],
    ["especially NAmE", "geo"],
  ]);
  assert.deepEqual(entry.inflectedForms, []);
  assert.equal(entry.variants?.length, 1);
  assert.equal(entry.variants?.[0]?.text, "ˌkiller appliˈcation");
  assert.equal(entry.variants?.[0]?.introducer?.text.trim(), "also");
  assert.deepEqual(entry.variants?.[0]?.labels, []);
  assert.deepEqual(entry.variants?.[0]?.pronunciations?.map((pronunciation) => ({
    region: pronunciation.region,
    transcription: pronunciation.transcription,
    audioKey: pronunciation.audioKey,
  })), [
    {
      region: "BrE",
      transcription: "ˌkɪlər ˌæplɪˈkeɪʃn",
      audioKey: "killer_application#1_gb_1",
    },
    {
      region: "NAmE",
      transcription: "ˌkɪlər ˌæplɪˈkeɪʃn",
      audioKey: "killer_application#1_us_1",
    },
  ]);
});

test("preserves unwrapped entry variants with every attached regional pronunciation", () => {
  const entry = adapter.parse({
    entryId: "entry-vanuatuan",
    headword: "Vanuatuan",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "Vanuatuan" }],
        pos: [
          { tag: "pos", value: "noun" },
          { tag: "pos", value: ", adj." },
        ],
        "v-gs": [
          { tag: "v", value: "ni-Vanuatu" },
          { tag: "pron-g", value: "BrE" },
          { tag: "form", value: "" },
          { tag: "phon", value: "ni ˌvænuːˈɑːtuː" },
          { tag: "audio", value: "ni_vanuatu#1_gb_1" },
          { tag: "pron-g", value: "NAmE" },
          { tag: "form", value: "" },
          { tag: "phon", value: "ni ˌvænuˈɑːtuː" },
          { tag: "audio", value: "ni_vanuatu#1_us_1" },
        ],
      },
      sngs_data: {
        sense_groups: [
          { pos: [{ tag: "pos", value: "noun" }] },
          { pos: [{ tag: "pos", value: "adj." }] },
        ],
      },
    },
  });

  assert.deepEqual(entry.partsOfSpeech.map((part) => part.text), ["noun", "adj."]);
  assert.deepEqual(entry.variants?.map((form) => ({
    text: form.text,
    pronunciations: form.pronunciations?.map((pronunciation) => ({
      region: pronunciation.region,
      transcription: pronunciation.transcription,
      audioKey: pronunciation.audioKey,
    })),
  })), [{
    text: "ni-Vanuatu",
    pronunciations: [
      {
        region: "BrE",
        transcription: "ni ˌvænuːˈɑːtuː",
        audioKey: "ni_vanuatu#1_gb_1",
      },
      {
        region: "NAmE",
        transcription: "ni ˌvænuˈɑːtuː",
        audioKey: "ni_vanuatu#1_us_1",
      },
    ],
  }]);
});

test("preserves unwrapped sense variants and pronunciation embedded in a definition", () => {
  const entry = adapter.parse({
    entryId: "entry-break-point",
    headword: "break point",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "break point" }],
        pos: [{ tag: "pos", value: "noun" }],
      },
      sngs_data: [{
        sngs_data: {
          sn_g: [{
            id: "sense-break-point",
            sng_text: [
              { tag: "v-gs", value: " ", path: "h-g/sn-gs/sn-g/v-gs" },
              { tag: "v", value: "ˈbreak point", path: "h-g/sn-gs/sn-g/v-gs/v-g/v" },
              { tag: "pron-g", value: "BrE", path: "h-g/sn-gs/sn-g/v-gs/v-g/pron-gs/pron-g" },
              { tag: "phon", value: "ˈbreɪk pɔɪnt", path: "h-g/sn-gs/sn-g/v-gs/v-g/pron-gs/pron-g/phon" },
              { tag: "audio", value: "break_point#1_gb_1", path: "h-g/sn-gs/sn-g/v-gs/v-g/pron-gs/pron-g/audio" },
            ],
            def_eng: [
              { tag: "eng", value: "called the " },
              { tag: "ve", value: "foremast", bold: 1 },
              { tag: "eng", value: " " },
              { tag: "pron-g", value: "BrE" },
              { tag: "phon", value: "ˈfɔːmɑːst" },
              { tag: "audio", value: "foremast#_gb_3" },
              { tag: "eng", value: ")" },
            ],
            def_simp: [{ tag: "simp", value: "称为前桅" }],
            x_gs: [],
          }],
        },
      }],
    },
  });

  const sense = entry.senses[0];
  assert.deepEqual(sense?.variants?.map((form) => ({
    text: form.text,
    audio: form.pronunciations?.map((pronunciation) => pronunciation.audioKey),
  })), [{
    text: "ˈbreak point",
    audio: ["break_point#1_gb_1"],
  }]);
  assert.equal(sense?.definition?.text.includes("foremast#_gb_3"), false);
  assert.deepEqual(sense?.definitionSegments?.map((segment) => segment.kind), [
    "text",
    "pronunciations",
    "text",
  ]);
  assert.deepEqual(
    sense?.definitionSegments
      ?.filter((segment) => segment.kind === "pronunciations")
      .flatMap((segment) => segment.items.map((pronunciation) => pronunciation.audioKey)),
    ["foremast#_gb_3"],
  );
});

test("keeps unwrapped and parenthesized variants from the same explicit source field", () => {
  const entry = adapter.parse({
    entryId: "entry-oceanfront",
    headword: "oceanfront",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "oceanfront" }],
        "v-gs": [
          { tag: "v-gs", value: " ", path: "top-g/v-gs" },
          { tag: "v", value: "often", path: "top-g/v-gs/v-g/v" },
          { tag: "v", value: " the oceanfront", path: "top-g/v-gs/v-g/v" },
          { tag: "label-g", value: " (", path: "top-g/label-g" },
          { tag: "geo", value: "NAmE", path: "top-g/label-g/geo" },
          { tag: "label-g", value: ") ", path: "top-g/label-g/geo" },
          { tag: "v-gs", value: " (", path: "top-g/v-gs" },
          { tag: "geo", value: "BrE", path: "top-g/v-gs/v-g/label-g/geo" },
          { tag: "v", value: "seafront", path: "top-g/v-gs/v-g/v" },
          { tag: "v-gs", value: ") ", path: "top-g/v-gs/v-g/v" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.variants?.map((form) => ({
    text: form.text,
    introducer: form.introducer?.text.trim(),
    labels: form.labels?.map((label) => label.text),
  })), [
    { text: "the oceanfront", introducer: "often", labels: ["NAmE"] },
    { text: "seafront", introducer: undefined, labels: ["BrE"] },
  ]);
});

test("splits source-separated variants and keeps embedded top-text variants out of constructions", () => {
  const entry = adapter.parse({
    entryId: "entry-air-conditioning",
    headword: "air conditioning",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "air conditioning" }],
        top_text: [
          { tag: "v-gs", value: " ", path: "h-g/top-g/v-gs" },
          { tag: "v", value: "air conditioning", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v-gs", value: " (", path: "h-g/top-g/v-gs" },
          { tag: "v", value: "abbr. ", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v", value: " AC", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v-g", value: ", ", path: "h-g/top-g/v-gs/v-g" },
          { tag: "v", value: "a/c", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v-gs", value: ") ", path: "h-g/top-g/v-gs/v-g/v" },
        ],
        "v-gs": [
          { tag: "v-gs", value: " (", path: "h-g/top-g/v-gs" },
          { tag: "v", value: "also ", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v", value: " air con", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v-gs", value: ") ", path: "h-g/top-g/v-gs/v-g/v" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.headwordPatterns?.map((pattern) => pattern.text.trim()), [
    "air conditioning",
  ]);
  assert.deepEqual(entry.variants?.map((form) => ({
    text: form.text,
    introducer: form.introducer?.text.trim(),
  })), [
    { text: "AC", introducer: "abbr." },
    { text: "a/c", introducer: undefined },
    { text: "air con", introducer: "also" },
  ]);
});

test("keeps comma-separated variant labels and pronunciations with the form they qualify", () => {
  const entry = adapter.parse({
    entryId: "entry-air-bed",
    headword: "air bed",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "air bed" }],
        "v-gs": [
          { tag: "v-gs", value: " (", path: "h-g/top-g/v-gs" },
          { tag: "v", value: "also ", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "v", value: " airbed", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "geo", value: "BrE", path: "h-g/top-g/v-gs/v-g/label-g/geo" },
          { tag: "v-g", value: ", ", path: "h-g/top-g/v-gs/v-g" },
          { tag: "v", value: "air mattress", path: "h-g/top-g/v-gs/v-g/v" },
          { tag: "geo", value: "NAmE", path: "h-g/top-g/v-gs/v-g/label-g/geo" },
          { tag: "geo", value: ", BrE", path: "h-g/top-g/v-gs/v-g/label-g/geo" },
          { tag: "pron-g", value: "NAmE", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g" },
          { tag: "phon", value: "ˈeə mætrəs", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/phon" },
          { tag: "v-gs", value: ") ", path: "h-g/top-g/v-gs/v-g/pron-gs/pron-g/phon" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.variants?.map((form) => ({
    text: form.text,
    introducer: form.introducer?.text.trim(),
    labels: form.labels?.map((label) => ({
      text: label.text,
      separatorBefore: label.separatorBefore,
    })),
    presentation: form.presentation?.map((item) =>
      item.kind === "target" || item.kind === "pronunciation"
        ? item.kind
        : `${item.kind}:${item.value.text.trim()}`,
    ),
    pronunciations: form.pronunciations?.map((pronunciation) => ({
      region: pronunciation.region,
      transcription: pronunciation.transcription,
    })),
  })), [
    {
      text: "airbed",
      introducer: "also",
      labels: [{ text: "BrE", separatorBefore: undefined }],
      presentation: ["introducer:also", "target", "label:BrE"],
      pronunciations: [],
    },
    {
      text: "air mattress",
      introducer: undefined,
      labels: [
        { text: "NAmE", separatorBefore: undefined },
        { text: "BrE", separatorBefore: "," },
      ],
      presentation: ["target", "label:NAmE", "label:BrE", "pronunciation"],
      pronunciations: [{ region: "NAmE", transcription: "ˈeə mætrəs" }],
    },
  ]);
});

test("projects headword patterns and inline use blocks without parenthetical label leakage", () => {
  const entry = adapter.parse({
    entryId: "entry-following",
    headword: "following",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "following" }] },
      sngs_data: [{
        id: "entry-following-adjective",
        top_data: {
          pos: [{ tag: "pos", value: "adjective" }],
          top_text: [
            { tag: "v-gs", value: " " },
            {
              tag: "v",
              value: "the following…",
              bold: 1,
              path: "h-g/subentry-gs/subentry-g/top-g/v-gs/v-g/v",
            },
          ],
        },
        sngs_data: {
          sn_g: [{
            id: "following-sense",
            sng_text: [
              { tag: "sn-g", value: "1.[CEFR_B1_S]" },
              { tag: "use", value: " (", path: "h-g/sn-gs/sn-g/use" },
              {
                tag: "eng",
                value: "used with either a singular or a plural verb",
                path: "h-g/sn-gs/sn-g/use/eng",
              },
              {
                tag: "simp",
                value: " 动词可用单数或复数",
                path: "h-g/sn-gs/sn-g/use/simp",
              },
              { tag: "use_end", value: ") ", path: "h-g/sn-gs/sn-g/use/simp" },
            ],
            def_eng: [{ tag: "eng", value: "the thing mentioned next" }],
            def_simp: [{ tag: "simp", value: "下述事物" }],
          }],
        },
      }],
    },
  });

  const adjective = entry.subentries[0]!;
  const sense = adjective.senses[0]!;
  assert.equal(adjective.headwordPatterns?.[0]?.text, "the following…");
  assert.deepEqual(sense.labels.map((label) => [label.text, label.kind]), [
    ["B1", "level"],
  ]);
  assert.equal(
    sense.inlineUsage?.[0]?.text,
    " (used with either a singular or a plural verb 动词可用单数或复数) ",
  );
  assert.deepEqual(sense.usage, []);
});

test("separates sense-scoped variants from grammatical constructions", () => {
  const entry = adapter.parse({
    entryId: "entry-abide",
    headword: "abide",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "abide" }] },
      sngs_data: {
        sn_g: [{
          id: "abide-sense",
          sng_text: [
            { tag: "sn-g", value: "2." },
            { tag: "v-gs", value: " (", path: "sn-g/v-gs" },
            { tag: "v", value: "also ", path: "sn-g/v-gs/v-g/v" },
            { tag: "reg", value: "old use", path: "sn-g/v-gs/v-g/label-g/reg" },
            { tag: "v", value: "bide", path: "sn-g/v-gs/v-g/v" },
            { tag: "v-gs", value: ") ", path: "sn-g/v-gs" },
            { tag: "cf", value: "+ adv./prep.", path: "sn-g/cf" },
          ],
          def_eng: [{ tag: "eng", value: "to stay or live somewhere" }],
          def_simp: [{ tag: "simp", value: "停留；居住" }],
        }],
      },
    },
  });

  const sense = entry.senses[0];
  assert.deepEqual(sense?.patterns?.map((pattern) => pattern.text.trim()), [
    "+ adv./prep.",
  ]);
  assert.deepEqual(sense?.variants?.map((variant) => ({
    text: variant.text,
    presentation: variant.presentation?.map((item) =>
      item.kind === "target" || item.kind === "pronunciation"
        ? { kind: item.kind }
        : { kind: item.kind, text: item.value.text.trim() },
    ),
  })), [{
    text: "bide",
    presentation: [
      { kind: "introducer", text: "also" },
      { kind: "label", text: "old use" },
      { kind: "target" },
    ],
  }]);
});

test("keeps direct sense pronunciations separate from variant pronunciations", () => {
  const entry = adapter.parse({
    entryId: "entry-old-money",
    headword: "old money",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "old money" }] },
      sngs_data: {
        sn_g: [{
          id: "old-money-sense",
          sng_text: [
            { tag: "sn-g", value: "", path: "h-g/sn-gs/sn-g" },
            { tag: "pron-g", value: "BrE", path: "h-g/sn-gs/sn-g/pron-gs/pron-g" },
            { tag: "phon", value: "\u02cc\u0259\u028ald \u02c8m\u028cni", path: "h-g/sn-gs/sn-g/pron-gs/pron-g/phon" },
            { tag: "audio", value: "old_money#1_gb_1", path: "h-g/sn-gs/sn-g/pron-gs/pron-g/audio" },
            { tag: "v-gs", value: " (", path: "h-g/sn-gs/sn-g/v-gs" },
            { tag: "v", value: "also", path: "h-g/sn-gs/sn-g/v-gs/v-g/v" },
            { tag: "v", value: "old wealth", path: "h-g/sn-gs/sn-g/v-gs/v-g/v" },
            { tag: "pron-g", value: "NAmE", path: "h-g/sn-gs/sn-g/v-gs/v-g/pron-gs/pron-g" },
            { tag: "audio", value: "old_wealth#1_us_1", path: "h-g/sn-gs/sn-g/v-gs/v-g/pron-gs/pron-g/audio" },
            { tag: "v-gs", value: ")", path: "h-g/sn-gs/sn-g/v-gs" },
          ],
          def_eng: [{ tag: "eng", value: "wealth inherited through a family" }],
        }],
      },
    },
  });

  const sense = entry.senses[0];
  assert.deepEqual(sense?.pronunciations?.map((pronunciation) => ({
    region: pronunciation.region,
    transcription: pronunciation.transcription,
    audioKey: pronunciation.audioKey,
  })), [{
    region: "BrE",
    transcription: "\u02cc\u0259\u028ald \u02c8m\u028cni",
    audioKey: "old_money#1_gb_1",
  }]);
  assert.deepEqual(sense?.variants?.[0]?.pronunciations?.map((pronunciation) =>
    pronunciation.audioKey
  ), ["old_wealth#1_us_1"]);
});

test("retains source separators between alternative construction patterns", () => {
  const entry = adapter.parse({
    entryId: "entry-absolutely",
    headword: "absolutely",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "absolutely" }] },
      sngs_data: {
        sn_g: [{
          id: "absolutely-sense",
          sng_text: [
            { tag: "sn-g", value: "1.[CEFR_B1_S]" },
            { tag: "v-gs", value: " ", path: "h-g/sn-gs/sn-g/v-gs" },
            { tag: "v", value: "absolutely no…", path: "h-g/sn-gs/sn-g/v-gs/v-g/v" },
            { tag: "v-g", value: ", ", path: "h-g/sn-gs/sn-g/v-gs/v-g" },
            { tag: "v", value: "absolutely nothing", path: "h-g/sn-gs/sn-g/v-gs/v-g/v" },
          ],
          def_eng: [{ tag: "eng", value: "used for emphasis" }],
          def_simp: [{ tag: "simp", value: "用于强调" }],
        }],
      },
    },
  });

  assert.deepEqual(entry.senses[0]?.patterns?.map((pattern) => pattern.text.trim()), [
    "absolutely no\u2026,",
    "absolutely nothing",
  ]);
  assert.equal(entry.senses[0]?.patterns?.[0]?.tokens.at(-1)?.tag, "v-g");
});

test("preserves bilingual display qualifiers that precede sense definitions", () => {
  const entry = adapter.parse({
    entryId: "entry-heel",
    headword: "heel",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "heel" }],
        pos: [{ tag: "pos", value: "noun" }],
      },
      sngs_data: {
        sn_g: [
          {
            id: "come-to-heel-person",
            sng_text: [
              { tag: "sn-g", value: "1." },
              { tag: "dtxt", value: " (", path: "h-g/sn-gs/sn-g/dis-g/dtxt" },
              { tag: "eng", value: "of a person", path: "h-g/sn-gs/sn-g/dis-g/dtxt/eng" },
              { tag: "simp", value: " 人", path: "h-g/sn-gs/sn-g/dis-g/dtxt/simp" },
              { tag: "dtxt", value: ") ", path: "h-g/sn-gs/sn-g/dis-g/dtxt/simp" },
            ],
            def_eng: [{ tag: "eng", value: "to agree to obey sb" }],
            def_simp: [{ tag: "simp", value: "愿意听从某人" }],
          },
          {
            id: "come-to-heel-dog",
            sng_text: [
              { tag: "sn-g", value: "2." },
              { tag: "dtxt", value: " (", path: "h-g/sn-gs/sn-g/dis-g/dtxt" },
              { tag: "eng", value: "of a dog", path: "h-g/sn-gs/sn-g/dis-g/dtxt/eng" },
              { tag: "simp", value: " 狗", path: "h-g/sn-gs/sn-g/dis-g/dtxt/simp" },
              { tag: "dtxt", value: ") ", path: "h-g/sn-gs/sn-g/dis-g/dtxt/simp" },
            ],
            def_eng: [{ tag: "eng", value: "to come close to the person who called it" }],
            def_simp: [{ tag: "simp", value: "走近唤狗人" }],
          },
        ],
      },
    },
  });

  assert.deepEqual(
    entry.senses.map((sense) => sense.inlineUsage?.map((usage) => usage.text)),
    [[" (of a person 人) "], [" (of a dog 狗) "]],
  );
});

test("combines split inflection tokens once and never exposes their source fragments as labels", () => {
  const entry = adapter.parse({
    entryId: "entry-baby",
    headword: "baby",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "baby" }],
        pos: [{ tag: "pos", value: "noun" }],
        top_text: [
          { tag: "if-gs", value: " (", path: "h-g/top-g/if-gs" },
          { tag: "if-g", value: "pl. ", path: "h-g/top-g/if-gs/if-g" },
          { tag: "if", value: "bab", path: "h-g/top-g/if-gs/if-g/if" },
          { tag: "ptl", value: "ies", path: "h-g/top-g/if-gs/if-g/ptl" },
          { tag: "if-gs", value: ")", path: "h-g/top-g/if-gs" },
        ],
      },
      sngs_data: [],
    },
  });

  assert.deepEqual(entry.labels, []);
  assert.deepEqual(entry.inflectedForms.map((form) => ({
    introducer: form.introducer?.text.trim(),
    text: form.text,
  })), [{ introducer: "pl.", text: "babies" }]);
  assert.equal(
    JSON.stringify(entry).includes('"text":"ies","kind":"ptl"'),
    false,
  );
});

test("keeps structural separators out of POS text and preserves scoped usage and inflection constraints", () => {
  const entry = adapter.parse({
    entryId: "entry-structured-inflections",
    headword: "slow",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "slow" }],
        pos: [
          { tag: "pos", value: "adj." },
          { tag: "pos", value: ", adv." },
        ],
        top_text: [
          { tag: "use", value: " (", path: "h-g/top-g/use" },
          { tag: "eng", value: "not usually used before a noun", path: "h-g/top-g/use/eng" },
          { tag: "use_end", value: ") ", path: "h-g/top-g/use/eng" },
          { tag: "if-gs", value: " (", path: "h-g/top-g/if-gs" },
          { tag: "if-g", value: "comparative ", path: "h-g/top-g/if-gs/if-g" },
          { tag: "if", value: "slo", path: "h-g/top-g/if-gs/if-g/if" },
          { tag: "ptl", value: "w", path: "h-g/top-g/if-gs/if-g/if/ptl" },
          { tag: "if", value: "er", path: "h-g/top-g/if-gs/if-g/if/ptl" },
          { tag: "if-g", value: ", no superlative", path: "h-g/top-g/if-gs/if-g" },
          { tag: "if-gs", value: ") ", path: "h-g/top-g/if-gs/if-g/nil" },
        ],
      },
      sngs_data: [{
        sngs_data: {
          sn_g: [{
            id: "sense-slow",
            sng_text: [
              { tag: "sn-g", value: "1." },
              { tag: "if-gs", value: " (", path: "h-g/sn-gs/sn-g/if-gs" },
              { tag: "if-g", value: "plural ", path: "h-g/sn-gs/sn-g/if-gs/if-g" },
              { tag: "if", value: "exam", path: "h-g/sn-gs/sn-g/if-gs/if-g/if" },
              { tag: "ptl", value: "ples", path: "h-g/sn-gs/sn-g/if-gs/if-g/if/ptl" },
              { tag: "if-gs", value: ") ", path: "h-g/sn-gs/sn-g/if-gs/if-g/nil" },
            ],
            def_eng: [{ tag: "eng", value: "moving at a low speed" }],
            def_simp: [{ tag: "simp", value: "缓慢的" }],
          }],
        },
      }],
    },
  });

  assert.deepEqual(entry.partsOfSpeech.map((part) => part.text), ["adj.", "adv."]);
  assert.equal(entry.partsOfSpeech[1]?.tokens[0]?.text, ", adv.");
  assert.deepEqual(entry.headwordUsage?.map((usage) => usage.text.trim()), [
    "(not usually used before a noun)",
  ]);
  assert.deepEqual(entry.inflectedForms.map((form) => ({
    kind: form.kind,
    introducer: form.introducer?.text,
    text: form.text,
  })), [
    { kind: "inflection", introducer: "comparative", text: "slower" },
    { kind: "inflection-constraint", introducer: undefined, text: "no superlative" },
  ]);
  assert.deepEqual(entry.senses[0]?.inflectedForms?.map((form) => ({
    kind: form.kind,
    introducer: form.introducer?.text,
    text: form.text,
  })), [
    { kind: "inflection", introducer: "plural", text: "examples" },
  ]);
});

test("retains derivative-level usage and inflections at their original owners", () => {
  const entry = adapter.parse({
    entryId: "entry-derived-inflections",
    headword: "airdrop",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "airdrop" }] },
      dr_gs: [{
        id: "derivative-airdrop",
        top_g: {
          h: [{ tag: "dr", value: "air·drop" }],
          top_text: [
            { tag: "use", value: " (", path: "h-g/dr-gs/dr-g/top-g/use" },
            { tag: "eng", value: "also used as a noun", path: "h-g/dr-gs/dr-g/top-g/use/eng" },
            { tag: "use_end", value: ") ", path: "h-g/dr-gs/dr-g/top-g/use/eng" },
            { tag: "if-gs", value: " (", path: "h-g/dr-gs/dr-g/top-g/if-gs" },
            { tag: "if", value: "airdropping", path: "h-g/dr-gs/dr-g/top-g/if-gs/if-g/if" },
            { tag: "if-g", value: ", ", path: "h-g/dr-gs/dr-g/top-g/if-gs/if-g" },
            { tag: "if", value: "airdropped", path: "h-g/dr-gs/dr-g/top-g/if-gs/if-g/if" },
            { tag: "if-gs", value: ") ", path: "h-g/dr-gs/dr-g/top-g/if-gs/if-g/nil" },
          ],
        },
        sn_gs: {
          sn_g: [{
            id: "derivative-airdrop-sense",
            sng_text: [
              { tag: "sn-g", value: "1." },
              { tag: "if-gs", value: " (", path: "h-g/dr-gs/dr-g/sn-gs/sn-g/if-gs" },
              { tag: "if-g", value: "plural ", path: "h-g/dr-gs/dr-g/sn-gs/sn-g/if-gs/if-g" },
              { tag: "if", value: "airdrops", path: "h-g/dr-gs/dr-g/sn-gs/sn-g/if-gs/if-g/if" },
              { tag: "if-gs", value: ") ", path: "h-g/dr-gs/dr-g/sn-gs/sn-g/if-gs/if-g/nil" },
            ],
            def_eng: [{ tag: "eng", value: "a delivery made by air" }],
          }],
        },
      }],
      sngs_data: [],
    },
  });

  const derivative = entry.derivedForms[0];
  assert.deepEqual(derivative?.usage?.map((usage) => usage.text.trim()), [
    "(also used as a noun)",
  ]);
  assert.deepEqual(derivative?.inflectedForms?.map((form) => form.text), [
    "airdropping",
    "airdropped",
  ]);
  assert.deepEqual(derivative?.senses?.[0]?.inflectedForms?.map((form) => ({
    introducer: form.introducer?.text,
    text: form.text,
  })), [{ introducer: "plural", text: "airdrops" }]);
});

test("adapts structured derivatives with pronunciation, labels, senses, and examples", () => {
  const entry = adapter.parse({
    entryId: "entry-swift",
    headword: "swift",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "swift" }] },
      dr_gs: [
        {
          id: "derivative-swiftly",
          top_g: {
            h: [{ tag: "dr", value: "swift·ly", bold: 1 }],
            prongs: [
              { phon: "ˈswɪftli", geo: "BrE", audio: "swiftly_gb" },
              { phon: "ˈswɪftli", geo: "NAmE", audio: "swiftly_us" },
            ],
            top_text: [],
            pos: [],
          },
          sn_gs: {
            sn_g: [{
              id: "swiftly-sense",
              sng_text: [],
              def_eng: [],
              def_simp: [],
              x_gs: [{
                id: "swiftly-example",
                x_eng: [{ tag: "eng", value: "She moved swiftly to the rescue." }],
                x_simp: [{ tag: "simp", value: "她迅速前去救援。" }],
                xaudio: [],
              }],
            }],
          },
        },
        {
          id: "derivative-swiftness",
          top_g: {
            h: [{ tag: "dr", value: "swift·ness", bold: 1 }],
            prongs: [],
            top_text: [
              { tag: "gram-g", value: " [" },
              { tag: "gram", value: "[uncountable]" },
              { tag: "gram-g", value: "]" },
            ],
            pos: [],
          },
          sn_gs: { sn_g: [] },
        },
      ],
    },
  });

  assert.deepEqual(entry.derivedForms.map((form) => form.text), [
    "swift·ly",
    "swift·ness",
  ]);
  assert.deepEqual(entry.senses, []);
  assert.deepEqual(entry.derivedForms[0]?.pronunciations?.map((item) => item.audioKey), [
    "swiftly_gb",
    "swiftly_us",
  ]);
  assert.equal(
    entry.derivedForms[0]?.senses?.[0]?.examples[0]?.text.text,
    "She moved swiftly to the rescue.",
  );
  assert.equal(
    entry.derivedForms[0]?.senses?.[0]?.examples[0]?.translation?.text,
    "她迅速前去救援。",
  );
  assert.deepEqual(entry.derivedForms[1]?.labels?.map((label) => [label.text, label.kind]), [
    ["uncountable", "gram"],
  ]);
  assert.equal(entry.derivedForms.some((form) => form.text === "dr_gs"), false);
});

test("preserves derivative variants, qualifier order, and variant pronunciation", () => {
  const entry = adapter.parse({
    entryId: "entry-anarchy",
    headword: "anarchy",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "anarchy" }] },
      dr_gs: [{
        id: "derivative-anarchic",
        top_g: {
          h: [{ tag: "dr", value: "an·arch·ic" }],
          pos: [{ tag: "pos", value: "adj." }],
          prongs: [],
          top_text: [
            { tag: "v-gs", value: " (", path: "top-g/v-gs" },
            { tag: "v-g", value: "also ", path: "top-g/v-gs/v-g" },
            { tag: "reg", value: "less frequent", path: "top-g/v-gs/v-g/label-g/reg" },
            { tag: "v", value: "anarchical", path: "top-g/v-gs/v-g/v" },
            { tag: "pron-g", value: "BrE", path: "top-g/v-gs/v-g/pron-gs/pron-g" },
            { tag: "phon", value: "əˈnɑːkɪkl", path: "top-g/v-gs/v-g/pron-gs/pron-g/phon" },
            { tag: "audio", value: "anarchical#_gb_1", path: "top-g/v-gs/v-g/pron-gs/pron-g/audio" },
            { tag: "v-gs", value: ") ", path: "top-g/v-gs" },
          ],
        },
        sn_gs: { sn_g: [] },
      }],
    },
  });

  const derivative = entry.derivedForms[0];
  const variant = derivative?.variants?.[0];
  assert.deepEqual(derivative?.labels, []);
  assert.equal(variant?.text, "anarchical");
  assert.deepEqual(variant?.presentation?.map((item) =>
    item.kind === "target" || item.kind === "pronunciation"
      ? { kind: item.kind }
      : { kind: item.kind, text: item.value.text.trim() },
  ), [
    { kind: "introducer", text: "also" },
    { kind: "label", text: "less frequent" },
    { kind: "target" },
    { kind: "pronunciation" },
  ]);
  assert.deepEqual(variant?.labels?.map((label) => [label.kind, label.text]), [
    ["reg", "less frequent"],
  ]);
  assert.deepEqual(variant?.pronunciations?.map((pronunciation) => ({
    region: pronunciation.region,
    transcription: pronunciation.transcription,
    audioKey: pronunciation.audioKey,
  })), [{
    region: "BrE",
    transcription: "əˈnɑːkɪkl",
    audioKey: "anarchical#_gb_1",
  }]);
});

test("maps word-family forms and structured wordfinder references without duplicate title text", () => {
  const entry = adapter.parse({
    entryId: "entry-baby-wordfinder",
    headword: "baby",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "baby" }] },
      wfg: [
        { id: "family-baby", wfw: "baby", wfp: " noun", wfo: "" },
        { id: "family-babyish", wfw: "babyish", wfp: " adjective", wfo: "(informal)" },
      ],
      unbox: [{
        id: "wordfinder-baby",
        tile: {
          type: "WORDFINDER 联想词",
          eng: [
            {
              target_id: "entry-baby-wordfinder",
              word_id: "entry-baby-wordfinder",
              text: "baby",
              target_type: "word",
            },
            {
              target_id: "sense-birth",
              word_id: "entry-birth",
              text: "birth",
              target_type: "position",
            },
          ],
          simp: "",
        },
        body: [{
          ul: [
            { li: [{ tag: "ndv", value: " BABY" }] },
            { li: [{ tag: "ndv", value: " BIRTH" }] },
          ],
        }],
      }],
    },
  });

  assert.deepEqual(entry.derivedForms.map((form) => ({
    id: form.id,
    text: form.text,
    partOfSpeech: form.partOfSpeech,
    note: form.note?.text,
  })), [
    { id: "family-baby", text: "baby", partOfSpeech: "noun", note: undefined },
    {
      id: "family-babyish",
      text: "babyish",
      partOfSpeech: "adjective",
      note: "(informal)",
    },
  ]);
  const box = entry.grammarUsageBoxes[0]!;
  assert.equal(box.title, undefined);
  assert.deepEqual(box.references?.map((reference) => ({
    text: reference.text,
    entryId: reference.entryId,
    targetId: reference.targetId,
    targetType: reference.targetType,
  })), [
    {
      text: "baby",
      entryId: "entry-baby-wordfinder",
      targetId: "entry-baby-wordfinder",
      targetType: "word",
    },
    {
      text: "birth",
      entryId: "entry-birth",
      targetId: "sense-birth",
      targetType: "position",
    },
  ]);
});

test("preserves homophone headings, pronunciations, terms, and inline cross references", () => {
  const entry = adapter.parse({
    entryId: "entry-groan",
    headword: "groan",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "groan" }] },
      sngs_data: [],
      unbox: [{
        id: "box-homophones",
        tile: { type: "HOMOPHONES 同音词", eng: "", simp: "" },
        body: [
          {
            h1: [
              {
                ul: [
                  { li: [{ tag: "li_text", value: "[diomond]groan", bold: 1 }] },
                  { li: [{ tag: "li_text", value: "[diomond]grown", bold: 1 }] },
                ],
              },
              {
                "pron-gs": [
                  { "pron-g": { phon: "ɡrəʊn", geo: "BrE", audio: "grown#_gb_3", form: "" } },
                  { "pron-g": { phon: "ɡrəʊn", geo: "NAmE", audio: "grown#_us_2", form: "" } },
                ],
              },
            ],
          },
          {
            ul: [
              {
                li: [
                  { tag: "eb", value: "groan", bold: 1 },
                  { tag: "pos", value: "verb", font_Italic: 1 },
                  {
                    tag: "x-g",
                    value: {
                      x_eng: [{ tag: "eng", value: "The awful jokes made us all groan." }],
                      x_simp: [{ tag: "simp", value: "糟糕的笑话让我们发出抱怨声。" }],
                      xaudio: [],
                    },
                  },
                ],
              },
              {
                li: [
                  { tag: "eb", value: "grown", bold: 1 },
                  {
                    tag: "xr-gs",
                    value: {
                      xrgs_text: "past part. of ",
                      xrg: [{
                        xh: "GROW",
                        xpos: "",
                        xhm: "",
                        xs: "",
                        word_id: "entry-grow",
                        target_id: "entry-grow",
                        target_type: "word",
                      }],
                    },
                  },
                  {
                    tag: "x-g",
                    value: {
                      x_eng: [{ tag: "eng", value: "The business has grown." }],
                      x_simp: [{ tag: "simp", value: "公司发展了。" }],
                      xaudio: [],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }],
    },
  });

  const box = entry.grammarUsageBoxes[0]!;
  assert.deepEqual(box.blocks.map((block) => block.kind), [
    "heading",
    "pronunciations",
    "list",
  ]);
  assert.equal(box.blocks[0]?.kind === "heading" ? box.blocks[0].value.text : undefined, "[diomond]groan [diomond]grown");
  assert.deepEqual(
    box.blocks[1]?.kind === "pronunciations"
      ? box.blocks[1].items.map((pronunciation) => ({
          region: pronunciation.region,
          transcription: pronunciation.transcription,
          audioKey: pronunciation.audioKey,
        }))
      : [],
    [
      { region: "BrE", transcription: "ɡrəʊn", audioKey: "grown#_gb_3" },
      { region: "NAmE", transcription: "ɡrəʊn", audioKey: "grown#_us_2" },
    ],
  );
  const list = box.blocks[2];
  assert.equal(list?.kind, "list");
  if (list?.kind !== "list") {
    assert.fail("Expected the homophone body to remain a structured list.");
  }
  assert.deepEqual(list.items[0]?.segments.map((segment) => segment.kind), ["term", "example"]);
  const groanTerm = list.items[0]?.segments[0];
  assert.equal(groanTerm?.kind === "term" ? groanTerm.headword.text : undefined, "groan");
  assert.equal(groanTerm?.kind === "term" ? groanTerm.partOfSpeech?.text : undefined, "verb");
  assert.deepEqual(list.items[1]?.segments.map((segment) => segment.kind), [
    "term",
    "cross-references",
    "example",
  ]);
  const inflectionReference = list.items[1]?.segments[1];
  assert.deepEqual(
    inflectionReference?.kind === "cross-references"
      ? inflectionReference.references.map((reference) => ({
          kind: reference.kind,
          label: reference.label,
          text: reference.text,
          entryId: reference.entryId,
        }))
      : [],
    [{ kind: "inflection", label: "past part. of", text: "GROW", entryId: "entry-grow" }],
  );
});

test("retains grammar and usage boxes without flattening their bodies", () => {
  const entry = adapter.parse({
    entryId: "entry-grammar",
    headword: "form",
    sourceVersion: "2026.08",
    body: JSON.stringify({
      top_data: { h: [{ tag: "h", value: "form" }] },
      sngs_data: [],
      unbox: [
        {
          id: "box-grammar",
          tile: {
            type: "GRAMMAR POINT",
            eng: "Grammar",
            simp: "语法说明",
          },
          body: [
            { h1: [{ tag: "h1", value: "Countable nouns" }] },
            { p: [{ tag: "p", value: "Use a determiner." }] },
            {
              ul: [
                {
                  li: [
                    {
                      tag: "x-g",
                      value: {
                        x_eng: [{ tag: "eng", value: "This example is visible." }],
                        x_simp: [{ tag: "simp", value: "这个例句可见。" }],
                        xaudio: [],
                      },
                    },
                    {
                      tag: "x-g",
                      value: {
                        x_eng: [],
                        x_simp: [],
                        xaudio: [],
                        x_wx: [{ tag: "wx", value: "Deleted source example", delete_line: 1 }],
                      },
                    },
                  ],
                },
                { li: [{ tag: "eng", value: "[diomond]" }] },
              ],
            },
            {
              table: [
                { tr: [{ th: "form" }, { th: "use" }] },
                { tr: [{ td: "a noun" }, { td: "countable" }] },
              ],
            },
          ],
          custom_box_field: { preserved: "yes" },
        },
      ],
    }),
  });

  assert.equal(entry.grammarUsageBoxes.length, 1);
  assert.equal(entry.grammarUsageBoxes[0]?.type, "GRAMMAR POINT");
  assert.equal(entry.grammarUsageBoxes[0]?.title?.text, "Grammar语法说明");
  assert.equal(entry.grammarUsageBoxes[0]?.body.length, 4);
  assert.deepEqual(entry.grammarUsageBoxes[0]?.blocks.map((block) => block.kind), [
    "heading",
    "paragraph",
    "list",
    "table",
  ]);
  const list = entry.grammarUsageBoxes[0]?.blocks[2];
  assert.equal(list?.kind, "list");
  assert.equal(list?.kind === "list" ? list.items.length : 0, 1);
  assert.equal(
    list?.kind === "list" && list.items[0]?.segments[0]?.kind === "example"
      ? list.items[0].segments[0].value.text.text
      : undefined,
    "This example is visible.",
  );
  const table = entry.grammarUsageBoxes[0]?.blocks[3];
  assert.equal(table?.kind, "table");
  assert.deepEqual(
    table?.kind === "table"
      ? table.rows.map((row) => row.cells.map((cell) => ({
          header: cell.header,
          text: cell.value.text,
        })))
      : [],
    [
      [{ header: true, text: "form" }, { header: true, text: "use" }],
      [{ header: false, text: "a noun" }, { header: false, text: "countable" }],
    ],
  );
  assert.deepEqual(entry.grammarUsageBoxes[0]?.raw.custom_box_field, {
    preserved: "yes",
  });
});

test("preserves ordered pronunciation runs inside a top-level help note", () => {
  const entry = adapter.parse({
    entryId: "entry-abide-help",
    headword: "abide",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "abide" }],
        top_un: [
          { tag: "un", value: "[HELP]" },
          { tag: "eng", value: " In sense 2 " },
          { tag: "eb", value: "abode" },
          { tag: "pron-g", value: "BrE" },
          { tag: "form", value: "" },
          { tag: "phon", value: "əˈbəʊd" },
          { tag: "audio", value: "abode#_gb_1" },
          { tag: "pron-g", value: "NAmE" },
          { tag: "form", value: "" },
          { tag: "phon", value: "əˈbəʊd" },
          { tag: "audio", value: "abode#_us_1" },
          { tag: "pron-gs", value: "/" },
          { tag: "eng", value: "is also used for the past tense and past participle." },
          { tag: "simp", value: " 作第 2 义时过去式和过去分词也用 abode。" },
          { tag: "un_end", value: "" },
        ],
      },
      sngs_data: [],
    },
  });

  const box = entry.grammarUsageBoxes[0];
  assert.equal(box?.type, "HELP 语法说明");
  assert.equal(box?.blocks[0]?.kind, "paragraph");
  if (box?.blocks[0]?.kind !== "paragraph") {
    assert.fail("expected a paragraph help box");
  }
  assert.equal(box.blocks[0].layout, "flow");
  assert.deepEqual(box.blocks[0].segments.map((segment) => segment.kind), [
    "text",
    "pronunciations",
    "text",
  ]);
  assert.equal(
    box.blocks[0].segments[0]?.kind === "text"
      ? box.blocks[0].segments[0].value.text.trim()
      : undefined,
    "In sense 2 abode",
  );
  assert.deepEqual(
    box.blocks[0].segments[1]?.kind === "pronunciations"
      ? box.blocks[0].segments[1].items.map((pronunciation) => pronunciation.audioKey)
      : [],
    ["abode#_gb_1", "abode#_us_1"],
  );
  assert.doesNotMatch(box.blocks[0].value.text, /\[HELP\]|abode#_(?:gb|us)_1/);
});

test("maps top-level origin notes without exposing their transport marker", () => {
  const entry = adapter.parse({
    entryId: "entry-origin-note",
    headword: "origin",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "origin" }],
        top_un: [
          { tag: "un", value: "[ORIGIN]" },
          { tag: "eng", value: "From Latin." },
        ],
      },
      sngs_data: [],
    },
  });

  assert.equal(entry.grammarUsageBoxes[0]?.type, "ORIGIN 词源说明");
  assert.doesNotMatch(
    entry.grammarUsageBoxes[0]?.blocks[0]?.kind === "paragraph"
      ? entry.grammarUsageBoxes[0].blocks[0].value.text
      : "",
    /\[ORIGIN\]/,
  );
});

test("keeps illustrations attached to their own semantic level", () => {
  const entry = adapter.parse({
    entryId: "entry-abdomen",
    headword: "abdomen",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "abdomen" }] },
      sngs_data: [
        {
          id: "abdomen-noun",
          top_data: { pos: [{ tag: "pos", value: "noun" }] },
          ill: [{ tag: "ill", value: "insects" }],
          sngs_data: {
            pos: [{ tag: "pos", value: "noun" }],
            sn_g: [
              {
                id: "abdomen-sense",
                def_eng: [{ tag: "eng", value: "the body of an insect" }],
                ill: [{ tag: "ill", value: "insect-anatomy" }],
              },
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(entry.illustrations, []);
  assert.deepEqual(entry.subentries[0]?.illustrations.map((item) => item.key), [
    "insects",
  ]);
  assert.deepEqual(entry.subentries[0]?.senses[0]?.illustrations.map((item) => item.key), [
    "insect-anatomy",
  ]);
});

test("maps guidewords, references, example patterns, and extended exam labels", () => {
  const entry = adapter.parse({
    entryId: "entry-rest",
    headword: "rest",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [
          { tag: "h", value: "rest" },
          { tag: "h-cefr", value: "[Ox3000 key_L][CEFR_A2_L]" },
          { tag: "h-last", value: "[CET4][CET6][NETM]" },
        ],
      },
      sngs_data: [
        {
          id: "rest-verb",
          top_data: { pos: [{ tag: "pos", value: "verb" }] },
          sngs_data: {
            pos: [{ tag: "pos", value: "verb" }],
            shcut_g: [
              {
                shcut_name: [
                  { tag: "eng", value: "RELAX" },
                  { tag: "simp", value: " 放松" },
                ],
                sn_g: [
                  {
                    id: "rest-relax",
                    def_eng: [{ tag: "eng", value: "to relax" }],
                    x_gs: [
                      {
                        id: "rest-pattern-example",
                        x_eng: [
                          { tag: "cf", value: "rest sth + adv./prep." },
                          { tag: "cl", value: "Rest your head" },
                          { tag: "eng", value: " on my shoulder." },
                        ],
                        x_simp: [{ tag: "simp", value: "把头靠在我肩上。" }],
                      },
                    ],
                    xrgs: [
                      {
                        xrgs_text: "-> see also ",
                        xrg: [
                          {
                            xh: "RESTED",
                            word_id: "entry-rested",
                            target_id: "entry-rested",
                            target_type: "word",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
            idm_gs: [
              {
                idm_g: [
                  {
                    id: "rest-idiom",
                    idm_name: [{ tag: "idm", value: "rest easy" }],
                    sn_g: [],
                  },
                ],
                xrgs: [
                  {
                    xrgs_text: "-> more at ",
                    xrg: [
                      {
                        xh: "EASY",
                        xpos: "adv.",
                        word_id: "entry-easy",
                        target_id: "sense-easy",
                        target_type: "position",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(entry.labels.map((label) => [label.text, label.kind]), [
    ["3000", "frequency"],
    ["A2", "level"],
    ["CET4", "exam"],
    ["CET6", "exam"],
    ["NETM", "exam"],
  ]);
  const verb = entry.subentries[0]!;
  assert.equal(verb.senses[0]?.groupHeading?.text, "RELAX 放松");
  assert.equal(verb.senses[0]?.examples[0]?.pattern?.text, "rest sth + adv./prep.");
  assert.equal(verb.senses[0]?.examples[0]?.text.text, "Rest your head on my shoulder.");
  assert.deepEqual(verb.senses[0]?.crossReferences[0], {
    id: "entry-rested",
    kind: "see-also",
    label: "see also",
    text: "RESTED",
    qualifier: undefined,
    entryId: "entry-rested",
    targetId: "entry-rested",
    targetType: "word",
    raw: {
      xrgs_text: "-> see also ",
      xrg: [
        {
          xh: "RESTED",
          word_id: "entry-rested",
          target_id: "entry-rested",
          target_type: "word",
        },
      ],
    },
  });
  assert.deepEqual(verb.idioms[0]?.trailingCrossReferences.map((reference) => ({
    kind: reference.kind,
    label: reference.label,
    text: reference.text,
    qualifier: reference.qualifier,
    entryId: reference.entryId,
    targetId: reference.targetId,
  })), [
    {
      kind: "more-at",
      label: "more at",
      text: "EASY",
      qualifier: "adv.",
      entryId: "entry-easy",
      targetId: "sense-easy",
    },
  ]);
});

test("classifies every observed cross-reference label and normalizes display labels", () => {
  assert.equal(BUNDLED_BILINGUAL_CROSS_REFERENCE_LABELS.length, 25);
  assert.deepEqual(
    BUNDLED_BILINGUAL_CROSS_REFERENCE_LABELS.map(
      classifyBundledBilingualCrossReference,
    ),
    [
      "synonym",
      "see-also",
      "compare",
      "equivalent",
      "antonym",
      "topic-note",
      "more-at",
      "topic-note",
      "related",
      "note-at",
      "related",
      "topic-note",
      "topic-note",
      "topic-note",
      "inflection",
      "generic",
      "inflection",
      "inflection",
      "inflection",
      "topic-note",
      "inflection",
      "punctuation",
      "inflection",
      "inflection",
      "inflection",
    ],
  );
  assert.equal(
    classifyBundledBilingualCrossReference("-> future reference at"),
    "generic",
  );

  const entry = adapter.parse({
    entryId: "entry-cross-reference-kinds",
    headword: "relations",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "relations" }] },
      xrgs: [
        {
          xrgs_text: " ->   [SYN] ",
          xrg: [{ xh: "ALLY" }],
        },
        {
          xrgs_text: "[OPP]",
          xrg: [{ xh: "OPPONENT" }],
        },
        {
          xrgs_text: " -> compare ",
          xrg: [{ xh: "CONTRAST", xs: " (5) $2" }],
        },
      ],
    },
  });

  assert.deepEqual(
    entry.crossReferences.map((reference) => [
      reference.kind,
      reference.label,
      reference.text,
    ]),
    [
      ["synonym", "[SYN]", "ALLY"],
      ["antonym", "[OPP]", "OPPONENT"],
      ["compare", "compare", "CONTRAST"],
    ],
  );
  assert.equal(entry.crossReferences[2]?.qualifier, "(5)");
});

test("folds source comma groups into the preceding cross-reference relation", () => {
  const entry = adapter.parse({
    entryId: "entry-capitulate",
    headword: "capitulate",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "capitulate" }] },
      xrgs: [
        {
          xrgs_text: "[SYN]",
          xrg: [{ xh: "give in (to sb/sth)", word_id: "entry-give-in" }],
        },
        {
          xrgs_text: ", ",
          xrg: [{ xh: "yield", word_id: "entry-yield" }],
        },
      ],
    },
  });

  assert.deepEqual(entry.crossReferences.map((reference) => ({
    kind: reference.kind,
    label: reference.label,
    text: reference.text,
  })), [
    { kind: "synonym", label: "[SYN]", text: "give in (to sb/sth)" },
    { kind: "synonym", label: "[SYN]", text: "yield" },
  ]);
  assert.deepEqual(entry.crossReferences[1]?.raw, {
    xrgs_text: ", ",
    xrg: [{ xh: "yield", word_id: "entry-yield" }],
  });
});

test("uses first non-empty semantic candidates without dropping reference targets", () => {
  const entry = adapter.parse({
    entryId: "entry-empty-candidates",
    headword: "candidate",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "candidate" }],
        ill: [
          { tag: "ill", url: "", key: "primary-illustration", value: "ignored" },
          { tag: "ill", url: "", key: "", value: "fallback-illustration" },
        ],
      },
      xrgs: [{
        xrgs_text: "= ",
        xrg: [{
          id: "",
          xh: "",
          xw: "ordinary fallback target",
          word_id: "",
          entry_id: "ordinary-entry",
          target_id: "ordinary-target",
        }, {
          id: "explicit-reference",
          xh: "",
          xw: "secondary target",
          word_id: "ordinary-word",
          entry_id: "",
          target_id: "",
        }],
      }],
      xrgs_text: "= ",
      xrgs_subentren: [{
        xrgs_text: "-> see also ",
        xrg: [{ xh: "subentry relation target" }],
      }],
      unbox: [{
        id: "box-empty-candidates",
        tile: {
          type: "GRAMMAR POINT",
          eng: [{
            id: "",
            text: "",
            xh: "",
            xw: "grammar fallback target",
            word_id: "",
            entry_id: "grammar-entry",
            target_id: "grammar-target",
          }],
          simp: "",
        },
        body: [{
          h1: [{
            ul: [],
            ol: [{ li: [{ tag: "eng", value: "Ordered fallback heading" }] }],
          }],
        }],
      }],
      sngs_data: [{
        id: "",
        top_data: { h: [{ tag: "h", value: "candidate" }] },
        sngs_data: {
          sn_g: [{
            id: "nested-sense",
            x_gs: [{
              id: "",
              x_eng: [{ tag: "eng", value: "A nested example." }],
              xaudio: [{
                tag: "xaudio",
                value: { geo: "br", url: "", audio: "fallback-example-audio" },
              }],
            }],
          }],
        },
      }],
    },
  });

  assert.deepEqual(entry.illustrations.map((illustration) => illustration.key), [
    "primary-illustration",
    "fallback-illustration",
  ]);
  assert.deepEqual(entry.crossReferences.map((reference) => ({
    id: reference.id,
    text: reference.text,
    entryId: reference.entryId,
    targetId: reference.targetId,
  })), [
    {
      id: "ordinary-target",
      text: "ordinary fallback target",
      entryId: "ordinary-entry",
      targetId: "ordinary-target",
    },
    {
      id: "explicit-reference",
      text: "secondary target",
      entryId: "ordinary-word",
      targetId: undefined,
    },
    {
      id: undefined,
      text: "subentry relation target",
      entryId: undefined,
      targetId: undefined,
    },
  ]);
  assert.equal(entry.grammarUsageBoxes[0]?.references?.[0]?.id, "grammar-target");
  assert.equal(entry.grammarUsageBoxes[0]?.references?.[0]?.entryId, "grammar-entry");
  assert.equal(entry.grammarUsageBoxes[0]?.references?.[0]?.text, "grammar fallback target");
  assert.equal(entry.grammarUsageBoxes[0]?.blocks[0]?.kind, "heading");
  assert.equal(
    entry.grammarUsageBoxes[0]?.blocks[0]?.kind === "heading"
      ? entry.grammarUsageBoxes[0].blocks[0].value.text
      : undefined,
    "Ordered fallback heading",
  );
  assert.equal(entry.subentries[0]?.id, "entry-empty-candidates:subentry:0");
  assert.equal(entry.subentries[0]?.senses[0]?.examples[0]?.audio[0]?.key, "fallback-example-audio");
});

test("preserves POS context, sense nesting, source order, and empty sense fields", () => {
  const entry = adapter.parse({
    entryId: "entry-polysemy",
    headword: "record",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "record" }] },
      sngs_data: {
        sense_groups: [
          {
            pos: [
              {
                tag: "pos",
                value: " Verb ",
                source_order: 1,
                retained_pos_property: true,
              },
            ],
            sn_g: [
              {
                id: "verb-parent",
                def_eng: [{ tag: "eng", value: "to store information" }],
                retained_parent_property: { value: "preserved" },
                sngs_data: {
                  sn_g: [
                    {
                      id: "verb-child-first",
                      def_eng: [{ tag: "eng", value: "to make an audio copy" }],
                      retained_child_property: "first",
                    },
                    {
                      id: "verb-child-second",
                      x_gs: [],
                      un: [],
                    },
                  ],
                },
              },
            ],
          },
          {
            pos: [{ tag: "pos", value: "Noun", source_order: 2 }],
            sn_g: [
              {
                id: "noun-parent",
                def_eng: [{ tag: "eng", value: "stored information" }],
              },
            ],
          },
          {
            sn_g: [{ id: "unclassified" }],
          },
        ],
      },
      unrecognized_root_field: { retained: true },
    },
  });

  assert.deepEqual(entry.partsOfSpeech.map((part) => part.text), [
    "Verb",
    "Noun",
  ]);
  assert.equal(entry.partsOfSpeech[0]?.tokens[0]?.text, " Verb ");
  assert.equal(entry.partsOfSpeech[0]?.tokens[0]?.raw.retained_pos_property, true);
  assert.deepEqual(entry.senses.map((sense) => sense.id), [
    "verb-parent",
    "noun-parent",
    "unclassified",
  ]);
  assert.deepEqual(entry.senses.map((sense) => sense.partOfSpeech), [
    "verb",
    "noun",
    undefined,
  ]);
  assert.deepEqual(entry.senses[0]?.subsenses.map((sense) => sense.id), [
    "verb-child-first",
    "verb-child-second",
  ]);
  assert.deepEqual(
    entry.senses[0]?.subsenses.map((sense) => sense.partOfSpeech),
    ["verb", "verb"],
  );
  assert.equal(entry.senses[0]?.subsenses[0]?.raw.retained_child_property, "first");
  assert.deepEqual(entry.senses[0]?.raw.retained_parent_property, {
    value: "preserved",
  });
  assert.equal(entry.senses[2]?.definition, undefined);
  assert.equal(entry.senses[2]?.translation, undefined);
  assert.deepEqual(entry.senses[2]?.examples, []);
  assert.deepEqual(entry.senses[2]?.subsenses, []);
  assert.deepEqual(entry.raw.unrecognized_root_field, { retained: true });

  const entryWithoutPhraseGroups: Record<string, unknown> = { ...entry };
  delete entryWithoutPhraseGroups.idioms;
  delete entryWithoutPhraseGroups.phrasalVerbs;
  const legacyEntry = {
    ...entryWithoutPhraseGroups,
    senses: entry.senses.map((sense) => {
      const legacySense: Record<string, unknown> = { ...sense };
      delete legacySense.subsenses;
      return legacySense;
    }),
  };
  const parsedLegacyEntry = canonicalEntrySchema.parse(legacyEntry);
  assert.deepEqual(parsedLegacyEntry.senses[0]?.subsenses, []);
  assert.deepEqual(parsedLegacyEntry.idioms, []);
  assert.deepEqual(parsedLegacyEntry.phrasalVerbs, []);
});

test("maps idioms and phrasal verbs from root and subentry phrase groups", () => {
  const entry = adapter.parse({
    entryId: "entry-fuck",
    headword: "fuck",
    sourceVersion: "2026.08",
    body: {
      top_data: {
        h: [{ tag: "h", value: "fuck" }],
        pos: [{ tag: "pos", value: "verb" }],
      },
      sngs_data: [
        {
          top_data: "",
          sngs_data: {
            idm_gs: [
              {
                idm_g: [
                  {
                    id: "root-idiom-one",
                    idm_name: [
                      {
                        tag: "idm",
                        value: "fuck all",
                        retained_name_property: "one",
                      },
                    ],
                    sn_g: [
                      {
                        id: "root-idiom-sense",
                        def_eng: [{ tag: "eng", value: "nothing at all" }],
                        def_simp: [{ tag: "simp", value: "什么也没有" }],
                        x_gs: [
                          {
                            id: "root-idiom-example",
                            x_eng: [{ tag: "eng", value: "I know fuck all." }],
                            x_simp: [{ tag: "simp", value: "我什么也不知道。" }],
                            retained_example_property: true,
                          },
                        ],
                      },
                    ],
                    retained_phrase_property: { position: "first" },
                  },
                  {
                    id: "root-idiom-two",
                    idm_name: [{ tag: "idm", value: "not give a fuck" }],
                    sn_g: [],
                  },
                ],
              },
              {
                idm_g: [
                  {
                    id: "root-idiom-three",
                    idm_name: [{ tag: "idm", value: "for fuck's sake" }],
                    sn_g: [],
                  },
                ],
              },
            ],
            pv_gs: [
              {
                pv_g: [
                  {
                    id: "root-pv-one",
                    pv_name: [{ tag: "pv", value: "fuck about" }],
                    sn_g: [
                      {
                        id: "root-pv-sense",
                        def_eng: [{ tag: "eng", value: "waste time" }],
                        x_gs: [],
                      },
                    ],
                    retained_pv_property: "root",
                  },
                  {
                    id: "root-pv-two",
                    pv_name: [{ tag: "pv", value: "fuck up" }],
                    sn_g: [],
                  },
                ],
              },
            ],
          },
        },
        {
          id: "entry-fuck-noun",
          top_data: {
            h: [{ tag: "h", value: "fuck" }],
            pos: [{ tag: "pos", value: "noun" }],
          },
          sngs_data: {
            idm_gs: [
              {
                idm_g: [
                  {
                    id: "subentry-idiom",
                    idm_name: [{ tag: "idm", value: "give a fuck" }],
                    sn_g: [
                      {
                        id: "subentry-idiom-sense",
                        def_eng: [{ tag: "eng", value: "care about something" }],
                        x_gs: [],
                      },
                    ],
                  },
                ],
              },
            ],
            pv_gs: [
              {
                pv_g: [
                  {
                    id: "subentry-pv",
                    pv_name: [{ tag: "pv", value: "fuck off" }],
                    sn_g: [],
                  },
                ],
              },
            ],
          },
        },
      ],
      dr_gs: [{ tag: "dr", value: "fucker" }],
    },
  });

  assert.deepEqual(entry.senses, []);
  assert.deepEqual(entry.idioms.map((phrase) => phrase.display.text), [
    "fuck all",
    "not give a fuck",
    "for fuck's sake",
  ]);
  assert.deepEqual(entry.phrasalVerbs.map((phrase) => phrase.display.text), [
    "fuck about",
    "fuck up",
  ]);
  assert.equal(entry.idioms[0]?.display.tokens[0]?.raw.retained_name_property, "one");
  assert.equal(entry.idioms[0]?.senses[0]?.definition?.text, "nothing at all");
  assert.equal(entry.idioms[0]?.senses[0]?.examples[0]?.text.text, "I know fuck all.");
  assert.equal(entry.idioms[0]?.senses[0]?.examples[0]?.translation?.text, "我什么也不知道。");
  assert.equal(entry.idioms[0]?.senses[0]?.partOfSpeech, "verb");
  assert.deepEqual(entry.idioms[0]?.raw.retained_phrase_property, {
    position: "first",
  });
  assert.equal(entry.phrasalVerbs[0]?.raw.retained_pv_property, "root");
  assert.deepEqual(entry.derivedForms.map((form) => form.text), ["fucker"]);

  const subentry = entry.subentries[0];
  assert.equal(subentry?.idioms.length, 1);
  assert.equal(subentry?.idioms[0]?.display.text, "give a fuck");
  assert.equal(subentry?.idioms[0]?.senses[0]?.partOfSpeech, "noun");
  assert.deepEqual(subentry?.phrasalVerbs.map((phrase) => phrase.display.text), [
    "fuck off",
  ]);
});

test("preserves phrase-group usage and structured alternative phrase wording", () => {
  const entry = adapter.parse({
    entryId: "entry-phrase-metadata",
    headword: "steady",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "steady" }] },
      idm_gs: [{
        un: [
          { tag: "un", value: "[HELP]" },
          { tag: "eng", value: " Idioms containing steady are listed elsewhere." },
        ],
        idm_g: [{
          id: "steady-idiom",
          idm_name: [{ tag: "idm", value: "steady on" }],
          idm_text: [
            { tag: "v-gs", value: " (" },
            { tag: "v", value: "also " },
            { tag: "v", value: "'steady on!'" },
            { tag: "v-gs", value: ")" },
          ],
          sn_g: [],
        }, {
          id: "steady-idiom-regional-alternative",
          idm_name: [{ tag: "idm", value: "steady as she goes" }],
          idm_text: [
            { tag: "v-gs", value: " (" },
            { tag: "geo", value: "NAmE also" },
            { tag: "label-g", value: " " },
            { tag: "v", value: "steady on course" },
            { tag: "v-gs", value: ")" },
          ],
          sn_g: [],
        }],
      }],
      pv_gs: [{
        pv_g: [{
          id: "steady-pv",
          pv_name: [{ tag: "pv", value: "steady sth" }],
          pv_text: [
            { tag: "label-g", value: " (" },
            { tag: "geo", value: "BrE" },
            { tag: "label-g", value: ") " },
            { tag: "v-gs", value: " (" },
            { tag: "geo", value: "NAmE" },
            { tag: "label-g", value: " " },
            { tag: "v", value: "steady something up" },
            { tag: "v-gs", value: ")" },
          ],
          sn_g: [{
            id: "steady-pv-equivalent-sense",
            sng_text: [
              { tag: "label-g", value: " (" },
              { tag: "geo", value: "NAmE" },
              { tag: "label-g", value: ") " },
            ],
            xrgs: [{
              xrgs_text: "= ",
              xrg: [{
                xh: "",
                xw: "STEADY STH UP",
                word_id: "entry-phrase-metadata",
                target_id: "steady-pv-target",
                target_type: "position",
              }],
            }],
          }],
        }],
      }],
    },
  });

  const idiom = entry.idioms[0]!;
  assert.equal(idiom.leadingUsage[0]?.text, "[HELP] Idioms containing steady are listed elsewhere.");
  assert.deepEqual(idiom.variants.map((form) => ({
    kind: form.kind,
    introducer: form.introducer?.text.trim(),
    relation: form.relation,
    text: form.text,
  })), [{
    kind: "variant",
    introducer: "also",
    relation: "alternative",
    text: "'steady on!'",
  }]);
  assert.equal(entry.idioms[1]?.variants[0]?.relation, "alternative");

  const phrasalVerb = entry.phrasalVerbs[0]!;
  assert.deepEqual(phrasalVerb.labels.map((label) => [label.text, label.kind]), [
    ["BrE", "geo"],
  ]);
  assert.deepEqual(phrasalVerb.variants.map((form) => ({
    introducer: form.introducer?.text.trim(),
    labels: form.labels?.map((label) => [label.text, label.kind]),
    relation: form.relation,
    text: form.text,
  })), [{
    introducer: undefined,
    labels: [["NAmE", "geo"]],
    relation: "equivalent",
    text: "steady something up",
  }]);
  assert.deepEqual(phrasalVerb.senses[0]?.crossReferences.map((reference) => ({
    kind: reference.kind,
    label: reference.label,
    text: reference.text,
    entryId: reference.entryId,
    targetId: reference.targetId,
  })), [{
    kind: "equivalent",
    label: "=",
    text: "STEADY STH UP",
    entryId: "entry-phrase-metadata",
    targetId: "steady-pv-target",
  }]);
});

test("keeps examples and audio nested in box paragraphs and table cells", () => {
  const entry = adapter.parse({
    entryId: "entry-box-content-flow",
    headword: "flow",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "flow" }] },
      unbox: [{
        id: "box-content-flow",
        tile: { type: "GRAMMAR POINT", eng: "Flow", simp: "" },
        body: [
          {
            p: [
              { "trans-g": [{ tag: "eng", value: "A paragraph lead-in." }] },
              {
                "x-gs": [{
                  tag: "x-g",
                  value: {
                    id: "paragraph-example",
                    x_eng: [{ tag: "eng", value: "Paragraph example." }],
                    x_simp: [{ tag: "simp", value: "段落例句。" }],
                    xaudio: [{ tag: "xaudio", value: { geo: "br", url: "paragraph_audio" } }],
                  },
                }],
              },
            ],
          },
          {
            table: [{
              tr: [{
                td: [{
                  tag: "x-g",
                  value: {
                    id: "table-example",
                    x_eng: [{ tag: "eng", value: "Table example." }],
                    x_simp: [{ tag: "simp", value: "表格例句。" }],
                    xaudio: [{ tag: "xaudio", value: { geo: "na", url: "table_audio" } }],
                  },
                }],
              }],
            }],
          },
        ],
      }],
    },
  });

  const box = entry.grammarUsageBoxes[0]!;
  const paragraph = box.blocks[0];
  assert.equal(paragraph?.kind, "paragraph");
  assert.equal(paragraph?.kind === "paragraph" ? paragraph.value.text : undefined, "A paragraph lead-in.");
  assert.deepEqual(
    paragraph?.kind === "paragraph"
      ? paragraph.segments.map((segment) => segment.kind)
      : [],
    ["text", "example"],
  );
  assert.equal(
    paragraph?.kind === "paragraph" && paragraph.segments[1]?.kind === "example"
      ? paragraph.segments[1].value.audio[0]?.key
      : undefined,
    "paragraph_audio",
  );

  const table = box.blocks[1];
  assert.equal(table?.kind, "table");
  const tableExample = table?.kind === "table"
    ? table.rows[0]?.cells[0]?.segments[0]
    : undefined;
  assert.equal(tableExample?.kind === "example" ? tableExample.value.text.text : undefined, "Table example.");
  assert.equal(tableExample?.kind === "example" ? tableExample.value.audio[0]?.key : undefined, "table_audio");
});

test("preserves the ordered examples embedded in flattened sense usage", () => {
  const entry = adapter.parse({
    entryId: "entry-usage-example-flow",
    headword: "act",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "act" }] },
      sngs_data: [{
        sn_g: [{
          id: "usage-sense",
          def_eng: [{ tag: "eng", value: "behave in a particular way" }],
          un: [
            { tag: "un", value: "[HELP]" },
            { tag: "eng", value: " In spoken English, use this phrase carefully." },
            { tag: "x-gs", value: " " },
            { tag: "x-g", value: "", id: "usage-example" },
            { tag: "x", value: "" },
            { tag: "eng", value: " She was acting like a child." },
            { tag: "simp", value: " 她表现得像个孩子。" },
            { tag: "xaudio", value: { geo: "br", url: "usage_example_gb" } },
            { tag: "xaudio", value: { geo: "na", url: "usage_example_us" } },
            { tag: "x-g_end", value: "" },
            { tag: "eng", value: " This phrase is informal." },
          ],
          x_gs: [],
        }],
      }],
    },
  });

  const usage = entry.senses[0]?.usageSegments ?? [];
  assert.deepEqual(usage.map((segment) => segment.kind), ["text", "example", "text"]);
  assert.equal(usage[0]?.kind === "text" ? usage[0].value.text : undefined, "[HELP] In spoken English, use this phrase carefully.");
  assert.equal(usage[1]?.kind === "example" ? usage[1].value.id : undefined, "usage-example");
  assert.equal(usage[1]?.kind === "example" ? usage[1].value.text.text : undefined, " She was acting like a child.");
  assert.equal(usage[1]?.kind === "example" ? usage[1].value.translation?.text : undefined, " 她表现得像个孩子。");
  assert.deepEqual(
    usage[1]?.kind === "example" ? usage[1].value.audio.map((audio) => audio.key) : [],
    ["usage_example_gb", "usage_example_us"],
  );
  assert.equal(usage[2]?.kind === "text" ? usage[2].value.text : undefined, " This phrase is informal.");
});

test("attaches shared sense-group usage to its first sense without duplication", () => {
  const entry = adapter.parse({
    entryId: "entry-shared-usage",
    headword: "during",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "during" }] },
      sngs_data: [{
        sngs_data: {
          un: [
            { tag: "un", value: "[HELP]" },
            { tag: "eng", value: " Distinguish this word carefully." },
            { tag: "x-g", value: "", id: "shared-usage-example" },
            { tag: "eng", value: " I stayed for a week." },
            { tag: "simp", value: " 我待了一周。" },
            { tag: "xaudio", value: { geo: "br", url: "shared_usage_gb" } },
            { tag: "x-g_end", value: "" },
          ],
          sn_g: [{
            id: "shared-first-sense",
            def_eng: [{ tag: "eng", value: "throughout a period" }],
            x_gs: [],
          }, {
            id: "shared-second-sense",
            def_eng: [{ tag: "eng", value: "at some point in a period" }],
            x_gs: [],
          }],
        },
      }],
    },
  });

  assert.deepEqual(entry.senses[0]?.usageSegments.map((segment) => segment.kind), ["text", "example"]);
  assert.equal(
    entry.senses[0]?.usageSegments[1]?.kind === "example"
      ? entry.senses[0].usageSegments[1].value.audio[0]?.key
      : undefined,
    "shared_usage_gb",
  );
  assert.deepEqual(entry.senses[1]?.usageSegments, []);
});

test("keeps nested box examples and decorated terms in their semantic order", () => {
  const entry = adapter.parse({
    entryId: "entry-box-nested-content",
    headword: "site",
    sourceVersion: "2026.08",
    body: {
      top_data: { h: [{ tag: "h", value: "site" }] },
      unbox: [{
        id: "nested-box-content",
        tile: { type: "HOMOPHONES", eng: "", simp: "" },
        body: [{
          ul: [{
            li: [
              { tag: "li_text", value: "[diomond]" },
              { tag: "eb", value: "sight" },
              { tag: "pos", value: "noun" },
              {
                tag: "trans-g",
                value: {
                  eng: [{ tag: "eng", value: "A place that you can see: " }, {
                    tag: "x-g",
                    value: {
                      id: "nested-box-example",
                      x_eng: [{ tag: "eng", value: "The sight was beautiful." }],
                      x_simp: [{ tag: "simp", value: "景色很美。" }],
                      xaudio: [{ tag: "xaudio", value: { geo: "br", url: "nested_box_gb" } }],
                    },
                  }],
                  simp: [{ tag: "simp", value: "可看见的地方：" }],
                },
              },
            ],
          }],
        }],
      }],
    },
  });

  const block = entry.grammarUsageBoxes[0]?.blocks[0];
  const segments = block?.kind === "list" ? block.items[0]?.segments ?? [] : [];
  assert.deepEqual(segments.map((segment) => segment.kind), ["term", "text", "example", "text"]);
  assert.equal(segments[0]?.kind === "term" ? segments[0].headword.text : undefined, "sight");
  assert.equal(segments[0]?.kind === "term" ? segments[0].partOfSpeech?.text : undefined, "noun");
  assert.equal(segments[2]?.kind === "example" ? segments[2].value.id : undefined, "nested-box-example");
  assert.equal(segments[2]?.kind === "example" ? segments[2].value.audio[0]?.key : undefined, "nested_box_gb");
});

test("validates external input and exposes source-neutral registry lookup", () => {
  assert.throws(
    () => adapter.parse({ headword: "missing envelope fields" }),
    /entryId/,
  );
  assert.throws(
    () =>
      adapter.parse({
        entryId: "invalid-body",
        headword: "invalid",
        sourceVersion: "test",
        body: "{",
      }),
    /valid JSON/,
  );

  const registry = new DictionaryAdapterRegistry().register(adapter);
  assert.equal(registry.get("bundled-bilingual"), adapter);
  assert.throws(() => registry.convert("missing", {}), /No dictionary adapter/);
});
