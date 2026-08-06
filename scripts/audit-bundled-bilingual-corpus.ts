import { DatabaseSync } from "node:sqlite";

import { BundledBilingualAdapter } from "../packages/adapters/src/index";
import type {
  CanonicalBoxBlock,
  CanonicalBoxSegment,
  CanonicalCrossReference,
  CanonicalEntry,
  CanonicalForm,
  CanonicalGrammarUsageBox,
  CanonicalLabel,
  CanonicalPhrase,
  CanonicalSense,
  JsonValue,
} from "../packages/dictionary-schema/src/index";
import { CANONICAL_CROSS_REFERENCE_KINDS } from "../packages/dictionary-schema/src/index";

type SourceRow = {
  id: string;
  word: string | null;
  word_body: string;
};

type AuditViolation = {
  code: string;
  entryId: string;
  detail: string;
};

const allowedLabelKinds = new Set([
  "academic-register",
  "exam",
  "frequency",
  "geo",
  "gram",
  "level",
  "or",
  "reg",
  "subj",
]);

const allowedFormKinds = new Set([
  "derivative",
  "inflection",
  "variant",
  "word-family",
]);

const allowedCrossReferenceKinds = new Set(CANONICAL_CROSS_REFERENCE_KINDS);

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceText(value: JsonValue | undefined): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(sourceText).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.value !== undefined) {
    return sourceText(value.value);
  }
  return ["eng", "simp", "text", "word", "xh", "xw", "def_eng", "def_simp"]
    .map((key) => sourceText(value[key]))
    .join("");
}

function firstNonEmptySourceText(...values: Array<JsonValue | undefined>): string {
  for (const value of values) {
    const text = sourceText(value).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeReferenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function sourcePathIncludes(value: Record<string, JsonValue>, segment: string): boolean {
  const path = typeof value.path === "string" ? value.path.toLocaleLowerCase() : "";
  return path.split("/").includes(segment.toLocaleLowerCase());
}

function sourceInlineUsageTexts(value: JsonValue | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  const items = Array.isArray(value) ? value : [];
  let current: JsonValue[] = [];
  let currentKind: "display" | "usage" | undefined;

  const flush = (): void => {
    const text = normalizeReferenceText(sourceText(current));
    if (text.replace(/[()\s]/g, "")) {
      increment(counts, text);
    }
    current = [];
    currentKind = undefined;
  };

  for (const item of items) {
    if (!isRecord(item)) {
      flush();
      continue;
    }
    const tag = sourceText(item.tag).toLocaleLowerCase();
    const kind = tag === "use" || tag === "use_end" || sourcePathIncludes(item, "use")
      ? "usage"
      : sourcePathIncludes(item, "dis-g")
        ? "display"
        : undefined;
    if (!kind) {
      flush();
      continue;
    }
    if (currentKind && currentKind !== kind) {
      flush();
    }
    currentKind = kind;
    current.push(item);
  }
  flush();
  return counts;
}

function canonicalInlineUsageTexts(sense: CanonicalSense): Map<string, number> {
  const counts = new Map<string, number>();
  (sense.inlineUsage ?? []).forEach((usage) => {
    const text = normalizeReferenceText(usage.text);
    if (text) {
      increment(counts, text);
    }
  });
  return counts;
}

type BoxStructureCounts = {
  examples: number;
  termsWithPartOfSpeech: number;
  crossReferences: number;
  pronunciations: number;
  tables: number;
};

type UsageStructureCounts = {
  examples: number;
  audio: number;
};

function hasSourceAudioKey(value: JsonValue): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const metadata = isRecord(value.value) ? value.value : value;
  return (
    (typeof metadata.url === "string" && metadata.url.trim().length > 0) ||
    (typeof metadata.audio === "string" && metadata.audio.trim().length > 0)
  );
}

function sourceUsageStructureCounts(value: JsonValue | undefined): UsageStructureCounts {
  const counts: UsageStructureCounts = { examples: 0, audio: 0 };
  const items = Array.isArray(value) ? value : [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecord(item) || sourceText(item.tag).toLocaleLowerCase() !== "x-g") {
      continue;
    }

    if (isRecord(item.value)) {
      const example = item.value;
      const audio = Array.isArray(example.xaudio)
        ? example.xaudio.filter(hasSourceAudioKey).length
        : 0;
      const hasText = sourceText(example.x_eng).trim() || sourceText(example.x_simp).trim();
      if (hasText || audio) {
        counts.examples += 1;
        counts.audio += audio;
      }
      continue;
    }

    const endIndex = items.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        isRecord(candidate) &&
        sourceText(candidate.tag).toLocaleLowerCase() === "x-g_end",
    );
    if (endIndex < 0) {
      continue;
    }
    const source = items.slice(index + 1, endIndex);
    const audio = source.filter((candidate) => {
      if (!isRecord(candidate) || sourceText(candidate.tag).toLocaleLowerCase() !== "xaudio") {
        return false;
      }
      return hasSourceAudioKey(candidate);
    }).length;
    const hasText = source.some((candidate) => {
      if (!isRecord(candidate)) {
        return sourceText(candidate).trim().length > 0;
      }
      const tag = sourceText(candidate.tag).toLocaleLowerCase();
      return !["x", "xaudio", "x-gs", "x-gs_end"].includes(tag) && sourceText(candidate).trim().length > 0;
    });
    if (hasText || audio) {
      counts.examples += 1;
      counts.audio += audio;
    }
    index = endIndex;
  }

  return counts;
}

function canonicalUsageStructureCounts(segments: CanonicalBoxSegment[]): UsageStructureCounts {
  return segments.reduce<UsageStructureCounts>((counts, segment) => {
    if (segment.kind === "example") {
      counts.examples += 1;
      counts.audio += segment.value.audio.length;
    }
    return counts;
  }, { examples: 0, audio: 0 });
}

function sourceBoxStructureCounts(value: JsonValue): BoxStructureCounts {
  const counts: BoxStructureCounts = {
    examples: 0,
    termsWithPartOfSpeech: 0,
    crossReferences: 0,
    pronunciations: 0,
    tables: 0,
  };

  const visit = (current: JsonValue, parentKey?: string): void => {
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const item = current[index];
        const next = current[index + 1];
        if (
          isRecord(item) &&
          isRecord(next) &&
          sourceText(item.tag).toLocaleLowerCase() === "eb" &&
          sourceText(next.tag).toLocaleLowerCase() === "pos"
        ) {
          counts.termsWithPartOfSpeech += 1;
        }
        visit(item, parentKey);
      }
      return;
    }
    if (!isRecord(current)) {
      return;
    }

    const tag = sourceText(current.tag).toLocaleLowerCase();
    if (tag === "x-g" && isRecord(current.value)) {
      const example = current.value;
      const hasText = sourceText(example.x_eng).trim() || sourceText(example.x_simp).trim();
      const hasAudio = Array.isArray(example.xaudio) && example.xaudio.length > 0;
      if (hasText || hasAudio) {
        counts.examples += 1;
      }
    }
    if (parentKey === "pron-g" && [current.phon, current.geo, current.audio, current.form].some(
      (part) => sourceText(part).trim(),
    )) {
      counts.pronunciations += 1;
    }
    if (Array.isArray(current.xrg)) {
      counts.crossReferences += current.xrg.filter(
        (target) => isRecord(target) && Boolean(firstNonEmptySourceText(
          target.xh,
          target.xw,
          target.word,
          target.text,
          target.value,
        )),
      ).length;
    }
    if (Array.isArray(current.table)) {
      counts.tables += 1;
    }

    Object.entries(current).forEach(([key, child]) => visit(child, key));
  };

  visit(value);
  return counts;
}

function canonicalBoxStructureCounts(blocks: CanonicalBoxBlock[]): BoxStructureCounts {
  const counts: BoxStructureCounts = {
    examples: 0,
    termsWithPartOfSpeech: 0,
    crossReferences: 0,
    pronunciations: 0,
    tables: 0,
  };
  const visitSegments = (segments: CanonicalBoxSegment[]): void => {
    for (const segment of segments) {
      if (segment.kind === "example") {
        counts.examples += 1;
      } else if (segment.kind === "term" && segment.partOfSpeech?.text.trim()) {
        counts.termsWithPartOfSpeech += 1;
      } else if (segment.kind === "cross-references") {
        counts.crossReferences += segment.references.length;
      }
    }
  };

  for (const block of blocks) {
    if (block.kind === "pronunciations") {
      counts.pronunciations += block.items.length;
    } else if (block.kind === "cross-references") {
      counts.crossReferences += block.references.length;
    } else if (block.kind === "table") {
      counts.tables += 1;
      block.rows.forEach((row) => row.cells.forEach((cell) => visitSegments(cell.segments)));
    } else if (block.kind === "paragraph") {
      visitSegments(block.segments);
    } else if (block.kind === "list") {
      block.items.forEach((item) => visitSegments(item.segments));
    }
  }
  return counts;
}

function collectSourceAudioKeys(value: JsonValue, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceAudioKeys(item, keys));
    return keys;
  }
  if (!isRecord(value)) {
    return keys;
  }
  if (typeof value.audio === "string" && value.audio.trim()) {
    keys.add(value.audio.trim());
  }
  if (
    sourceText(value.tag).toLocaleLowerCase() === "xaudio" &&
    isRecord(value.value) &&
    typeof value.value.url === "string" &&
    value.value.url.trim()
  ) {
    keys.add(value.value.url.trim());
  }
  Object.values(value).forEach((item) => collectSourceAudioKeys(item, keys));
  return keys;
}

function collectBoxAudioKeys(box: CanonicalGrammarUsageBox, keys: Set<string>): void {
  const collectSegmentAudio = (
    segments: CanonicalBoxSegment[],
  ): void => {
    segments.forEach((segment) => {
      if (segment.kind === "example") {
        segment.value.audio.forEach((audio) => keys.add(audio.key));
      }
    });
  };

  for (const block of box.blocks) {
    if (block.kind === "pronunciations") {
      block.items.forEach((item) => item.audioKey && keys.add(item.audioKey));
    } else if (block.kind === "paragraph") {
      collectSegmentAudio(block.segments);
    } else if (block.kind === "table") {
      block.rows.forEach((row) => row.cells.forEach((cell) => collectSegmentAudio(cell.segments)));
    } else if (block.kind === "list") {
      block.items.forEach((item) => collectSegmentAudio(item.segments));
    }
  }
}

function collectSenseAudioKeys(sense: CanonicalSense, keys: Set<string>): void {
  sense.examples.forEach((example) => example.audio.forEach((audio) => keys.add(audio.key)));
  sense.usageSegments.forEach((segment) => {
    if (segment.kind === "example") {
      segment.value.audio.forEach((audio) => keys.add(audio.key));
    }
  });
  sense.grammarUsageBoxes.forEach((box) => collectBoxAudioKeys(box, keys));
  sense.subsenses.forEach((nested) => collectSenseAudioKeys(nested, keys));
}

function collectEntryAudioKeys(entry: CanonicalEntry, keys = new Set<string>()): Set<string> {
  entry.pronunciations.forEach((item) => item.audioKey && keys.add(item.audioKey));
  const forms = [
    ...entry.derivedForms,
    ...entry.inflectedForms,
    ...(entry.variants ?? []),
  ];
  forms.forEach((form) => {
    (form.pronunciations ?? []).forEach((item) => item.audioKey && keys.add(item.audioKey));
    (form.senses ?? []).forEach((sense) => collectSenseAudioKeys(sense, keys));
  });
  entry.senses.forEach((sense) => collectSenseAudioKeys(sense, keys));
  [...entry.idioms, ...entry.phrasalVerbs].forEach((phrase) => {
    phrase.variants.forEach((form) => {
      (form.pronunciations ?? []).forEach((item) => item.audioKey && keys.add(item.audioKey));
    });
    phrase.senses.forEach((sense) => collectSenseAudioKeys(sense, keys));
  });
  entry.grammarUsageBoxes.forEach((box) => collectBoxAudioKeys(box, keys));
  entry.subentries.forEach((subentry) => collectEntryAudioKeys(subentry, keys));
  return keys;
}

function incrementReferenceText(counts: Map<string, number>, value: string): void {
  const text = normalizeReferenceText(value);
  if (text) {
    increment(counts, text);
  }
}

function collectSourceCrossReferenceTexts(
  value: JsonValue,
  counts = new Map<string, number>(),
): Map<string, number> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceCrossReferenceTexts(item, counts));
    return counts;
  }
  if (!isRecord(value)) {
    return counts;
  }

  if (Array.isArray(value.xrg)) {
    value.xrg.filter(isRecord).forEach((target) => {
      incrementReferenceText(counts, firstNonEmptySourceText(
        target.xh,
        target.xw,
        target.word,
        target.text,
        target.value,
      ));
    });
  }
  Object.values(value).forEach((item) => collectSourceCrossReferenceTexts(item, counts));
  return counts;
}

function collectCanonicalReferenceTexts(
  references: CanonicalCrossReference[],
  counts: Map<string, number>,
): void {
  references.forEach((reference) => incrementReferenceText(counts, reference.text));
}

function collectCanonicalSegmentReferenceTexts(
  segments: CanonicalBoxSegment[],
  counts: Map<string, number>,
): void {
  segments.forEach((segment) => {
    if (segment.kind === "cross-references") {
      collectCanonicalReferenceTexts(segment.references, counts);
    }
  });
}

function collectCanonicalBoxReferenceTexts(
  box: CanonicalGrammarUsageBox,
  counts: Map<string, number>,
): void {
  collectCanonicalReferenceTexts(box.references ?? [], counts);
  box.blocks.forEach((block) => {
    if (block.kind === "cross-references") {
      collectCanonicalReferenceTexts(block.references, counts);
    } else if (block.kind === "paragraph") {
      collectCanonicalSegmentReferenceTexts(block.segments, counts);
    } else if (block.kind === "table") {
      block.rows.forEach((row) => row.cells.forEach((cell) =>
        collectCanonicalSegmentReferenceTexts(cell.segments, counts),
      ));
    } else if (block.kind === "list") {
      block.items.forEach((item) => collectCanonicalSegmentReferenceTexts(item.segments, counts));
    }
  });
}

function collectCanonicalSenseReferenceTexts(
  sense: CanonicalSense,
  counts: Map<string, number>,
): void {
  collectCanonicalReferenceTexts(sense.crossReferences, counts);
  collectCanonicalSegmentReferenceTexts(sense.usageSegments, counts);
  sense.grammarUsageBoxes.forEach((box) => collectCanonicalBoxReferenceTexts(box, counts));
  sense.subsenses.forEach((nested) => collectCanonicalSenseReferenceTexts(nested, counts));
}

function collectCanonicalFormReferenceTexts(
  form: CanonicalForm,
  counts: Map<string, number>,
): void {
  (form.senses ?? []).forEach((sense) => collectCanonicalSenseReferenceTexts(sense, counts));
}

function collectCanonicalPhraseReferenceTexts(
  phrase: CanonicalPhrase,
  counts: Map<string, number>,
): void {
  collectCanonicalReferenceTexts(phrase.trailingCrossReferences, counts);
  phrase.variants.forEach((form) => collectCanonicalFormReferenceTexts(form, counts));
  phrase.senses.forEach((sense) => collectCanonicalSenseReferenceTexts(sense, counts));
}

function collectCanonicalEntryCrossReferenceTexts(
  entry: CanonicalEntry,
  counts = new Map<string, number>(),
): Map<string, number> {
  collectCanonicalReferenceTexts(entry.crossReferences, counts);
  entry.senses.forEach((sense) => collectCanonicalSenseReferenceTexts(sense, counts));
  [
    ...entry.derivedForms,
    ...entry.inflectedForms,
    ...(entry.variants ?? []),
  ].forEach((form) => collectCanonicalFormReferenceTexts(form, counts));
  [...entry.idioms, ...entry.phrasalVerbs].forEach((phrase) =>
    collectCanonicalPhraseReferenceTexts(phrase, counts),
  );
  entry.grammarUsageBoxes.forEach((box) => collectCanonicalBoxReferenceTexts(box, counts));
  entry.subentries.forEach((subentry) => collectCanonicalEntryCrossReferenceTexts(subentry, counts));
  return counts;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

function visitSourceTags(value: JsonValue, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitSourceTags(item, counts));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (typeof value.tag === "string") {
    increment(counts, value.tag.toLocaleLowerCase());
  }
  Object.values(value).forEach((item) => visitSourceTags(item, counts));
}

function main(): void {
  const sourcePath = option("--source");
  if (!sourcePath) {
    throw new Error("Usage: npm run dictionary:audit -- --source <source.db> [--source-version <version>]");
  }

  const sourceVersion = option("--source-version") ?? "corpus-audit";
  const adapter = new BundledBilingualAdapter({ dictionaryId: "corpus-audit" });
  const sourceTagCounts = new Map<string, number>();
  const labelKindCounts = new Map<string, number>();
  const formKindCounts = new Map<string, number>();
  const violations: AuditViolation[] = [];
  let violationCount = 0;
  let sourceEntries = 0;
  let canonicalRootEntries = 0;
  let canonicalEntries = 0;
  let senses = 0;
  let forms = 0;
  let boxes = 0;
  let references = 0;
  const auditedBoxes = new Set<string>();

  const reportViolation = (code: string, entryId: string, detail: string): void => {
    violationCount += 1;
    if (violations.length < 100) {
      violations.push({ code, entryId, detail });
    }
  };

  const visitLabel = (label: CanonicalLabel, entryId: string): void => {
    const kind = label.kind ?? "<missing>";
    increment(labelKindCounts, kind);
    if (!allowedLabelKinds.has(kind)) {
      reportViolation("unexpected-label-kind", entryId, `${kind}: ${label.text}`);
    }
  };

  const visitSense = (sense: CanonicalSense, entryId: string): void => {
    senses += 1;
    sense.labels.forEach((label) => visitLabel(label, entryId));
    sense.subsenses.forEach((nested) => visitSense(nested, entryId));
    sense.grammarUsageBoxes.forEach((box) => visitBox(box, entryId));
    sense.crossReferences.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
    const sourceUsageCounts = sourceUsageStructureCounts(sense.raw.un);
    const canonicalUsageCounts = canonicalUsageStructureCounts(sense.usageSegments);
    (Object.keys(sourceUsageCounts) as Array<keyof UsageStructureCounts>).forEach((key) => {
      if (sourceUsageCounts[key] > canonicalUsageCounts[key]) {
        reportViolation(
          `usage-${key}-loss`,
          entryId,
          `${sense.id ?? "<sense>"}: source=${sourceUsageCounts[key]}, canonical=${canonicalUsageCounts[key]}`,
        );
      }
    });
    const sourceInlineTexts = sourceInlineUsageTexts(sense.raw.sng_text);
    const canonicalInlineTexts = canonicalInlineUsageTexts(sense);
    sourceInlineTexts.forEach((count, text) => {
      const canonicalCount = canonicalInlineTexts.get(text) ?? 0;
      if (canonicalCount < count) {
        reportViolation(
          "missing-inline-usage-text",
          entryId,
          `${sense.id ?? "<sense>"}: ${text}: source=${count}, canonical=${canonicalCount}`,
        );
      }
    });
  };

  const visitReference = (
    kind: string | undefined,
    entryId: string,
    text: string,
  ): void => {
    references += 1;
    if (!kind || !allowedCrossReferenceKinds.has(kind as typeof CANONICAL_CROSS_REFERENCE_KINDS[number])) {
      reportViolation("unexpected-cross-reference-kind", entryId, `${kind ?? "<missing>"}: ${text}`);
    }
  };

  const visitBox = (box: CanonicalGrammarUsageBox, entryId: string): void => {
    const auditKey = `${box.id ?? ""}\u0000${JSON.stringify(box.body)}`;
    if (auditedBoxes.has(auditKey)) {
      return;
    }
    auditedBoxes.add(auditKey);
    boxes += 1;
    const boxReferences = box.references ?? [];
    boxReferences.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
    box.blocks.forEach((block) => {
      if (block.kind === "cross-references") {
        block.references.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
      } else if (block.kind === "paragraph") {
        block.segments.forEach((segment) => {
          if (segment.kind === "cross-references") {
            segment.references.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
          }
        });
      } else if (block.kind === "table") {
        block.rows.forEach((row) => row.cells.forEach((cell) => cell.segments.forEach((segment) => {
          if (segment.kind === "cross-references") {
            segment.references.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
          }
        })));
      } else if (block.kind === "list") {
        block.items.forEach((item) => item.segments.forEach((segment) => {
          if (segment.kind === "cross-references") {
            segment.references.forEach((reference) => visitReference(reference.kind, entryId, reference.text));
          }
        }));
      }
    });
    const sourceCounts = sourceBoxStructureCounts(box.raw);
    const canonicalCounts = canonicalBoxStructureCounts(box.blocks);
    (Object.keys(sourceCounts) as Array<keyof BoxStructureCounts>).forEach((key) => {
      if (sourceCounts[key] !== canonicalCounts[key]) {
        reportViolation(
          `box-${key}-loss`,
          entryId,
          `${box.id ?? box.type ?? "<box>"}: source=${sourceCounts[key]}, canonical=${canonicalCounts[key]}`,
        );
      }
    });
    if (
      box.title?.text.trim() &&
      boxReferences.length &&
      box.title.text.replace(/\s+/g, "").toLocaleLowerCase() ===
        boxReferences.map((reference) => reference.text).join("").replace(/\s+/g, "").toLocaleLowerCase()
    ) {
      reportViolation("reference-title-concatenation", entryId, box.title.text);
    }
  };

  const visitForm = (form: CanonicalForm, entryId: string): void => {
    forms += 1;
    increment(formKindCounts, form.kind);
    if (!allowedFormKinds.has(form.kind)) {
      reportViolation("unexpected-form-kind", entryId, form.kind);
    }
    if (!form.text.trim()) {
      reportViolation("empty-form", entryId, form.kind);
    }
    (form.labels ?? []).forEach((label) => visitLabel(label, entryId));
    (form.senses ?? []).forEach((sense) => visitSense(sense, entryId));
  };

  const visitPhrase = (phrase: CanonicalPhrase, entryId: string): void => {
    phrase.labels.forEach((label) => visitLabel(label, entryId));
    phrase.variants.forEach((form) => visitForm(form, entryId));
    phrase.senses.forEach((sense) => visitSense(sense, entryId));
    phrase.trailingCrossReferences.forEach((reference) =>
      visitReference(reference.kind, entryId, reference.text),
    );
  };

  const visitEntry = (entry: CanonicalEntry): void => {
    canonicalEntries += 1;
    entry.labels.forEach((label) => visitLabel(label, entry.id));
    entry.senses.forEach((sense) => visitSense(sense, entry.id));
    entry.derivedForms.forEach((form) => visitForm(form, entry.id));
    entry.inflectedForms.forEach((form) => visitForm(form, entry.id));
    (entry.variants ?? []).forEach((form) => visitForm(form, entry.id));
    entry.idioms.forEach((phrase) => visitPhrase(phrase, entry.id));
    entry.phrasalVerbs.forEach((phrase) => visitPhrase(phrase, entry.id));
    entry.grammarUsageBoxes.forEach((box) => visitBox(box, entry.id));
    entry.crossReferences.forEach((reference) => visitReference(reference.kind, entry.id, reference.text));
    entry.subentries.forEach(visitEntry);
  };

  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const statement = database.prepare(
      "SELECT id, word, word_body FROM oxford_x_word ORDER BY id",
    );
    for (const row of statement.iterate() as Iterable<SourceRow>) {
      sourceEntries += 1;
      let sourceBody: JsonValue;
      try {
        sourceBody = JSON.parse(row.word_body) as JsonValue;
      } catch (error) {
        reportViolation(
          "invalid-source-json",
          row.id,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      visitSourceTags(sourceBody, sourceTagCounts);
      try {
        const entry = adapter.parse({
          entryId: row.id,
          headword: row.word ?? "",
          sourceVersion,
          body: sourceBody,
        });
        canonicalRootEntries += 1;
        visitEntry(entry);
        const sourceAudioKeys = collectSourceAudioKeys(sourceBody);
        const canonicalAudioKeys = collectEntryAudioKeys(entry);
        sourceAudioKeys.forEach((key) => {
          if (!canonicalAudioKeys.has(key)) {
            reportViolation("missing-audio-key", row.id, key);
          }
        });
        const sourceReferenceTexts = collectSourceCrossReferenceTexts(sourceBody);
        const canonicalReferenceTexts = collectCanonicalEntryCrossReferenceTexts(entry);
        sourceReferenceTexts.forEach((count, text) => {
          const canonicalCount = canonicalReferenceTexts.get(text) ?? 0;
          if (canonicalCount < count) {
            reportViolation(
              "missing-cross-reference-text",
              row.id,
              `${text}: source=${count}, canonical=${canonicalCount}`,
            );
          }
        });
      } catch (error) {
        reportViolation(
          "adapter-failure",
          row.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    database.close();
  }

  if (sourceEntries !== canonicalRootEntries) {
    reportViolation(
      "entry-count-mismatch",
      "<corpus>",
      `source=${sourceEntries}, canonical=${canonicalRootEntries}`,
    );
  }

  console.log(JSON.stringify({
    sourceEntries,
    canonicalRootEntries,
    canonicalEntries,
    senses,
    forms,
    boxes,
    references,
    sourceTagCounts: sortedCounts(sourceTagCounts),
    labelKindCounts: sortedCounts(labelKindCounts),
    formKindCounts: sortedCounts(formKindCounts),
    violationCount,
    violations,
  }, null, 2));

  if (violationCount > 0) {
    process.exitCode = 1;
  }
}

main();
