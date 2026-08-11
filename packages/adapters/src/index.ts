import { z } from "zod";

import {
  CANONICAL_SCHEMA_VERSION,
  canonicalEntrySchema,
  type CanonicalAudioReference,
  type CanonicalBoxBlock,
  type CanonicalBoxSegment,
  type CanonicalCrossReference,
  type CanonicalCrossReferenceKind,
  type CanonicalEntry,
  type CanonicalExample,
  type CanonicalForm,
  type CanonicalFormPresentationItem,
  type CanonicalFormRelation,
  type CanonicalGrammarUsageBox,
  type CanonicalIllustration,
  type CanonicalLabel,
  type CanonicalPartOfSpeech,
  type CanonicalPhrase,
  type CanonicalPronunciation,
  type CanonicalResourceCategory,
  type CanonicalSense,
  type CanonicalText,
  type CanonicalTextOrigin,
  type JsonObject,
  type JsonValue,
  type SourceToken,
} from "../../dictionary-schema/src/index";

export interface DictionaryAdapter<TSource> {
  readonly id: string;
  parse(input: unknown): CanonicalEntry;
  adapt(source: TSource): CanonicalEntry;
}

export class DictionaryAdapterRegistry {
  private readonly adapters = new Map<string, DictionaryAdapter<unknown>>();

  register<TSource>(adapter: DictionaryAdapter<TSource>): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`A dictionary adapter is already registered for "${adapter.id}".`);
    }

    this.adapters.set(adapter.id, adapter as DictionaryAdapter<unknown>);
    return this;
  }

  get(id: string): DictionaryAdapter<unknown> | undefined {
    return this.adapters.get(id);
  }

  convert(id: string, input: unknown): CanonicalEntry {
    const adapter = this.get(id);
    if (!adapter) {
      throw new Error(`No dictionary adapter is registered for "${id}".`);
    }

    return adapter.parse(input);
  }
}

const sourceBodySchema = z
  .object({
    top_data: z.unknown().optional(),
    sngs_data: z.unknown().optional(),
    unbox: z.unknown().optional(),
  })
  .passthrough();

const sourceBodyInputSchema = z.union([
  sourceBodySchema,
  z
    .string()
    .transform((value, context) => {
      try {
        return JSON.parse(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "body must contain valid JSON.",
        });
        return z.NEVER;
      }
    })
    .pipe(sourceBodySchema),
]);

export const bundledBilingualEnvelopeSchema = z
  .object({
    entryId: z.string().min(1),
    headword: z.string(),
    sourceVersion: z.string(),
    body: sourceBodyInputSchema,
  })
  .passthrough();

export type BundledBilingualEnvelope = z.infer<
  typeof bundledBilingualEnvelopeSchema
>;

export interface BundledBilingualAdapterOptions {
  dictionaryId?: string;
}

interface AdaptationContext {
  dictionaryId: string;
  sourceVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstNonEmptyArray(...values: unknown[]): unknown[] | undefined {
  return values.find((value): value is unknown[] => Array.isArray(value) && value.length > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(textOf).join("");
  }

  if (!isRecord(value)) {
    return "";
  }

  if ("value" in value) {
    return textOf(value.value);
  }

  return ["eng", "simp", "text", "word", "name", "def_eng", "def_simp"]
    .map((key) => textOf(value[key]))
    .join("");
}

function tokensOf(value: unknown): SourceToken[] {
  const values = Array.isArray(value) ? value : [value];

  return values.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    return [
      {
        tag: stringValue(item.tag),
        value: item.value as JsonValue | undefined,
        text: textOf(item.value),
        raw: asJsonObject(item),
      },
    ];
  });
}

function canonicalText(value: unknown): CanonicalText {
  return {
    text: textOf(value),
    tokens: tokensOf(value),
    raw: value as JsonValue,
  };
}

function canonicalTextWithOrigin(value: unknown, origin: CanonicalTextOrigin): CanonicalText {
  return { ...canonicalText(value), origin };
}

function joinedCanonicalText(values: unknown[], separator = " "): CanonicalText {
  const parts = values
    .map(canonicalText)
    .filter((part) => part.text.trim() || part.tokens.some((token) => token.text));
  const tokens = parts.flatMap((part, index) => [
    ...(index > 0
      ? [{ tag: "separator", value: separator, text: separator, raw: {} } satisfies SourceToken]
      : []),
    ...part.tokens,
  ]);
  return {
    text: parts.map((part) => part.text).join(separator),
    tokens,
    raw: values as JsonValue,
  };
}

function optionalText(value: unknown): CanonicalText | undefined {
  return value === undefined ? undefined : canonicalText(value);
}

function semanticListItemCanonicalText(value: unknown): CanonicalText {
  const projected = canonicalText(value);
  return { ...projected, text: semanticListItemText(projected.text) };
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeHeadword(value: string): string {
  return value.replace(/[\u00B7\u2027]/g, "").trim();
}

function searchKeyFor(value: string): string {
  return normalizeHeadword(value).toLocaleLowerCase();
}

function normalizePartOfSpeech(value: string): string {
  return semanticListItemText(value).replace(/\s+/g, " ").toLocaleLowerCase();
}

function isNestedEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.id === "string" && value.id.length > 0) ||
    isRecord(value.top_data)
  );
}

const semanticScopeBoundaries = new Set([
  "dr_gs",
  "idm_gs",
  "pv_gs",
  "sn_g",
  "unbox",
  "wfg",
  "x_gs",
]);

function collectScopeFields(value: unknown, key: string): unknown[] {
  const collected: unknown[] = [];

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    for (const [currentKey, child] of Object.entries(current)) {
      if (currentKey === key) {
        collected.push(child);
        continue;
      }

      if (
        currentKey === "sngs_data" &&
        Array.isArray(child)
      ) {
        child.forEach((item) => {
          if (!isNestedEntry(item)) {
            visit(item);
          }
        });
        continue;
      }

      if (semanticScopeBoundaries.has(currentKey)) {
        continue;
      }

      visit(child);
    }
  };

  visit(value);
  return collected;
}

function fieldItems(value: unknown, key: string): unknown[] {
  return collectScopeFields(value, key).flatMap((field) =>
    Array.isArray(field) ? field : [field],
  );
}

function metadataLabelsFrom(item: Record<string, unknown>): CanonicalLabel[] {
  const labels: CanonicalLabel[] = [];
  const source = textOf(item);

  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const code = match[1]?.trim();
    if (!code) {
      continue;
    }
    const label = metadataLabelFromCode(code);
    if (label) {
      labels.push({ ...label, raw: item as JsonValue });
    }
  }

  return labels;
}

function metadataLabelFromCode(
  code: string,
): Pick<CanonicalLabel, "text" | "kind"> | undefined {
  const frequency = /^Ox(3000|5000)\b/i.exec(code);
  if (frequency) {
    return { text: frequency[1]!, kind: "frequency" };
  }

  const level = /^CEFR_([A-C][12])(?:_|$)/i.exec(code);
  if (level) {
    return { text: level[1]!.toLocaleUpperCase(), kind: "level" };
  }

  const opal = /^OPAL_([OSW])$/i.exec(code);
  if (opal) {
    return { text: opal[1]!.toLocaleUpperCase(), kind: "academic-register" };
  }

  if (/^(?:CET\d+|NETM|TEM\d+|IELTS|TOEFL|GRE)$/i.test(code)) {
    return { text: code.toLocaleUpperCase(), kind: "exam" };
  }

  if (/^[A-C][12]$/i.test(code)) {
    return { text: code.toLocaleUpperCase(), kind: "level" };
  }

  return undefined;
}

function stripMetadataMarkers(value: string): string {
  return value
    .replace(/\[([^\]]+)\]/g, (marker, code: string) =>
      metadataLabelFromCode(code.trim()) ? "" : marker,
    )
    .trimEnd();
}

function canonicalPhraseDisplay(value: unknown): CanonicalText {
  const projected = canonicalText(value);
  return {
    ...projected,
    text: stripMetadataMarkers(projected.text),
    tokens: projected.tokens.map((token) => ({
      ...token,
      text: stripMetadataMarkers(token.text),
    })),
  };
}

function headingLabelsFrom(value: unknown): CanonicalLabel[] {
  return asArray(value)
    .filter(isRecord)
    .flatMap((item) => metadataLabelsFrom(item));
}

const semanticLabelTags = new Set(["geo", "gram", "or", "reg", "subj"]);

function leadingSemanticSeparator(value: string): CanonicalLabel["separatorBefore"] {
  const separator = /^\s*([,;])/.exec(value)?.[1];
  return separator === "," || separator === ";" ? separator : undefined;
}

function semanticListItemText(value: string): string {
  return value.replace(/^\s*[,;]\s*/, "").trim();
}

function cleanSemanticLabel(value: string): string {
  return semanticListItemText(value)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
}

function semanticLabelSeparatorFrom(value: string): CanonicalLabel["separatorBefore"] {
  return leadingSemanticSeparator(value);
}

function isSenseUsageToken(item: Record<string, unknown>): boolean {
  const tag = stringValue(item.tag)?.toLocaleLowerCase();
  const path = stringValue(item.path)?.toLocaleLowerCase() ?? "";
  return tag === "use" || tag === "use_end" || /(?:^|\/)use(?:\/|$)/.test(path);
}

function belongsToSourcePath(item: Record<string, unknown>, segment: string): boolean {
  const path = stringValue(item.path)?.toLocaleLowerCase();
  return path?.split("/").includes(segment.toLocaleLowerCase()) ?? false;
}

function semanticLabelsFrom(value: unknown): CanonicalLabel[] {
  return asArray(value)
    .filter(isRecord)
    .flatMap((item) => {
      const tag = stringValue(item.tag)?.toLocaleLowerCase();
      const metadata = metadataLabelsFrom(item);
      if (isSenseUsageToken(item)) {
        return metadata;
      }
      if (tag === "sn-g" || (tag === "topic" && metadata.length)) {
        return metadata;
      }
      if (!tag || !semanticLabelTags.has(tag)) {
        return metadata;
      }

      const text = cleanSemanticLabel(textOf(item));
      if (!text || /^[()[\],.;]+$/.test(text)) {
        return metadata;
      }

      return [...metadata, {
        text,
        kind: tag,
        separatorBefore: semanticLabelSeparatorFrom(textOf(item)),
        raw: item as JsonValue,
      }];
    });
}

function patternsFrom(
  value: unknown,
  options: { includeParenthesizedVariants?: boolean } = {},
): CanonicalText[] {
  const patterns: CanonicalText[] = [];
  let current: Record<string, unknown>[] = [];
  let parenthesizedVariant: Record<string, unknown>[] | undefined;
  let parenthesizedVariantDepth = 0;

  const flush = (): void => {
    if (!current.length) {
      return;
    }
    const pattern = canonicalText(current);
    if (pattern.text.trim()) {
      patterns.push(pattern);
    }
    current = [];
  };

  for (const item of asArray(value).filter(isRecord)) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    const marker = textOf(item);
    if (parenthesizedVariant) {
      parenthesizedVariant.push(item);
      if (tag === "v-gs" && marker.includes("(")) {
        parenthesizedVariantDepth += 1;
      }
      if (tag === "v-gs" && marker.includes(")")) {
        parenthesizedVariantDepth = Math.max(0, parenthesizedVariantDepth - 1);
      }
      if (parenthesizedVariantDepth === 0) {
        if (options.includeParenthesizedVariants !== false) {
          patterns.push(canonicalText(parenthesizedVariant));
        }
        parenthesizedVariant = undefined;
      }
      continue;
    }
    if (tag === "v-gs" && marker.includes("(")) {
      flush();
      parenthesizedVariant = [item];
      parenthesizedVariantDepth = marker.includes(")") ? 0 : 1;
      if (parenthesizedVariantDepth === 0) {
        if (options.includeParenthesizedVariants !== false) {
          patterns.push(canonicalText(parenthesizedVariant));
        }
        parenthesizedVariant = undefined;
      }
      continue;
    }
    if (tag === "cf" || tag === "v") {
      current.push(item);
    } else if (tag === "v-g" && marker.trim() === "," && current.length) {
      current.push(item);
      flush();
    } else {
      flush();
    }
  }
  if (parenthesizedVariant && options.includeParenthesizedVariants !== false) {
    patterns.push(canonicalText(parenthesizedVariant));
  }
  flush();
  return patterns;
}

function inlineUsageFrom(value: unknown): CanonicalText[] {
  const usage: CanonicalText[] = [];
  let current: Record<string, unknown>[] = [];
  let currentOrigin: CanonicalTextOrigin | undefined;

  const flush = (): void => {
    if (current.length) {
      const projected = canonicalTextWithOrigin(current, currentOrigin!);
      if (projected.text.replace(/[()\s]/g, "")) {
        usage.push(projected);
      }
    }
    current = [];
    currentOrigin = undefined;
  };

  for (const item of asArray(value).filter(isRecord)) {
    const origin = isSenseUsageToken(item)
      ? "use"
      : belongsToSourcePath(item, "dis-g")
        ? "dis-g"
        : undefined;
    if (!origin) {
      flush();
      continue;
    }
    if (currentOrigin && currentOrigin !== origin) {
      flush();
    }
    currentOrigin = origin;
    current.push(item);
  }
  flush();
  return usage;
}

function dedupeLabels(labels: CanonicalLabel[]): CanonicalLabel[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = `${label.kind ?? ""}\u0000${label.text.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function subentryMetadataLabelsFrom(body: JsonObject): CanonicalLabel[] {
  const senseGroup = isRecord(body.sngs_data) ? body.sngs_data : undefined;
  return [
    ...asArray(body.subentry_cefr),
    ...asArray(senseGroup?.subentry_cefr),
  ]
    .filter(isRecord)
    .flatMap(metadataLabelsFrom);
}

function pronunciationsFrom(value: unknown): CanonicalPronunciation[] {
  return fieldItems(value, "prongs")
    .filter(isRecord)
    .map((item) => ({
      transcription: stringValue(item.phon),
      region: stringValue(item.geo),
      audioKey: stringValue(item.audio),
      form: stringValue(item.form),
      raw: asJsonObject(item),
    }));
}

function partsOfSpeechFrom(value: unknown): CanonicalPartOfSpeech[] {
  const seen = new Set<string>();
  return fieldItems(value, "pos").flatMap((item) => {
    const projected = semanticListItemCanonicalText(item);
    const key = normalizePartOfSpeech(projected.text);
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ text: projected.text, tokens: projected.tokens, raw: projected.raw }];
  });
}

function unambiguousPartOfSpeechFrom(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const topData = isRecord(value.top_data) ? value.top_data : undefined;
  const values = [
    ...asArray(value.pos),
    ...asArray(topData?.pos),
  ]
    .map((item) => normalizePartOfSpeech(textOf(item)))
    .filter(Boolean);
  const distinctValues = [...new Set(values)];

  return distinctValues.length === 1 ? distinctValues[0] : undefined;
}

function audioFrom(value: unknown): CanonicalAudioReference[] {
  return asArray(value).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const metadata = isRecord(item.value) ? item.value : item;
    const key = stringValue(metadata.url) || stringValue(metadata.audio);
    if (!key) {
      return [];
    }

    return [
      {
        key,
        region: stringValue(metadata.geo),
        raw: asJsonObject(item),
      },
    ];
  });
}

function canonicalExampleFromContent(
  id: string | undefined,
  sourceText: unknown[],
  sourceTranslation: unknown,
  sourceAudio: unknown,
  raw: JsonObject,
): CanonicalExample {
  let patternLength = 0;
  while (patternLength < sourceText.length) {
    const token = sourceText[patternLength];
    if (!isRecord(token) || stringValue(token.tag)?.toLocaleLowerCase() !== "cf") {
      break;
    }
    patternLength += 1;
  }

  const patternSource = sourceText.slice(0, patternLength);
  const sentenceSource = sourceText.slice(patternLength);
  const pattern = patternSource.length ? canonicalText(patternSource) : undefined;

  return {
    id,
    pattern,
    text: canonicalText(sentenceSource.length ? sentenceSource : sourceText),
    translation: optionalText(sourceTranslation),
    audio: audioFrom(sourceAudio),
    raw,
  };
}

function canonicalExampleFrom(item: Record<string, unknown>): CanonicalExample {
  return canonicalExampleFromContent(
    stringValue(item.id),
    asArray(item.x_eng),
    item.x_simp,
    item.xaudio,
    asJsonObject(item),
  );
}

function examplesFrom(value: unknown): CanonicalExample[] {
  return asArray(value).filter(isRecord).map(canonicalExampleFrom);
}

export const BUNDLED_BILINGUAL_CROSS_REFERENCE_LABELS = [
  "[SYN]",
  "-> see also",
  "-> compare",
  "=",
  "[OPP]",
  "-> WORDFINDER NOTE at",
  "-> more at",
  "-> SYNONYMS at",
  "[IDM] see",
  "-> note at",
  "-> related noun",
  "-> LANGUAGE BANK at",
  "->  WORD FAMILY at",
  "-> HOMOPHONES at",
  "past tense, past participle of",
  "->",
  "past tense of",
  "pl. of",
  "past part. of",
  "-> EXPRESS YOURSELF at",
  "third person of",
  ",",
  "pres. part. of",
  "(comparative of",
  "singular of",
] as const;

function normalizedCrossReferenceLabel(value: string): string {
  return value
    .trim()
    .replace(/^(?:->|\u2192)\s*/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

const crossReferenceKindByNormalizedLabel = new Map<
  string,
  CanonicalCrossReferenceKind
>([
  ["[syn]", "synonym"],
  ["see also", "see-also"],
  ["compare", "compare"],
  ["=", "equivalent"],
  ["[opp]", "antonym"],
  ["wordfinder note at", "topic-note"],
  ["more at", "more-at"],
  ["synonyms at", "topic-note"],
  ["[idm] see", "related"],
  ["note at", "note-at"],
  ["related noun", "related"],
  ["language bank at", "topic-note"],
  ["word family at", "topic-note"],
  ["homophones at", "topic-note"],
  ["past tense, past participle of", "inflection"],
  ["", "generic"],
  ["past tense of", "inflection"],
  ["pl. of", "inflection"],
  ["past part. of", "inflection"],
  ["express yourself at", "topic-note"],
  ["third person of", "inflection"],
  [",", "punctuation"],
  ["pres. part. of", "inflection"],
  ["(comparative of", "inflection"],
  ["singular of", "inflection"],
]);

export function classifyBundledBilingualCrossReference(
  label: string | undefined,
): CanonicalCrossReferenceKind {
  if (label === undefined) {
    return "generic";
  }

  return crossReferenceKindByNormalizedLabel.get(
    normalizedCrossReferenceLabel(label),
  ) ?? "generic";
}

function cleanCrossReferenceLabel(value: unknown): string | undefined {
  const label = textOf(value)
    .trim()
    .replace(/^(?:->|\u2192)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  return label || undefined;
}

function cleanCrossReferenceQualifier(value: unknown): string | undefined {
  const qualifier = textOf(value)
    .replace(/\$\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return qualifier || undefined;
}

function resolveCrossReferenceSeparators(
  references: CanonicalCrossReference[],
): CanonicalCrossReference[] {
  let previous: CanonicalCrossReference | undefined;
  return references.map((reference) => {
    if (
      reference.kind === "punctuation" &&
      reference.label?.trim() === "," &&
      previous
    ) {
      const resolved = {
        ...reference,
        kind: previous.kind,
        label: previous.label,
      };
      previous = resolved;
      return resolved;
    }
    previous = reference;
    return reference;
  });
}

const crossReferenceScopeBoundaries = new Set([
  "idm_gs",
  "pv_gs",
  "sn_g",
  "unbox",
  "wfg",
  "x_gs",
]);

function crossReferenceGroupsFrom(value: unknown): unknown[] {
  const groups: unknown[] = [];

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) {
      return;
    }

    for (const [key, child] of Object.entries(current)) {
      if (
        key === "xrgs" ||
        (key.startsWith("xrgs_") && key !== "xrgs_text")
      ) {
        groups.push(child);
        continue;
      }
      if (key === "sngs_data" && Array.isArray(child)) {
        child.forEach((item) => {
          if (!isNestedEntry(item)) {
            visit(item);
          }
        });
        continue;
      }
      if (crossReferenceScopeBoundaries.has(key)) {
        continue;
      }
      visit(child);
    }
  };

  visit(value);
  return groups.flatMap((group) => Array.isArray(group) ? group : [group]);
}

function crossReferencesFrom(value: unknown): CanonicalCrossReference[] {
  if (value === undefined) {
    return [];
  }

  const references: CanonicalCrossReference[] = crossReferenceGroupsFrom(value).flatMap((item) => {
    if (!isRecord(item)) {
      const text = textOf(item).trim();
      return text ? [{ text, raw: item as JsonValue }] : [];
    }

    const sourceLabel = stringValue(item.xrgs_text);
    const label = cleanCrossReferenceLabel(item.xrgs_text);
    const kind = classifyBundledBilingualCrossReference(sourceLabel);
    const targets = asArray(item.xrg).filter(isRecord);
    if (!targets.length) {
      const text = textOf(item).trim();
      return text
        ? [{ kind, label, text, raw: asJsonObject(item) }]
        : [];
    }

    return targets.flatMap((target) => {
      const text = firstNonEmptyText(
        target.xh,
        target.xw,
        target.word,
        target.text,
        target.value,
      );
      if (!text) {
        return [];
      }
      const qualifier = [target.xpos, target.xhm, target.xs]
        .map(cleanCrossReferenceQualifier)
        .filter((candidate): candidate is string => Boolean(candidate))
        .join(" ");
      const targetId = stringValue(target.target_id) || undefined;

      return [{
        id: stringValue(target.id) || targetId || undefined,
        kind,
        label,
        text,
        qualifier: qualifier || undefined,
        entryId:
          stringValue(target.word_id) ||
          stringValue(target.entry_id) ||
          targetId ||
          undefined,
        targetId,
        targetType: stringValue(target.target_type),
        raw: asJsonObject(item),
      }];
    });
  });
  return resolveCrossReferenceSeparators(references);
}

function illustrationsFrom(value: unknown): CanonicalIllustration[] {
  return fieldItems(value, "ill").map((item) => {
    const record = isRecord(item) ? item : undefined;
    const candidate = record
      ? stringValue(record.url) || stringValue(record.key) || textOf(record.value)
      : textOf(item);
    const caption = record
      ? firstNonEmptyText(
          record.caption,
          record.title,
          record.label,
          record.alt,
          record.text,
        )
      : "";

    return {
      key: candidate || undefined,
      text: caption && caption !== candidate ? caption : undefined,
      raw: item as JsonValue,
    };
  });
}

function flattenedBoxContentFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenedBoxContentFrom);
  }

  if (!isRecord(value)) {
    return [value];
  }

  if (stringValue(value.tag)) {
    if (
      stringValue(value.tag)?.toLocaleLowerCase() === "trans-g" &&
      isRecord(value.value)
    ) {
      return flattenedBoxContentFrom(value.value);
    }
    return [value];
  }

  return Object.values(value).flatMap(flattenedBoxContentFrom);
}

function boxContentTextFrom(value: unknown): CanonicalText {
  const textItems = flattenedBoxContentFrom(value).filter((item) => {
    const tag = isRecord(item) ? stringValue(item.tag)?.toLocaleLowerCase() : undefined;
    return tag !== "x-g" && tag !== "xr-gs" && tag !== "audio" && tag !== "xaudio";
  });
  return canonicalText(textItems);
}

const flatExampleBoundaryTags = new Set(["x-g", "x-g_end", "x-gs", "x-gs_end"]);
const flatPronunciationTags = new Set(["pron-g", "pron-gs", "phon", "audio", "form"]);
const flatExampleNonTextTags = new Set([
  ...flatExampleBoundaryTags,
  "x",
  "xaudio",
  "simp",
]);

function flatExampleFrom(
  marker: Record<string, unknown>,
  content: unknown[],
  raw: unknown[],
): CanonicalExample {
  const english = content.filter((item) => {
    const tag = isRecord(item) ? stringValue(item.tag)?.toLocaleLowerCase() : undefined;
    return !tag || !flatExampleNonTextTags.has(tag);
  });
  const translation = content.filter((item) =>
    isRecord(item) && stringValue(item.tag)?.toLocaleLowerCase() === "simp",
  );
  const audio = content.filter((item) =>
    isRecord(item) && stringValue(item.tag)?.toLocaleLowerCase() === "xaudio",
  );

  return canonicalExampleFromContent(
    stringValue(marker.id),
    english,
    translation,
    audio,
    { "x-g": raw as JsonValue },
  );
}

type BoxSegmentContext = "flow" | "list-item" | "table-cell";

const boxTermPrefixTags = new Set(["label-g", "geo", "reg", "gram-g", "gram"]);

function boxTextTermFrom(items: unknown[], context: BoxSegmentContext): CanonicalText | undefined {
  if (context === "flow") {
    return undefined;
  }

  const sourceTokens = items.filter(isRecord);
  const boundary = sourceTokens.findIndex((item) => {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    return tag === "custom-br" || tag === "simp" || tag === "trad" || tag === "zh" || tag === "zho";
  });
  const prefix = boundary >= 0 ? sourceTokens.slice(0, boundary) : sourceTokens;
  const visible = prefix.filter((item) => textOf(item).trim());
  if (!visible.length) {
    return undefined;
  }

  const fullPrefix = canonicalText(prefix);
  if (/\[(?:diomond|diamond)\]/iu.test(fullPrefix.text)) {
    const term = fullPrefix.text.replace(/\[(?:diomond|diamond)\]/giu, "").replace(/\s+/gu, " ").trim();
    return term ? { text: term, tokens: [], raw: prefix as JsonValue } : undefined;
  }

  let firstSemantic = 0;
  while (firstSemantic < visible.length) {
    const tag = stringValue(visible[firstSemantic]!.tag)?.toLocaleLowerCase();
    if (!tag || !boxTermPrefixTags.has(tag)) {
      break;
    }
    firstSemantic += 1;
  }
  const lead = visible[firstSemantic];
  if (!lead) {
    return undefined;
  }
  const tag = stringValue(lead.tag)?.toLocaleLowerCase();
  const marked = tag === "eb" || (tag === "eng" && (lead.bold === true || lead.bold === 1 || lead.bold === "1"));
  if (!marked) {
    return undefined;
  }
  const term = textOf(lead).replace(/\s+/gu, " ").trim();
  return term ? { text: term, tokens: [], raw: lead as JsonValue } : undefined;
}

function boxSegmentsFrom(value: unknown, context: BoxSegmentContext = "flow"): CanonicalBoxSegment[] {
  const segments: CanonicalBoxSegment[] = [];
  let buffered: unknown[] = [];

  const hasVisibleBufferedText = (): boolean =>
    buffered.some((item) =>
      canonicalText(item).text.replace(/\[(?:diomond|diamond)\]/gi, "").trim(),
    );

  const flushText = (): void => {
    if (!buffered.length) {
      return;
    }
    const text = canonicalText(buffered);
    if (text.text.replace(/\[(?:diomond|diamond)\]/gi, "").trim()) {
      const term = boxTextTermFrom(buffered, context);
      segments.push({
        kind: "text",
        value: text,
        ...(term ? { term } : {}),
        raw: buffered as JsonValue,
      });
    }
    buffered = [];
  };

  const items = flattenedBoxContentFrom(value);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const tag = isRecord(item) ? stringValue(item.tag)?.toLocaleLowerCase() : undefined;
    const next = items[index + 1];
    const nextTag = isRecord(next) ? stringValue(next.tag)?.toLocaleLowerCase() : undefined;

    if (isRecord(item) && tag === "pron-g") {
      flushText();
      let endIndex = index + 1;
      while (endIndex < items.length) {
        const candidate = items[endIndex];
        const candidateTag = isRecord(candidate)
          ? stringValue(candidate.tag)?.toLocaleLowerCase()
          : undefined;
        if (!candidateTag || !flatPronunciationTags.has(candidateTag)) {
          break;
        }
        endIndex += 1;
      }
      const raw = items.slice(index, endIndex).filter(isRecord);
      const pronunciations = flattenedPronunciationsFrom(raw);
      if (pronunciations.length) {
        segments.push({ kind: "pronunciations", items: pronunciations, raw: raw as JsonValue });
      }
      index = endIndex - 1;
      continue;
    }

    if (
      isRecord(item) &&
      tag === "eb" &&
      !hasVisibleBufferedText() &&
      (nextTag === "pos" || nextTag === "xr-gs" || nextTag === "x-g")
    ) {
      flushText();
      const partOfSpeech = nextTag === "pos" && isRecord(next)
        ? semanticListItemCanonicalText(next)
        : undefined;
      segments.push({
        kind: "term",
        headword: canonicalText(item),
        partOfSpeech,
        raw: (partOfSpeech ? [item, next] : [item]) as JsonValue,
      });
      if (partOfSpeech) {
        index += 1;
      }
      continue;
    }

    if (
      isRecord(item) &&
      tag === "x-g" &&
      isRecord(item.value)
    ) {
      flushText();
      const example = canonicalExampleFrom(item.value);
      if (
        example.text.text.trim() ||
        example.pattern?.text.trim() ||
        example.translation?.text.trim() ||
        example.audio.length
      ) {
        segments.push({
          kind: "example",
          value: example,
          raw: item as JsonValue,
        });
      }
      continue;
    }

    if (isRecord(item) && tag === "x-g") {
      const endIndex = items.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          isRecord(candidate) &&
          stringValue(candidate.tag)?.toLocaleLowerCase() === "x-g_end",
      );
      if (endIndex >= 0) {
        const source = items.slice(index, endIndex + 1);
        const example = flatExampleFrom(item, source.slice(1, -1), source);
        if (
          example.text.text.trim() ||
          example.pattern?.text.trim() ||
          example.translation?.text.trim() ||
          example.audio.length
        ) {
          flushText();
          segments.push({
            kind: "example",
            value: example,
            raw: source as JsonValue,
          });
          index = endIndex;
          continue;
        }
      }
    }

    if (tag && flatExampleBoundaryTags.has(tag)) {
      continue;
    }

    if (isRecord(item) && tag === "xr-gs" && isRecord(item.value)) {
      flushText();
      const references = crossReferencesFrom({ xrgs: item.value });
      if (references.length) {
        segments.push({
          kind: "cross-references",
          references,
          raw: item as JsonValue,
        });
      } else {
        buffered.push(item);
      }
      continue;
    }

    buffered.push(item);
  }
  flushText();

  return segments;
}

function boxPronunciationsFrom(value: unknown): CanonicalPronunciation[] {
  return fieldItems(value, "pron-g")
    .filter(isRecord)
    .map((item) => ({
      transcription: stringValue(item.phon),
      region: stringValue(item.geo),
      audioKey: stringValue(item.audio),
      form: stringValue(item.form),
      raw: asJsonObject(item),
    }))
    .filter((item) => item.transcription || item.region || item.audioKey || item.form);
}

function structuredBoxHeadingBlocksFrom(
  content: unknown,
  level: 1 | 2 | 3,
  raw: JsonObject,
): CanonicalBoxBlock[] | undefined {
  const items = asArray(content).filter(isRecord);
  if (!items.some((item) => item.ul !== undefined || item.ol !== undefined || item["pron-gs"] !== undefined)) {
    return undefined;
  }

  const headingItems = items.flatMap((item) => {
    const list = firstNonEmptyArray(item.ul, item.ol);
    if (list !== undefined) {
      return asArray(list)
        .filter(isRecord)
        .map((listItem) => listItem.li ?? listItem);
    }
    return item["pron-gs"] === undefined ? [item] : [];
  });
  const heading = joinedCanonicalText(headingItems);
  const pronunciations = boxPronunciationsFrom(content);
  const blocks: CanonicalBoxBlock[] = [];
  if (heading.text.replace(/\[(?:diomond|diamond)\]/gi, "").trim()) {
    blocks.push({ kind: "heading", level, value: heading, raw });
  }
  if (pronunciations.length) {
    blocks.push({ kind: "pronunciations", items: pronunciations, raw });
  }
  return blocks;
}

function boxTableBlockFrom(content: unknown, raw: JsonObject): CanonicalBoxBlock | undefined {
  const rows = asArray(content)
    .filter(isRecord)
    .map((row) => ({
      cells: asArray(row.tr).filter(isRecord).flatMap((cell) => {
        if (cell.th !== undefined) {
          return [{
            header: true,
            value: boxContentTextFrom(cell.th),
            segments: boxSegmentsFrom(cell.th, "table-cell"),
            raw: asJsonObject(cell),
          }];
        }
        if (cell.td !== undefined) {
          return [{
            header: false,
            value: boxContentTextFrom(cell.td),
            segments: boxSegmentsFrom(cell.td, "table-cell"),
            raw: asJsonObject(cell),
          }];
        }
        return [];
      }),
      raw: asJsonObject(row),
    }))
    .filter((row) => row.cells.length);
  return rows.length ? { kind: "table", rows, raw } : undefined;
}

function boxBlocksFrom(value: unknown): CanonicalBoxBlock[] {
  return asArray(value).filter(isRecord).flatMap((block): CanonicalBoxBlock[] => {
    const field = Object.entries(block)[0];
    if (!field) {
      return [];
    }
    const [kind, content] = field;
    const normalizedKind = kind.toLocaleLowerCase();
    const heading = /^h([1-3])$/i.exec(kind);
    if (heading) {
      const level = Number(heading[1]) as 1 | 2 | 3;
      const structured = structuredBoxHeadingBlocksFrom(content, level, asJsonObject(block));
      if (structured) {
        return structured;
      }
      return [{
        kind: "heading" as const,
        level,
        value: canonicalText(content),
        raw: asJsonObject(block),
      }];
    }
    if (normalizedKind === "p") {
      return [{
        kind: "paragraph" as const,
        value: boxContentTextFrom(content),
        segments: boxSegmentsFrom(content),
        raw: asJsonObject(block),
      }];
    }
    if (["ul", "ol"].includes(normalizedKind)) {
      const items = asArray(content)
        .filter(isRecord)
        .map((item) => ({
          segments: boxSegmentsFrom(item.li ?? item, "list-item"),
          raw: asJsonObject(item),
        }))
        .filter((item) => item.segments.length > 0);
      if (!items.length) {
        return [];
      }
      return [{
        kind: "list" as const,
        items,
        raw: asJsonObject(block),
      }];
    }
    if (normalizedKind === "xr-gs" || normalizedKind === "xrgs") {
      const references = crossReferencesFrom({ xrgs: content });
      return references.length
        ? [{ kind: "cross-references", references, raw: asJsonObject(block) }]
        : [];
    }
    if (normalizedKind === "table") {
      const table = boxTableBlockFrom(content, asJsonObject(block));
      return table ? [table] : [];
    }

    return [{
      kind: "unknown" as const,
      value: canonicalText(content),
      raw: asJsonObject(block),
    }];
  });
}

const resourceCategoryBySourceType = new Map<string, CanonicalResourceCategory>([
  ["GRAMMAR POINT", "grammar"],
  ["EXPRESS YOURSELF", "express-yourself"],
  ["VOCABULARY BUILDING", "vocabulary-building"],
  ["SYNONYMS", "synonyms"],
  ["WHICH WORD?", "which-word"],
  ["LANGUAGE BANK", "language-bank"],
  ["COLLOCATIONS", "collocations"],
  ["HOMOPHONES", "homophones"],
  ["BRITISH/AMERICAN", "british-american"],
  ["BRITISH AND AMERICAN ENGLISH", "british-american"],
  ["MORE ABOUT", "more-about"],
  ["WORDFINDER", "wordfinder"],
  ["HELP", "help"],
  ["ORIGIN", "origin"],
  ["NOTE", "note"],
]);

function resourceCategoryFrom(type: string | undefined): CanonicalResourceCategory {
  const normalized = type?.trim().replace(/\s+/gu, " ").toLocaleUpperCase();
  if (!normalized) return "other";
  for (const [sourceType, category] of resourceCategoryBySourceType) {
    if (normalized === sourceType || normalized.startsWith(`${sourceType} `)) {
      return category;
    }
  }
  return "other";
}

function grammarUsageBoxesFrom(value: unknown): CanonicalGrammarUsageBox[] {
  return fieldItems(value, "unbox")
    .filter(isRecord)
    .map((item) => {
      const tile = isRecord(item.tile) ? item.tile : undefined;
      const titleParts = tile
        ? [tile.eng, tile.simp].filter((part) => {
            if (part === undefined || textOf(part).trim() === "") {
              return false;
            }
            return !asArray(part).some(
              (candidate) =>
                isRecord(candidate) &&
                (candidate.target_id !== undefined ||
                  candidate.word_id !== undefined ||
                  candidate.entry_id !== undefined),
            );
          })
        : [];
      const title = titleParts.length ? canonicalText(titleParts) : undefined;
      const references: CanonicalCrossReference[] = tile
        ? asArray(tile.eng).filter(isRecord).flatMap((reference) => {
            const text = firstNonEmptyText(
              reference.text,
              reference.xh,
              reference.xw,
              reference.word,
              reference.value,
            );
            if (!text) {
              return [];
            }
            const targetId = stringValue(reference.target_id) || undefined;
            return [{
              id: stringValue(reference.id) || targetId || undefined,
              kind: "related" as const,
              text,
              entryId:
                stringValue(reference.word_id) ||
                stringValue(reference.entry_id) ||
                targetId ||
                undefined,
              targetId,
              targetType: stringValue(reference.target_type),
              raw: asJsonObject(reference),
            }];
          })
        : [];
      const type = tile ? stringValue(tile.type) : undefined;
      return {
        id: stringValue(item.id),
        type,
        resourceCategory: resourceCategoryFrom(type),
        title,
        references,
        blocks: boxBlocksFrom(item.body),
        body: asArray(item.body) as JsonValue[],
        raw: asJsonObject(item),
      };
    });
}

const topUsageBoxTypes = new Map([
  ["[HELP]", "HELP 语法说明"],
  ["[ORIGIN]", "ORIGIN 词源说明"],
]);

function topUsageBoxesFrom(topData: Record<string, unknown>): CanonicalGrammarUsageBox[] {
  const rawItems = asArray(topData.top_un);
  if (!rawItems.length) {
    return [];
  }
  const marker = isRecord(rawItems[0]) ? textOf(rawItems[0]).trim() : "";
  const content = topUsageBoxTypes.has(marker) ? rawItems.slice(1) : rawItems;
  const segments = boxSegmentsFrom(content);
  if (!segments.length) {
    return [];
  }
  const raw = { top_un: rawItems as JsonValue } satisfies JsonObject;
  return [{
    type: topUsageBoxTypes.get(marker) ?? "NOTE 词典说明",
    resourceCategory: marker === "[HELP]" ? "help" : marker === "[ORIGIN]" ? "origin" : "note",
    blocks: [{
      kind: "paragraph",
      value: boxContentTextFrom(content),
      segments,
      layout: "flow",
      raw,
    }],
    body: rawItems as JsonValue[],
    raw,
  }];
}

function wordFamilyFormsFrom(value: unknown): CanonicalForm[] {
  return fieldItems(value, "wfg").flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const text = textOf(item.wfw).trim();
    if (!text) {
      return [];
    }
    const note = optionalText(item.wfo);
    return [{
      id: stringValue(item.id) || undefined,
      kind: "word-family",
      text,
      partOfSpeech: semanticListItemText(textOf(item.wfp)) || undefined,
      note: note?.text.trim() ? note : undefined,
      labels: [],
      tokens: tokensOf(item.wfw),
      pronunciations: [],
      senses: [],
      raw: item as JsonValue,
    }];
  });
}

function derivativeFormsFrom(value: unknown): CanonicalForm[] {
  return fieldItems(value, "dr_gs").flatMap((item) => {
    if (!isRecord(item)) {
      const text = textOf(item).trim();
      return text
        ? [{ kind: "derivative", text, tokens: tokensOf(item), raw: item as JsonValue }]
        : [];
    }

    const topData = isRecord(item.top_g)
      ? item.top_g
      : isRecord(item.top_data)
        ? item.top_data
        : undefined;
    const heading = topData ? asArray(topData.h) : [];
    const text = textOf(heading.length ? heading : item).trim();
    if (!text) {
      return [];
    }
    const partOfSpeech = topData
      ? partsOfSpeechFrom(topData).map((part) => part.text.trim()).find(Boolean)
      : undefined;
    return [{
      id: stringValue(item.id),
      kind: "derivative",
      text,
      partOfSpeech,
      labels: topData ? labelsOutsideVariantGroupsFrom(topData.top_text) : [],
      variants: topData ? variantsFrom(topData) : [],
      usage: topData ? inlineUsageFrom(topData.top_text) : [],
      inflectedForms: topData ? inflectedFormsFrom(asJsonObject(item), topData) : [],
      tokens: tokensOf(heading.length ? heading : item),
      pronunciations: topData ? pronunciationsFrom(topData) : [],
      senses: sensesFrom(item, partOfSpeech),
      raw: item as JsonValue,
    }];
  });
}

function derivedFormsFrom(value: unknown): CanonicalForm[] {
  return [...wordFamilyFormsFrom(value), ...derivativeFormsFrom(value)];
}

function flattenedPronunciationsFrom(
  items: Record<string, unknown>[],
): CanonicalPronunciation[] {
  const pronunciations: CanonicalPronunciation[] = [];
  let current: CanonicalPronunciation | undefined;

  for (const item of items) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    if (tag === "pron-g") {
      current = {
        region: textOf(item).trim() || undefined,
        raw: asJsonObject(item),
      };
      pronunciations.push(current);
      continue;
    }
    if (!["phon", "audio", "form"].includes(tag ?? "")) {
      continue;
    }
    if (!current) {
      current = { raw: asJsonObject(item) };
      pronunciations.push(current);
    }
    if (tag === "phon") {
      current.transcription = textOf(item).trim() || undefined;
    } else if (tag === "audio") {
      current.audioKey = textOf(item).trim() || undefined;
    } else {
      current.form = textOf(item).trim() || undefined;
    }
  }

  return pronunciations.filter(
    (pronunciation) =>
      pronunciation.region ||
      pronunciation.transcription ||
      pronunciation.audioKey ||
      pronunciation.form,
  );
}

function sensePronunciationsFrom(value: unknown): CanonicalPronunciation[] {
  const directItems = asArray(value).filter(isRecord).filter((item) => {
    const path = stringValue(item.path)?.toLocaleLowerCase() ?? "";
    return !["v-gs", "if-gs", "x-gs", "use"].some((scope) =>
      path.split("/").includes(scope)
    );
  });
  return flattenedPronunciationsFrom(directItems);
}

function inflectionIntroducerFrom(
  items: Record<string, unknown>[],
): CanonicalText | undefined {
  const introducer = canonicalText(items);
  const text = semanticListItemText(introducer.text);
  return text ? { ...introducer, text } : undefined;
}

function flattenedInflectedFormsFrom(value: unknown): CanonicalForm[] {
  const forms: CanonicalForm[] = [];
  let current:
    | {
        textItems: Record<string, unknown>[];
        raw: Record<string, unknown>[];
        introducer?: CanonicalText;
      }
    | undefined;
  let pendingIntroducer: Record<string, unknown>[] = [];
  let pendingRaw: Record<string, unknown>[] = [];
  let groupDepth = 0;

  const flush = (): void => {
    const text = current?.textItems.map(textOf).join("").trim() ?? "";
    if (!current || !text) {
      current = undefined;
      return;
    }
    forms.push({
      kind: "inflection",
      text,
      introducer: current.introducer,
      tokens: tokensOf(current.raw),
      pronunciations: flattenedPronunciationsFrom(current.raw),
      raw: current.raw as JsonValue,
    });
    current = undefined;
  };

  const flushConstraint = (): void => {
    const constraint = inflectionIntroducerFrom(pendingIntroducer);
    if (constraint) {
      forms.push({
        kind: "inflection-constraint",
        text: constraint.text,
        tokens: constraint.tokens,
        raw: pendingRaw as JsonValue,
      });
    }
    pendingIntroducer = [];
    pendingRaw = [];
  };

  for (const item of asArray(value).filter(isRecord)) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    const path = stringValue(item.path)?.toLocaleLowerCase() ?? "";
    if (tag === "if-gs") {
      const marker = textOf(item);
      const opens = marker.match(/\(/g)?.length ?? 0;
      const closes = marker.match(/\)/g)?.length ?? 0;
      if (opens && groupDepth === 0) {
        flush();
        flushConstraint();
      }
      groupDepth += opens;
      if (current) {
        current.raw.push(item);
      } else {
        pendingRaw.push(item);
      }
      groupDepth = Math.max(0, groupDepth - closes);
      if (closes && groupDepth === 0) {
        flush();
        flushConstraint();
      }
      continue;
    }
    if (tag !== "if" && !path.includes("/if-gs")) {
      continue;
    }
    if (tag === "if") {
      if (current) {
        current.textItems.push(item);
        current.raw.push(item);
      } else {
        current = {
          textItems: [item],
          raw: [...pendingRaw, item],
          introducer: inflectionIntroducerFrom(pendingIntroducer),
        };
        pendingIntroducer = [];
        pendingRaw = [];
      }
      continue;
    }
    if (tag === "if-g") {
      const text = textOf(item).trim();
      if (current) {
        flush();
      }
      pendingRaw.push(item);
      if (text && !/^[,;/().\s]+$/.test(text)) {
        pendingIntroducer.push(item);
      }
      continue;
    }
    if (!current) {
      if (groupDepth > 0) {
        pendingRaw.push(item);
      }
      continue;
    }
    current.raw.push(item);
    if (tag === "ptl") {
      current.textItems.push(item);
    }
  }
  flush();
  flushConstraint();
  return forms;
}

function variantTokenGroupsFrom(
  value: unknown,
  options: { allowUnwrapped?: boolean; requireUnwrappedMarker?: boolean } = {},
): Record<string, unknown>[][] {
  const groups: Record<string, unknown>[][] = [];
  const items = asArray(value).filter(isRecord);
  let current: Record<string, unknown>[] | undefined;

  const flush = (): void => {
    if (current?.length) {
      groups.push(current);
    }
    current = undefined;
  };

  const canStartUnwrappedGroup = (item: Record<string, unknown>): boolean => {
    if (!options.allowUnwrapped) {
      return false;
    }
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    if (tag === "v-gs") {
      return !textOf(item).trim();
    }
    if (options.requireUnwrappedMarker) {
      return false;
    }
    if (tag !== "v" && tag !== "ptl") {
      return false;
    }
    const path = stringValue(item.path)?.toLocaleLowerCase() ?? "";
    const scopes = path.split("/");
    return !path || (scopes.includes("v-gs") && !scopes.includes("if-gs"));
  };

  for (const item of items) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    const marker = textOf(item);
    if (tag === "v-gs") {
      if (marker.includes("(")) {
        flush();
        current = [item];
        if (marker.includes(")")) {
          flush();
        }
      } else if (current) {
        current.push(item);
        if (marker.includes(")")) {
          flush();
        }
      } else if (canStartUnwrappedGroup(item)) {
        current = [item];
      }
      continue;
    }

    if (current) {
      current.push(item);
    } else if (canStartUnwrappedGroup(item)) {
      current = [item];
    }
  }
  flush();
  return groups;
}

function variantContextLabelsFrom(body: JsonObject): CanonicalLabel[] {
  return collectScopeFields(body, "v-gs").flatMap((value) => {
    let insideVariant = false;
    const labels: Record<string, unknown>[] = [];
    for (const item of asArray(value).filter(isRecord)) {
      const tag = stringValue(item.tag)?.toLocaleLowerCase();
      const marker = textOf(item);
      if (tag === "v-gs") {
        if (marker.includes("(")) {
          insideVariant = true;
        }
        if (marker.includes(")")) {
          insideVariant = false;
        }
        continue;
      }
      if (!insideVariant && tag && semanticLabelTags.has(tag)) {
        labels.push(item);
      }
    }
    return semanticLabelsFrom(labels);
  });
}

const variantIntroducerPattern = /^(?:abbr\.|also(?:\s+or)?|often|or|sometimes|symb\.|usually)$/i;

function isVariantIntroducer(value: string): boolean {
  return variantIntroducerPattern.test(value.trim());
}

function isVariantFormSeparator(item: Record<string, unknown>): boolean {
  return (
    stringValue(item.tag)?.toLocaleLowerCase() === "v-g" &&
    textOf(item).trim() === ","
  );
}

function splitVariantFormGroups(
  items: Record<string, unknown>[],
): Record<string, unknown>[][] {
  const groups: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];

  const flush = (): void => {
    if (current.length) {
      groups.push(current);
    }
    current = [];
  };

  for (const item of items) {
    current.push(item);
    if (isVariantFormSeparator(item)) {
      flush();
    }
  }
  flush();
  return groups;
}

function variantPresentationFrom(
  items: Record<string, unknown>[],
): CanonicalFormPresentationItem[] {
  const presentation: CanonicalFormPresentationItem[] = [];
  let hasPronunciation = false;
  let hasTarget = false;
  items.forEach((item) => {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    const text = textOf(item).trim();
    if (
      (tag === "v-g" && !isVariantFormSeparator(item) && text) ||
      (tag === "v" && isVariantIntroducer(text))
    ) {
      presentation.push({ kind: "introducer", value: canonicalText([item]) });
      return;
    }
    if ((tag === "v" || tag === "ptl") && !hasTarget) {
      presentation.push({ kind: "target" });
      hasTarget = true;
      return;
    }
    if (
      !hasPronunciation &&
      (tag === "pron-g" || tag === "phon" || tag === "audio" || tag === "form")
    ) {
      presentation.push({ kind: "pronunciation" });
      hasPronunciation = true;
      return;
    }
    if (!tag || !semanticLabelTags.has(tag)) {
      return;
    }
    semanticLabelsFrom([item]).forEach((label) => {
      presentation.push({ kind: "label", value: label });
    });
  });
  return presentation;
}

function variantFormFrom(
  items: Record<string, unknown>[],
  relation: CanonicalFormRelation = "alternative",
): CanonicalForm | undefined {
  const formItems: Record<string, unknown>[] = [];
  const introducerItems: Record<string, unknown>[] = [];

  for (const item of items) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    if (tag === "v-g") {
      if (!isVariantFormSeparator(item) && textOf(item).trim()) {
        introducerItems.push(item);
      }
      continue;
    }
    if (tag === "v") {
      if (isVariantIntroducer(textOf(item))) {
        introducerItems.push(item);
      } else {
        formItems.push(item);
      }
      continue;
    }
    if (tag === "ptl") {
      formItems.push(item);
    }
  }

  const text = formItems.map(textOf).join("").trim();
  if (!text) {
    return undefined;
  }
  return {
    kind: "variant",
    text,
    relation,
    introducer: introducerItems.length
      ? canonicalText(introducerItems)
      : undefined,
    labels: semanticLabelsFrom(items.filter((item) => {
      const tag = stringValue(item.tag)?.toLocaleLowerCase();
      return Boolean(tag && semanticLabelTags.has(tag));
    })),
    presentation: variantPresentationFrom(items),
    tokens: tokensOf(items),
    pronunciations: flattenedPronunciationsFrom(items),
    raw: items as JsonValue,
  };
}

function variantFormSignature(form: CanonicalForm): string {
  return JSON.stringify({
    text: form.text.trim(),
    introducer: form.introducer?.text.trim() ?? "",
    labels: (form.labels ?? []).map((label) => ({
      kind: label.kind ?? "",
      text: label.text.trim(),
      separatorBefore: label.separatorBefore ?? "",
    })),
    presentation: (form.presentation ?? []).map((item) => {
      if (item.kind === "target" || item.kind === "pronunciation") {
        return { kind: item.kind };
      }
      return item.kind === "introducer"
        ? { kind: item.kind, text: item.value.text.trim() }
        : {
            kind: item.kind,
            labelKind: item.value.kind ?? "",
            text: item.value.text.trim(),
            separatorBefore: item.value.separatorBefore ?? "",
          };
    }),
    pronunciations: (form.pronunciations ?? []).map((pronunciation) => ({
      region: pronunciation.region?.trim() ?? "",
      transcription: pronunciation.transcription?.trim() ?? "",
      audioKey: pronunciation.audioKey?.trim() ?? "",
      form: pronunciation.form?.trim() ?? "",
    })),
  });
}

function variantFormsFromGroups(
  groups: Record<string, unknown>[][],
): CanonicalForm[] {
  const seen = new Set<string>();
  return groups
    .flatMap(splitVariantFormGroups)
    .map((items) => variantFormFrom(items))
    .filter((form): form is CanonicalForm => Boolean(form))
    .filter((form) => {
      const signature = variantFormSignature(form);
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    });
}

function variantsFromSources(...sources: unknown[]): CanonicalForm[] {
  return variantFormsFromGroups(
    sources.flatMap((source) =>
      variantTokenGroupsFrom(source, {
        allowUnwrapped: true,
        requireUnwrappedMarker: true,
      })
    ),
  );
}

function variantsFrom(topData: Record<string, unknown>): CanonicalForm[] {
  return variantFormsFromGroups([
    ...variantTokenGroupsFrom(topData.top_text),
    ...variantTokenGroupsFrom(topData["v-gs"], { allowUnwrapped: true }),
  ]);
}

function labelsOutsideVariantGroupsFrom(value: unknown): CanonicalLabel[] {
  const items: Record<string, unknown>[] = [];
  let variantDepth = 0;

  for (const item of asArray(value).filter(isRecord)) {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    if (tag === "v-gs") {
      const marker = textOf(item);
      if (marker.includes("(")) {
        variantDepth += 1;
      }
      if (marker.includes(")")) {
        variantDepth = Math.max(0, variantDepth - 1);
      }
      continue;
    }
    if (variantDepth === 0) {
      items.push(item);
    }
  }

  return dedupeLabels(semanticLabelsFrom(items));
}

function phraseVariantRelationFrom(
  items: Record<string, unknown>[],
): CanonicalFormRelation {
  const labels = items.filter((item) => {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    return Boolean(tag && semanticLabelTags.has(tag));
  });
  const hasTextIntroducer = items.some((item) => {
    const tag = stringValue(item.tag)?.toLocaleLowerCase();
    return (tag === "v" || tag === "v-g") && isVariantIntroducer(textOf(item));
  });
  const labelsIntroduceAnAlternative = labels.some((label) =>
    /\balso\b/i.test(textOf(label)),
  );

  return !hasTextIntroducer && labels.length > 0 && !labelsIntroduceAnAlternative
    ? "equivalent"
    : "alternative";
}

function phraseVariantsFrom(value: unknown): CanonicalForm[] {
  return variantTokenGroupsFrom(value)
    .flatMap(splitVariantFormGroups)
    .map((items) => variantFormFrom(items, phraseVariantRelationFrom(items)))
    .filter((form): form is CanonicalForm => Boolean(form));
}

function phraseUsageFrom(value: unknown): CanonicalText[] {
  const text = canonicalText(value);
  return text.text.trim() ? [text] : [];
}

function inflectionGroupSignature(forms: CanonicalForm[]): string {
  return JSON.stringify(
    forms.map((form) => ({
      kind: form.kind,
      text: form.text.trim(),
      introducer: form.introducer?.text.trim() ?? "",
      pronunciations: (form.pronunciations ?? []).map((pronunciation) => ({
        region: pronunciation.region?.trim() ?? "",
        transcription: pronunciation.transcription?.trim() ?? "",
        audioKey: pronunciation.audioKey?.trim() ?? "",
        form: pronunciation.form?.trim() ?? "",
      })),
    })),
  );
}

function inflectedFormsFrom(body: JsonObject, topData: Record<string, unknown>): CanonicalForm[] {
  const groups = [
    flattenedInflectedFormsFrom(topData.top_text),
    ...collectScopeFields(body, "v-gs").map(flattenedInflectedFormsFrom),
  ];
  const seen = new Set<string>();
  return groups.flatMap((group) => {
    if (!group.length) {
      return [];
    }

    const key = inflectionGroupSignature(group);
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return group;
  });
}

interface SourceSense {
  value: Record<string, unknown>;
  partOfSpeech?: string;
  groupHeading?: CanonicalText;
  leadingUsage?: unknown;
}

function sourceSensesFrom(
  value: unknown,
  inheritedPartOfSpeech?: string,
): SourceSense[] {
  const senses: SourceSense[] = [];

  const visit = (
    current: unknown,
    inherited: string | undefined,
    inheritedGroupHeading?: CanonicalText,
  ): void => {
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, inherited, inheritedGroupHeading));
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    const partOfSpeech = unambiguousPartOfSpeechFrom(current) ?? inherited;
    const ownGroupHeading =
      current.shcut_name === undefined
        ? undefined
        : canonicalText(current.shcut_name);
    const groupHeading = ownGroupHeading?.text.trim()
      ? ownGroupHeading
      : inheritedGroupHeading;
    for (const [key, child] of Object.entries(current)) {
      if (key === "sn_g") {
        const leadingUsage = current.un;
        asArray(child).filter(isRecord).forEach((sense, index) => {
          senses.push({
            value: sense,
            partOfSpeech:
              unambiguousPartOfSpeechFrom(sense) ?? partOfSpeech,
            groupHeading,
            leadingUsage: index === 0 ? leadingUsage : undefined,
          });
        });
        continue;
      }

      if (key === "sngs_data" && Array.isArray(child)) {
        child.forEach((item) => {
          if (!isNestedEntry(item)) {
            visit(item, partOfSpeech, groupHeading);
          }
        });
        continue;
      }

      if (semanticScopeBoundaries.has(key)) {
        continue;
      }

      visit(child, partOfSpeech, groupHeading);
    }
  };

  visit(value, inheritedPartOfSpeech);
  return senses;
}

function canonicalSenseFrom(
  sourceSense: SourceSense,
  order: number,
): CanonicalSense {
  const { value, partOfSpeech, groupHeading, leadingUsage } = sourceSense;
  const usageSources = [leadingUsage, value.un].filter(
    (candidate) => asArray(candidate).length > 0,
  );
  return {
    id: stringValue(value.id),
    order,
    partOfSpeech,
    groupHeading,
    patterns: patternsFrom(value.sng_text, { includeParenthesizedVariants: false }),
    variants: variantsFromSources(value.sng_text),
    inflectedForms: inflectedFormsFrom(asJsonObject(value), { top_text: value.sng_text }),
    pronunciations: sensePronunciationsFrom(value.sng_text),
    labels: labelsOutsideVariantGroupsFrom(value.sng_text),
    definition: value.def_eng === undefined ? undefined : boxContentTextFrom(value.def_eng),
    definitionSegments: boxSegmentsFrom(value.def_eng),
    translation: optionalText(value.def_simp),
    examples: examplesFrom(value.x_gs),
    inlineUsage: inlineUsageFrom(value.sng_text),
    usage: usageSources.map(canonicalText),
    usageSegments: usageSources.flatMap((source) => boxSegmentsFrom(source)),
    crossReferences: crossReferencesFrom(value),
    illustrations: illustrationsFrom(value),
    grammarUsageBoxes: grammarUsageBoxesFrom(value),
    subsenses: sourceSensesFrom(value, partOfSpeech).map(canonicalSenseFrom),
    raw: asJsonObject(value),
  };
}

function sensesFrom(
  value: unknown,
  inheritedPartOfSpeech?: string,
): CanonicalSense[] {
  return sourceSensesFrom(
    value,
    inheritedPartOfSpeech,
  ).map(canonicalSenseFrom);
}

function phrasesFrom(
  value: unknown,
  groupField: "idm_gs" | "pv_gs",
  phraseField: "idm_g" | "pv_g",
  nameField: "idm_name" | "pv_name",
  textField: "idm_text" | "pv_text",
  inheritedPartOfSpeech?: string,
): CanonicalPhrase[] {
  return fieldItems(value, groupField)
    .filter(isRecord)
    .flatMap((group) => {
      const phrases = asArray(group[phraseField]).filter(isRecord);
      const groupReferences = crossReferencesFrom({ xrgs: group.xrgs });
      const groupUsage = phraseUsageFrom(group.un);
      return phrases.map((phrase, index) => {
        const displaySource = phrase[nameField] ?? [];
        return {
          id: stringValue(phrase.id),
          display: canonicalPhraseDisplay(displaySource),
          labels: dedupeLabels([
            ...headingLabelsFrom(displaySource),
            ...labelsOutsideVariantGroupsFrom(phrase[textField]),
          ]),
          variants: phraseVariantsFrom(phrase[textField]),
          leadingUsage: [
            ...(index === 0 ? groupUsage : []),
            ...phraseUsageFrom(phrase.un),
          ],
          senses: sensesFrom(
            phrase,
            unambiguousPartOfSpeechFrom(group) ?? inheritedPartOfSpeech,
          ),
          trailingCrossReferences: [
            ...crossReferencesFrom(phrase),
            ...(index === phrases.length - 1 ? groupReferences : []),
          ],
          raw: asJsonObject(phrase),
        };
      });
    });
}

function sourceBodyFrom(envelope: BundledBilingualEnvelope): JsonObject {
  return asJsonObject(sourceBodySchema.parse(envelope.body));
}

function mapEntry(
  body: JsonObject,
  context: AdaptationContext,
  id: string,
  inheritedDisplayHeadword: string,
): CanonicalEntry {
  const topData = isRecord(body.top_data) ? body.top_data : {};
  const headingTokens = asArray(topData.h);
  const displayHeadword = textOf(headingTokens[0]) || inheritedDisplayHeadword;
  const headword = normalizeHeadword(displayHeadword);
  const partOfSpeech = unambiguousPartOfSpeechFrom(body);

  const subentries = asArray(body.sngs_data)
    .filter(isNestedEntry)
    .map((subentry, index) =>
      mapEntry(
        asJsonObject(subentry),
        context,
        stringValue(subentry.id) || `${id}:subentry:${index}`,
        displayHeadword,
      ),
    );

  return canonicalEntrySchema.parse({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    dictionaryId: context.dictionaryId,
    sourceVersion: context.sourceVersion,
    id,
    headword,
    displayHeadword,
    searchKey: searchKeyFor(headword),
    labels: dedupeLabels([
      ...headingLabelsFrom(headingTokens.slice(1)),
      ...subentryMetadataLabelsFrom(body),
      ...labelsOutsideVariantGroupsFrom(topData.top_text),
      ...variantContextLabelsFrom(body),
    ]),
    pronunciations: pronunciationsFrom(body),
    partsOfSpeech: partsOfSpeechFrom(body),
    headwordPatterns: patternsFrom(topData.top_text, { includeParenthesizedVariants: false }),
    headwordUsage: inlineUsageFrom(topData.top_text),
    senses: sensesFrom(body, partOfSpeech),
    subentries,
    idioms: phrasesFrom(body, "idm_gs", "idm_g", "idm_name", "idm_text", partOfSpeech),
    phrasalVerbs: phrasesFrom(body, "pv_gs", "pv_g", "pv_name", "pv_text", partOfSpeech),
    derivedForms: derivedFormsFrom(body),
    inflectedForms: inflectedFormsFrom(body, topData),
    variants: variantsFrom(topData),
    crossReferences: crossReferencesFrom(body),
    illustrations: illustrationsFrom(body),
    grammarUsageBoxes: [
      ...topUsageBoxesFrom(topData),
      ...grammarUsageBoxesFrom(body),
    ],
    raw: body,
  });
}

export class BundledBilingualAdapter
  implements DictionaryAdapter<BundledBilingualEnvelope>
{
  readonly id = "bundled-bilingual";
  private readonly dictionaryId: string;

  constructor(options: BundledBilingualAdapterOptions = {}) {
    this.dictionaryId = options.dictionaryId ?? this.id;
  }

  parse(input: unknown): CanonicalEntry {
    return this.adapt(bundledBilingualEnvelopeSchema.parse(input));
  }

  adapt(envelope: BundledBilingualEnvelope): CanonicalEntry {
    const body = sourceBodyFrom(envelope);
    return mapEntry(
      body,
      {
        dictionaryId: this.dictionaryId,
        sourceVersion: envelope.sourceVersion,
      },
      envelope.entryId,
      envelope.headword,
    );
  }
}
