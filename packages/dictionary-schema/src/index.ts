import { z } from "zod";

export const CANONICAL_SCHEMA_VERSION = "1.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

export interface SourceToken {
  tag?: string;
  value?: JsonValue;
  text: string;
  raw: JsonObject;
}

export interface CanonicalLabel {
  text: string;
  kind?: string;
  /** Source-owned separator that precedes this label inside a semantic label list. */
  separatorBefore?: "," | ";";
  raw: JsonValue;
}

export interface CanonicalPronunciation {
  transcription?: string;
  region?: string;
  audioKey?: string;
  form?: string;
  raw: JsonObject;
}

export interface CanonicalPartOfSpeech {
  text: string;
  tokens: SourceToken[];
  raw: JsonValue;
}

export interface CanonicalText {
  text: string;
  tokens: SourceToken[];
  /** Minimal source provenance for inline text whose rendering role depends on its owner. */
  origin?: CanonicalTextOrigin;
  raw: JsonValue;
}

export const CANONICAL_TEXT_ORIGINS = ["use", "dis-g"] as const;

export type CanonicalTextOrigin = (typeof CANONICAL_TEXT_ORIGINS)[number];

export interface CanonicalAudioReference {
  key: string;
  region?: string;
  raw: JsonObject;
}

export interface CanonicalExample {
  id?: string;
  pattern?: CanonicalText;
  text: CanonicalText;
  translation?: CanonicalText;
  audio: CanonicalAudioReference[];
  raw: JsonObject;
}

export interface CanonicalSense {
  id?: string;
  order: number;
  /** Normalized textual reference to the nearest unambiguous part of speech. */
  partOfSpeech?: string;
  /** A source guideword shared by one or more adjacent senses. */
  groupHeading?: CanonicalText;
  /** Grammatical constructions or fixed wording shown before the definition. */
  patterns?: CanonicalText[];
  /** Parenthetical alternative wording scoped to this sense. */
  variants?: CanonicalForm[];
  /** Inflected forms and constraints scoped to this sense. */
  inflectedForms?: CanonicalForm[];
  /** Pronunciations that qualify this sense rather than the whole headword. */
  pronunciations?: CanonicalPronunciation[];
  labels: CanonicalLabel[];
  definition?: CanonicalText;
  /** Ordered definition content when the source embeds pronunciation or other rich runs. */
  definitionSegments?: CanonicalBoxSegment[];
  translation?: CanonicalText;
  examples: CanonicalExample[];
  /** Parenthetical usage content that precedes the definition in the source. */
  inlineUsage?: CanonicalText[];
  usage: CanonicalText[];
  /** Ordered usage content, including embedded examples and their audio. */
  usageSegments: CanonicalBoxSegment[];
  crossReferences: CanonicalCrossReference[];
  illustrations: CanonicalIllustration[];
  grammarUsageBoxes: CanonicalGrammarUsageBox[];
  subsenses: CanonicalSense[];
  raw: JsonObject;
}

export interface CanonicalPhrase {
  id?: string;
  display: CanonicalText;
  /** Labels that qualify the primary phrase wording. */
  labels: CanonicalLabel[];
  /** Alternative or regional phrase wording in source order. */
  variants: CanonicalForm[];
  /** Group-level usage text shown before the first phrase in a source group. */
  leadingUsage: CanonicalText[];
  senses: CanonicalSense[];
  /** References that follow this phrase or its source phrase group. */
  trailingCrossReferences: CanonicalCrossReference[];
  raw: JsonObject;
}

export const CANONICAL_FORM_RELATIONS = ["alternative", "equivalent"] as const;

export type CanonicalFormRelation = (typeof CANONICAL_FORM_RELATIONS)[number];

export type CanonicalFormPresentationItem =
  | { kind: "introducer"; value: CanonicalText }
  | { kind: "label"; value: CanonicalLabel }
  | { kind: "pronunciation" }
  | { kind: "target" };

export interface CanonicalForm {
  id?: string;
  kind: string;
  text: string;
  partOfSpeech?: string;
  note?: CanonicalText;
  /** Source wording that introduces a form, for example "also" or "plural". */
  introducer?: CanonicalText;
  /** Presentation relationship between the primary and alternate wording. */
  relation?: CanonicalFormRelation;
  /** Register or regional qualifiers that belong to this form. */
  labels?: CanonicalLabel[];
  /** Ordered semantic items around the form target. */
  presentation?: CanonicalFormPresentationItem[];
  /** Alternative spellings or regional equivalents attached to this form. */
  variants?: CanonicalForm[];
  /** Parenthetical usage guidance attached to this form. */
  usage?: CanonicalText[];
  /** Inflected forms and constraints attached to this form. */
  inflectedForms?: CanonicalForm[];
  tokens: SourceToken[];
  pronunciations?: CanonicalPronunciation[];
  senses?: CanonicalSense[];
  raw: JsonValue;
}

/** Stable presentation semantics for a dictionary cross-reference. */
export const CANONICAL_CROSS_REFERENCE_KINDS = [
  "synonym",
  "antonym",
  "compare",
  "see-also",
  "more-at",
  "note-at",
  "topic-note",
  "related",
  "inflection",
  "equivalent",
  "punctuation",
  "generic",
] as const;

export type CanonicalCrossReferenceKind =
  (typeof CANONICAL_CROSS_REFERENCE_KINDS)[number];

export interface CanonicalCrossReference {
  id?: string;
  /** Source-neutral semantic category for consistent rendering and navigation. */
  kind?: CanonicalCrossReferenceKind;
  label?: string;
  text: string;
  qualifier?: string;
  entryId?: string;
  targetId?: string;
  targetType?: string;
  raw: JsonValue;
}

export interface CanonicalIllustration {
  key?: string;
  text?: string;
  raw: JsonValue;
}

export interface CanonicalBoxTextSegment {
  kind: "text";
  value: CanonicalText;
  /** A source-marked term or pattern introduced and explained by this segment. */
  term?: CanonicalText;
  raw: JsonValue;
}

export interface CanonicalBoxExampleSegment {
  kind: "example";
  value: CanonicalExample;
  raw: JsonValue;
}

export interface CanonicalBoxTermSegment {
  kind: "term";
  headword: CanonicalText;
  partOfSpeech?: CanonicalText;
  raw: JsonValue;
}

export interface CanonicalBoxCrossReferenceSegment {
  kind: "cross-references";
  references: CanonicalCrossReference[];
  raw: JsonValue;
}

export interface CanonicalBoxPronunciationSegment {
  kind: "pronunciations";
  items: CanonicalPronunciation[];
  raw: JsonValue;
}

export type CanonicalBoxSegment =
  | CanonicalBoxTextSegment
  | CanonicalBoxExampleSegment
  | CanonicalBoxTermSegment
  | CanonicalBoxCrossReferenceSegment
  | CanonicalBoxPronunciationSegment;

export interface CanonicalBoxListItem {
  segments: CanonicalBoxSegment[];
  raw: JsonObject;
}

export interface CanonicalBoxTableCell {
  header: boolean;
  value: CanonicalText;
  /** Ordered rich content, including examples and inline cross references. */
  segments: CanonicalBoxSegment[];
  raw: JsonObject;
}

export interface CanonicalBoxTableRow {
  cells: CanonicalBoxTableCell[];
  raw: JsonObject;
}

export type CanonicalBoxBlock =
  | {
      kind: "heading";
      level: 1 | 2 | 3;
      value: CanonicalText;
      raw: JsonObject;
    }
  | {
      kind: "paragraph";
      value: CanonicalText;
      /** Ordered rich content, including examples and inline cross references. */
      segments: CanonicalBoxSegment[];
      /** Keeps adjacent text and pronunciation segments in one reading flow. */
      layout?: "flow";
      raw: JsonObject;
    }
  | {
      kind: "list";
      items: CanonicalBoxListItem[];
      raw: JsonObject;
    }
  | {
      kind: "pronunciations";
      items: CanonicalPronunciation[];
      raw: JsonObject;
    }
  | {
      kind: "cross-references";
      references: CanonicalCrossReference[];
      raw: JsonObject;
    }
  | {
      kind: "table";
      rows: CanonicalBoxTableRow[];
      raw: JsonObject;
    }
  | {
      kind: "unknown";
      value: CanonicalText;
      raw: JsonObject;
    };

export const CANONICAL_RESOURCE_CATEGORIES = [
  "grammar",
  "express-yourself",
  "vocabulary-building",
  "synonyms",
  "which-word",
  "language-bank",
  "collocations",
  "homophones",
  "british-american",
  "more-about",
  "wordfinder",
  "help",
  "origin",
  "note",
  "other",
] as const;

export type CanonicalResourceCategory = (typeof CANONICAL_RESOURCE_CATEGORIES)[number];

export interface CanonicalGrammarUsageBox {
  id?: string;
  /** Source label retained for presentation where a normalized category is insufficient. */
  type?: string;
  /** Normalized card category shared by all adapters and projections. */
  resourceCategory?: CanonicalResourceCategory;
  title?: CanonicalText;
  references?: CanonicalCrossReference[];
  blocks: CanonicalBoxBlock[];
  body: JsonValue[];
  raw: JsonObject;
}

export interface CanonicalEntry {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  dictionaryId: string;
  sourceVersion: string;
  id: string;
  headword: string;
  displayHeadword: string;
  searchKey: string;
  labels: CanonicalLabel[];
  pronunciations: CanonicalPronunciation[];
  partsOfSpeech: CanonicalPartOfSpeech[];
  /** Entry-level constructions that belong below the part-of-speech heading. */
  headwordPatterns?: CanonicalText[];
  /** Parenthetical usage guidance attached to the headword. */
  headwordUsage?: CanonicalText[];
  senses: CanonicalSense[];
  subentries: CanonicalEntry[];
  idioms: CanonicalPhrase[];
  phrasalVerbs: CanonicalPhrase[];
  derivedForms: CanonicalForm[];
  inflectedForms: CanonicalForm[];
  /** Alternative headword forms, kept separate from grammatical inflections. */
  variants?: CanonicalForm[];
  crossReferences: CanonicalCrossReference[];
  illustrations: CanonicalIllustration[];
  grammarUsageBoxes: CanonicalGrammarUsageBox[];
  raw: JsonObject;
}

const sourceTokenSchema = z.object({
  tag: z.string().optional(),
  value: jsonValueSchema.optional(),
  text: z.string(),
  raw: jsonObjectSchema,
});

const canonicalTextSchema = z.object({
  text: z.string(),
  tokens: z.array(sourceTokenSchema),
  origin: z.enum(CANONICAL_TEXT_ORIGINS).optional(),
  raw: jsonValueSchema,
});

const canonicalLabelSchema = z.object({
  text: z.string(),
  kind: z.string().optional(),
  separatorBefore: z.enum([",", ";"]).optional(),
  raw: jsonValueSchema,
});

const canonicalPronunciationSchema = z.object({
  transcription: z.string().optional(),
  region: z.string().optional(),
  audioKey: z.string().optional(),
  form: z.string().optional(),
  raw: jsonObjectSchema,
});

const canonicalAudioReferenceSchema = z.object({
  key: z.string(),
  region: z.string().optional(),
  raw: jsonObjectSchema,
});

const canonicalExampleSchema = z.object({
  id: z.string().optional(),
  pattern: canonicalTextSchema.optional(),
  text: canonicalTextSchema,
  translation: canonicalTextSchema.optional(),
  audio: z.array(canonicalAudioReferenceSchema),
  raw: jsonObjectSchema,
});

const canonicalCrossReferenceSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(CANONICAL_CROSS_REFERENCE_KINDS).optional(),
  label: z.string().optional(),
  text: z.string(),
  qualifier: z.string().optional(),
  entryId: z.string().optional(),
  targetId: z.string().optional(),
  targetType: z.string().optional(),
  raw: jsonValueSchema,
});

const canonicalIllustrationSchema = z.object({
  key: z.string().optional(),
  text: z.string().optional(),
  raw: jsonValueSchema,
});

const canonicalBoxSegmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    value: canonicalTextSchema,
    term: canonicalTextSchema.optional(),
    raw: jsonValueSchema,
  }),
  z.object({
    kind: z.literal("example"),
    value: canonicalExampleSchema,
    raw: jsonValueSchema,
  }),
  z.object({
    kind: z.literal("term"),
    headword: canonicalTextSchema,
    partOfSpeech: canonicalTextSchema.optional(),
    raw: jsonValueSchema,
  }),
  z.object({
    kind: z.literal("cross-references"),
    references: z.array(canonicalCrossReferenceSchema),
    raw: jsonValueSchema,
  }),
  z.object({
    kind: z.literal("pronunciations"),
    items: z.array(canonicalPronunciationSchema),
    raw: jsonValueSchema,
  }),
]);

const canonicalBoxBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    value: canonicalTextSchema,
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("paragraph"),
    value: canonicalTextSchema,
    segments: z.array(canonicalBoxSegmentSchema).default([]),
    layout: z.literal("flow").optional(),
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("list"),
    items: z.array(
      z.object({
        segments: z.array(canonicalBoxSegmentSchema),
        raw: jsonObjectSchema,
      }),
    ),
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("pronunciations"),
    items: z.array(canonicalPronunciationSchema),
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("cross-references"),
    references: z.array(canonicalCrossReferenceSchema),
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("table"),
    rows: z.array(
      z.object({
        cells: z.array(
          z.object({
            header: z.boolean(),
            value: canonicalTextSchema,
            segments: z.array(canonicalBoxSegmentSchema).default([]),
            raw: jsonObjectSchema,
          }),
        ),
        raw: jsonObjectSchema,
      }),
    ),
    raw: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("unknown"),
    value: canonicalTextSchema,
    raw: jsonObjectSchema,
  }),
]);

const canonicalGrammarUsageBoxSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  resourceCategory: z.enum(CANONICAL_RESOURCE_CATEGORIES).optional(),
  title: canonicalTextSchema.optional(),
  references: z.array(canonicalCrossReferenceSchema).default([]),
  blocks: z.array(canonicalBoxBlockSchema).default([]),
  body: z.array(jsonValueSchema),
  raw: jsonObjectSchema,
});

const canonicalSenseSchema: z.ZodType<CanonicalSense> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    order: z.number().int().nonnegative(),
    partOfSpeech: z.string().optional(),
    groupHeading: canonicalTextSchema.optional(),
    patterns: z.array(canonicalTextSchema).default([]),
    variants: z.array(z.lazy(() => canonicalFormSchema)).default([]),
    inflectedForms: z.array(z.lazy(() => canonicalFormSchema)).default([]),
    pronunciations: z.array(canonicalPronunciationSchema).default([]),
    labels: z.array(canonicalLabelSchema),
    definition: canonicalTextSchema.optional(),
    definitionSegments: z.array(canonicalBoxSegmentSchema).default([]),
    translation: canonicalTextSchema.optional(),
    examples: z.array(canonicalExampleSchema),
    inlineUsage: z.array(canonicalTextSchema).default([]),
    usage: z.array(canonicalTextSchema),
    usageSegments: z.array(canonicalBoxSegmentSchema).default([]),
    crossReferences: z.array(canonicalCrossReferenceSchema),
    illustrations: z.array(canonicalIllustrationSchema),
    grammarUsageBoxes: z.array(canonicalGrammarUsageBoxSchema),
    subsenses: z.array(canonicalSenseSchema).default([]),
    raw: jsonObjectSchema,
  }),
);

const canonicalPhraseSchema: z.ZodType<CanonicalPhrase> = z.object({
  id: z.string().optional(),
  display: canonicalTextSchema,
  labels: z.array(canonicalLabelSchema).default([]),
  variants: z.array(z.lazy(() => canonicalFormSchema)).default([]),
  leadingUsage: z.array(canonicalTextSchema).default([]),
  senses: z.array(canonicalSenseSchema),
  trailingCrossReferences: z.array(canonicalCrossReferenceSchema).default([]),
  raw: jsonObjectSchema,
});

const canonicalFormPresentationItemSchema: z.ZodType<CanonicalFormPresentationItem> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("introducer"), value: canonicalTextSchema }),
    z.object({ kind: z.literal("label"), value: canonicalLabelSchema }),
    z.object({ kind: z.literal("pronunciation") }),
    z.object({ kind: z.literal("target") }),
  ]);

const canonicalFormSchema: z.ZodType<CanonicalForm> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    kind: z.string(),
    text: z.string(),
    partOfSpeech: z.string().optional(),
    note: canonicalTextSchema.optional(),
    introducer: canonicalTextSchema.optional(),
    relation: z.enum(CANONICAL_FORM_RELATIONS).optional(),
    labels: z.array(canonicalLabelSchema).default([]),
    presentation: z.array(canonicalFormPresentationItemSchema).default([]),
    variants: z.array(canonicalFormSchema).default([]),
    usage: z.array(canonicalTextSchema).default([]),
    inflectedForms: z.array(canonicalFormSchema).default([]),
    tokens: z.array(sourceTokenSchema),
    pronunciations: z.array(canonicalPronunciationSchema).default([]),
    senses: z.array(canonicalSenseSchema).default([]),
    raw: jsonValueSchema,
  }),
);

export const canonicalEntrySchema: z.ZodType<CanonicalEntry> = z.lazy(() =>
  z.object({
    schemaVersion: z.literal(CANONICAL_SCHEMA_VERSION),
    dictionaryId: z.string().min(1),
    sourceVersion: z.string(),
    id: z.string().min(1),
    headword: z.string(),
    displayHeadword: z.string(),
    searchKey: z.string(),
    labels: z.array(canonicalLabelSchema),
    pronunciations: z.array(canonicalPronunciationSchema),
    partsOfSpeech: z.array(
      z.object({
        text: z.string(),
        tokens: z.array(sourceTokenSchema),
        raw: jsonValueSchema,
      }),
    ),
    headwordPatterns: z.array(canonicalTextSchema).default([]),
    headwordUsage: z.array(canonicalTextSchema).default([]),
    senses: z.array(canonicalSenseSchema),
    subentries: z.array(canonicalEntrySchema),
    idioms: z.array(canonicalPhraseSchema).default([]),
    phrasalVerbs: z.array(canonicalPhraseSchema).default([]),
    derivedForms: z.array(canonicalFormSchema),
    inflectedForms: z.array(canonicalFormSchema),
    variants: z.array(canonicalFormSchema).default([]),
    crossReferences: z.array(canonicalCrossReferenceSchema),
    illustrations: z.array(canonicalIllustrationSchema),
    grammarUsageBoxes: z.array(canonicalGrammarUsageBoxSchema),
    raw: jsonObjectSchema,
  }),
);
