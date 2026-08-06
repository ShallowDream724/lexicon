import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalEntry,
  type CanonicalText,
} from "../../../packages/dictionary-schema/src/index";

const text = (value: string): CanonicalText => ({
  text: value,
  tokens: [],
  raw: value,
});

export const demoEntry: CanonicalEntry = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  dictionaryId: "core-english-zh",
  sourceVersion: "preview-v1",
  id: "preview-completion",
  headword: "completion",
  displayHeadword: "com·ple·tion",
  searchKey: "completion",
  labels: [
    { text: "5000", kind: "frequency", raw: "5000" },
    { text: "B2", kind: "level", raw: "B2" },
  ],
  pronunciations: [
    {
      region: "BrE",
      transcription: "/kəmˈpliːʃn/",
      audioKey: "completion#_gb_1",
      raw: {},
    },
    {
      region: "NAmE",
      transcription: "/kəmˈpliːʃn/",
      audioKey: "completion#_us_1",
      raw: {},
    },
  ],
  partsOfSpeech: [{ text: "noun", tokens: [], raw: "noun" }],
  senses: [
    {
      id: "preview-completion-1",
      order: 0,
      labels: [],
      definition: text("the act or process of finishing something"),
      translation: text("完成；结束；完结"),
      examples: [
        {
          id: "preview-example-1",
          text: text("The project is nearing completion."),
          translation: text("这项工程即将完成。"),
          audio: [],
          raw: {},
        },
        {
          id: "preview-example-2",
          text: text("A target date was set for the completion of the work."),
          translation: text("这项工作的完成日期已经确定。"),
          audio: [],
          raw: {},
        },
      ],
      usage: [],
      usageSegments: [],
      subsenses: [],
      crossReferences: [],
      illustrations: [],
      grammarUsageBoxes: [],
      raw: {},
    },
    {
      id: "preview-completion-2",
      order: 1,
      labels: [],
      definition: text("the state of being finished"),
      translation: text("完成状态；结束"),
      examples: [
        {
          id: "preview-example-3",
          text: text("The new homes are due for completion next year."),
          translation: text("这些新住宅预计明年竣工。"),
          audio: [],
          raw: {},
        },
      ],
      usage: [],
      usageSegments: [],
      subsenses: [],
      crossReferences: [],
      illustrations: [],
      grammarUsageBoxes: [],
      raw: {},
    },
  ],
  subentries: [],
  idioms: [],
  phrasalVerbs: [],
  derivedForms: [],
  inflectedForms: [],
  crossReferences: [],
  illustrations: [],
  grammarUsageBoxes: [],
  raw: {},
};
