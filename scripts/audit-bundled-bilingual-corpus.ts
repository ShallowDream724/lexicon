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
  "inflection-constraint",
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

function isStructuralSeparator(value: string): boolean {
  return /^[,;:/|\\]+/.test(value);
}

function isPureStructuralPunctuation(value: string): boolean {
  return /^[()[\]{}<>,;:/|\\.!?]+$/.test(value.trim());
}

function hasResidualLabelWrapping(value: string): boolean {
  const text = value.trim();
  return /^\[[^\]]*\]$/.test(text) || /^\{[^}]*\}$/.test(text);
}

const sourceVariantIntroducers = new Set([
  "abbr.",
  "also",
  "also or",
  "often",
  "or",
  "sometimes",
  "symb.",
  "usually",
]);

const sourceSemanticLabelTags = new Set(["geo", "gram", "or", "reg", "subj"]);

function cleanSourceSemanticLabel(value: string): string {
  return value
    .trim()
    .replace(/^[,;]\s*/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
}

function sourceVariantPresentationSignature(items: Record<string, JsonValue>[]): unknown[] {
  const presentation: unknown[] = [];
  let hasPronunciation = false;
  let hasTarget = false;
  items.forEach((item) => {
    const tag = sourceText(item.tag).toLocaleLowerCase();
    const rawText = sourceText(item);
    const text = normalizeReferenceText(rawText);
    if (
      (tag === "v-g" && !/^[,;/\s]+$/.test(rawText) && text) ||
      (tag === "v" && sourceVariantIntroducers.has(text))
    ) {
      presentation.push({ kind: "introducer", text });
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
    if (!sourceSemanticLabelTags.has(tag)) {
      return;
    }
    const labelText = normalizeReferenceText(cleanSourceSemanticLabel(rawText));
    if (labelText) {
      presentation.push({
        kind: "label",
        labelKind: tag,
        text: labelText,
        separatorBefore: /^\s*([,;])/.exec(rawText)?.[1] ?? "",
      });
    }
  });
  return presentation;
}

function variantProjectionSignature(text: string, presentation: unknown[]): string {
  return JSON.stringify({ text: normalizeReferenceText(text), presentation });
}

type SourceVariantStructureCounts = {
  bracketGroups: number;
  derivativeTopTextBracketGroups: number;
  senseBracketGroups: number;
  topTextBracketGroups: number;
  targets: number;
};

function sourceVariantTargetTexts(
  value: JsonValue,
  counts = new Map<string, number>(),
  structureCounts: SourceVariantStructureCounts = {
    bracketGroups: 0,
    derivativeTopTextBracketGroups: 0,
    senseBracketGroups: 0,
    topTextBracketGroups: 0,
    targets: 0,
  },
  signatures = new Map<string, number>(),
): {
  counts: Map<string, number>;
  signatures: Map<string, number>;
  structureCounts: SourceVariantStructureCounts;
} {
  const addSequenceTargets = (
    items: JsonValue[],
    scope: {
      allowUnwrapped?: boolean;
      derivativeTopText?: boolean;
      requireUnwrappedMarker?: boolean;
      sense?: boolean;
      topText?: boolean;
    } = {},
  ): void => {
    let current: Record<string, JsonValue>[] | undefined;

    const canStartUnwrappedGroup = (item: Record<string, JsonValue>): boolean => {
      if (!scope.allowUnwrapped) {
        return false;
      }
      const tag = sourceText(item.tag).toLocaleLowerCase();
      if (tag === "v-gs") {
        return !sourceText(item).trim();
      }
      if (scope.requireUnwrappedMarker) {
        return false;
      }
      if (tag !== "v" && tag !== "ptl") {
        return false;
      }
      const path = sourceText(item.path).toLocaleLowerCase();
      const scopes = path.split("/");
      return !path || (scopes.includes("v-gs") && !scopes.includes("if-gs"));
    };

    const flush = (): void => {
      if (!current) {
        return;
      }
      const text = current
        .filter((item) => {
          const tag = sourceText(item.tag).toLocaleLowerCase();
          return (
            (tag === "v" && !sourceVariantIntroducers.has(normalizeReferenceText(sourceText(item)))) ||
            tag === "ptl"
          );
        })
        .map(sourceText)
        .join("")
        .trim();
      const target = normalizeReferenceText(text);
      if (target) {
        increment(counts, target);
        increment(
          signatures,
          variantProjectionSignature(target, sourceVariantPresentationSignature(current)),
        );
        structureCounts.targets += 1;
      }
      current = undefined;
    };

    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const tag = sourceText(item.tag).toLocaleLowerCase();
      if (tag === "v-gs") {
        const marker = sourceText(item);
        if (marker.includes("(")) {
          flush();
          current = [];
          structureCounts.bracketGroups += 1;
          if (scope.topText) {
            structureCounts.topTextBracketGroups += 1;
          }
          if (scope.derivativeTopText) {
            structureCounts.derivativeTopTextBracketGroups += 1;
          }
          if (scope.sense) {
            structureCounts.senseBracketGroups += 1;
          }
        }
        if (marker.includes(")")) {
          flush();
        } else if (!current && canStartUnwrappedGroup(item)) {
          current = [item];
        }
      } else if (current && tag === "v-g" && /^[,;/\s]+$/.test(sourceText(item))) {
        flush();
        current = [];
      } else if (current) {
        current.push(item);
      } else if (canStartUnwrappedGroup(item)) {
        current = [item];
      }
    }
    flush();
  };

  const visit = (current: JsonValue): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) {
      return;
    }
    if (isRecord(current.top_data)) {
      const topData = current.top_data;
      if (Array.isArray(topData.top_text)) {
        addSequenceTargets(topData.top_text, { topText: true });
      }
      if (Array.isArray(topData["v-gs"])) {
        addSequenceTargets(topData["v-gs"], { allowUnwrapped: true });
      }
    }
    if (isRecord(current.top_g)) {
      const topData = current.top_g;
      if (Array.isArray(topData.top_text)) {
        addSequenceTargets(topData.top_text, { derivativeTopText: true, topText: true });
      }
      if (Array.isArray(topData["v-gs"])) {
        addSequenceTargets(topData["v-gs"], {
          allowUnwrapped: true,
          derivativeTopText: true,
        });
      }
    }
    [current.idm_text, current.pv_text].forEach((field) => {
      if (Array.isArray(field)) {
        addSequenceTargets(field);
      }
    });
    if (Array.isArray(current.sng_text)) {
      addSequenceTargets(current.sng_text, {
        allowUnwrapped: true,
        requireUnwrappedMarker: true,
        sense: true,
      });
    }
    Object.values(current).forEach(visit);
  };

  visit(value);
  return { counts, signatures, structureCounts };
}

function collectCanonicalVariantTargetTexts(
  entry: CanonicalEntry,
  counts = new Map<string, number>(),
  signatures = new Map<string, number>(),
): { counts: Map<string, number>; signatures: Map<string, number> } {
  function addForms(forms: CanonicalForm[]): void {
    forms.forEach((form) => {
      if (form.kind === "variant") {
        incrementReferenceText(counts, form.text);
        const presentation = form.presentation?.length
          ? form.presentation.map((item) => {
              if (item.kind === "target" || item.kind === "pronunciation") {
                return { kind: item.kind };
              }
              return item.kind === "introducer"
                ? { kind: item.kind, text: normalizeReferenceText(item.value.text) }
                : {
                    kind: item.kind,
                    labelKind: item.value.kind ?? "",
                    text: normalizeReferenceText(item.value.text),
                    separatorBefore: item.value.separatorBefore ?? "",
                  };
            })
          : [
              ...(form.introducer?.text.trim()
                ? [{ kind: "introducer", text: normalizeReferenceText(form.introducer.text) }]
                : []),
              ...(form.labels ?? []).map((label) => ({
                kind: "label",
                labelKind: label.kind ?? "",
                text: normalizeReferenceText(label.text),
                separatorBefore: label.separatorBefore ?? "",
              })),
              { kind: "target" },
              ...((form.pronunciations ?? []).length ? [{ kind: "pronunciation" }] : []),
            ];
        increment(signatures, variantProjectionSignature(form.text, presentation));
      }
      addForms(form.variants ?? []);
      addForms(form.inflectedForms ?? []);
      addSenses(form.senses ?? []);
    });
  }

  function addSenses(senses: CanonicalSense[]): void {
    senses.forEach((sense) => {
      addForms(sense.variants ?? []);
      addSenses(sense.subsenses);
    });
  }

  addForms(entry.variants ?? []);
  addForms(entry.derivedForms);
  addSenses(entry.senses);
  [...entry.idioms, ...entry.phrasalVerbs].forEach((phrase) => {
    addForms(phrase.variants);
    addSenses(phrase.senses);
  });
  entry.subentries.forEach((subentry) =>
    collectCanonicalVariantTargetTexts(subentry, counts, signatures),
  );
  return { counts, signatures };
}

type InflectionAuditForm = {
  kind: "inflection" | "inflection-constraint";
  text: string;
  introducer: string;
};

function normalizedSemanticListItem(value: string): string {
  return normalizeReferenceText(value.replace(/^\s*[,;]\s*/, ""));
}

function sourceInflectionFormsFromSequence(value: JsonValue | undefined): InflectionAuditForm[] {
  const forms: InflectionAuditForm[] = [];
  let current: { textItems: Record<string, JsonValue>[]; introducer: string } | undefined;
  let pendingIntroducer: Record<string, JsonValue>[] = [];
  let groupDepth = 0;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = normalizeReferenceText(current.textItems.map(sourceText).join(""));
    if (text) {
      forms.push({ kind: "inflection", text, introducer: current.introducer });
    }
    current = undefined;
  };

  const flushConstraint = (): void => {
    const text = normalizedSemanticListItem(pendingIntroducer.map(sourceText).join(""));
    if (text) {
      forms.push({ kind: "inflection-constraint", text, introducer: "" });
    }
    pendingIntroducer = [];
  };

  for (const item of Array.isArray(value) ? value.filter(isRecord) : []) {
    const tag = sourceText(item.tag).toLocaleLowerCase();
    const path = typeof item.path === "string" ? item.path.toLocaleLowerCase() : "";
    if (tag === "if-gs") {
      const marker = sourceText(item);
      const opens = marker.match(/\(/g)?.length ?? 0;
      const closes = marker.match(/\)/g)?.length ?? 0;
      if (opens && groupDepth === 0) {
        flush();
        flushConstraint();
      }
      groupDepth += opens;
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
      } else {
        current = {
          textItems: [item],
          introducer: normalizedSemanticListItem(pendingIntroducer.map(sourceText).join("")),
        };
        pendingIntroducer = [];
      }
      continue;
    }
    if (tag === "if-g") {
      const text = sourceText(item).trim();
      flush();
      if (text && !/^[,;/().\s]+$/.test(text)) {
        pendingIntroducer.push(item);
      }
      continue;
    }
    if (tag === "ptl" && current) {
      current.textItems.push(item);
    }
  }
  flush();
  flushConstraint();
  return forms;
}

const sourceSemanticScopeBoundaries = new Set([
  "dr_gs",
  "idm_gs",
  "pv_gs",
  "sn_g",
  "unbox",
  "wfg",
  "x_gs",
]);

function isNestedSourceEntry(value: JsonValue): boolean {
  return isRecord(value) &&
    ((typeof value.id === "string" && value.id.length > 0) || isRecord(value.top_data));
}

function collectScopedSourceFields(value: JsonValue, key: string): JsonValue[] {
  const collected: JsonValue[] = [];
  const visit = (current: JsonValue): void => {
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
      if (currentKey === "sngs_data" && Array.isArray(child)) {
        child.forEach((item) => {
          if (!isNestedSourceEntry(item)) {
            visit(item);
          }
        });
        continue;
      }
      if (sourceSemanticScopeBoundaries.has(currentKey)) {
        continue;
      }
      visit(child);
    }
  };
  visit(value);
  return collected;
}

function sourceOwnedInflectionForms(
  raw: JsonValue,
  topData: JsonValue | undefined,
): InflectionAuditForm[] {
  const groups = [
    isRecord(topData) ? topData.top_text : undefined,
    ...collectScopedSourceFields(raw, "v-gs"),
  ]
    .map((group) => sourceInflectionFormsFromSequence(group))
    .filter((group) => group.length);
  const seen = new Set<string>();
  return groups.flatMap((group) => {
    const signature = JSON.stringify(group);
    if (seen.has(signature)) {
      return [];
    }
    seen.add(signature);
    return group;
  });
}

function canonicalInflectionForms(forms: CanonicalForm[]): InflectionAuditForm[] {
  return forms
    .filter((form) => form.kind === "inflection" || form.kind === "inflection-constraint")
    .map((form) => ({
      kind: form.kind as InflectionAuditForm["kind"],
      text: normalizeReferenceText(form.text),
      introducer: normalizeReferenceText(form.introducer?.text ?? ""),
    }));
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

function canonicalTextCounts(values: Array<{ text: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  values.forEach((usage) => {
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
    if (
      (tag === "pron-g" && sourceText(current).trim()) ||
      (parentKey === "pron-g" && [current.phon, current.geo, current.audio, current.form].some(
        (part) => sourceText(part).trim(),
      ))
    ) {
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
      } else if (segment.kind === "pronunciations") {
        counts.pronunciations += segment.items.length;
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
  const tag = sourceText(value.tag).trim().toLocaleLowerCase();
  if (typeof value.audio === "string" && value.audio.trim()) {
    keys.add(value.audio.trim());
  }
  if (tag === "audio") {
    const key = sourceText(value.value).trim();
    if (key) {
      keys.add(key);
    }
  }
  if (tag === "xaudio" && isRecord(value.value)) {
    const key = typeof value.value.url === "string"
      ? value.value.url.trim()
      : typeof value.value.audio === "string"
        ? value.value.audio.trim()
        : "";
    if (key) {
      keys.add(key);
    }
  }
  Object.values(value).forEach((item) => collectSourceAudioKeys(item, keys));
  return keys;
}

function collectSegmentAudioKeys(
  segments: CanonicalBoxSegment[],
  keys: Set<string>,
): void {
  segments.forEach((segment) => {
    if (segment.kind === "example") {
      segment.value.audio.forEach((audio) => keys.add(audio.key));
    } else if (segment.kind === "pronunciations") {
      segment.items.forEach((item) => item.audioKey && keys.add(item.audioKey));
    }
  });
}

function collectBoxAudioKeys(box: CanonicalGrammarUsageBox, keys: Set<string>): void {
  for (const block of box.blocks) {
    if (block.kind === "pronunciations") {
      block.items.forEach((item) => item.audioKey && keys.add(item.audioKey));
    } else if (block.kind === "paragraph") {
      collectSegmentAudioKeys(block.segments, keys);
    } else if (block.kind === "table") {
      block.rows.forEach((row) =>
        row.cells.forEach((cell) => collectSegmentAudioKeys(cell.segments, keys))
      );
    } else if (block.kind === "list") {
      block.items.forEach((item) => collectSegmentAudioKeys(item.segments, keys));
    }
  }
}

function collectSenseAudioKeys(sense: CanonicalSense, keys: Set<string>): void {
  (sense.pronunciations ?? []).forEach((item) => item.audioKey && keys.add(item.audioKey));
  sense.examples.forEach((example) => example.audio.forEach((audio) => keys.add(audio.key)));
  (sense.inflectedForms ?? []).forEach((form) => collectFormAudioKeys(form, keys));
  (sense.variants ?? []).forEach((form) => collectFormAudioKeys(form, keys));
  collectSegmentAudioKeys(sense.definitionSegments ?? [], keys);
  collectSegmentAudioKeys(sense.usageSegments, keys);
  sense.grammarUsageBoxes.forEach((box) => collectBoxAudioKeys(box, keys));
  sense.subsenses.forEach((nested) => collectSenseAudioKeys(nested, keys));
}

function collectFormAudioKeys(form: CanonicalForm, keys: Set<string>): void {
  (form.pronunciations ?? []).forEach((item) => item.audioKey && keys.add(item.audioKey));
  (form.inflectedForms ?? []).forEach((nested) => collectFormAudioKeys(nested, keys));
  (form.variants ?? []).forEach((nested) => collectFormAudioKeys(nested, keys));
  (form.senses ?? []).forEach((sense) => collectSenseAudioKeys(sense, keys));
}

function collectEntryAudioKeys(entry: CanonicalEntry, keys = new Set<string>()): Set<string> {
  entry.pronunciations.forEach((item) => item.audioKey && keys.add(item.audioKey));
  const forms = [
    ...entry.derivedForms,
    ...entry.inflectedForms,
    ...(entry.variants ?? []),
  ];
  forms.forEach((form) => collectFormAudioKeys(form, keys));
  entry.senses.forEach((sense) => collectSenseAudioKeys(sense, keys));
  [...entry.idioms, ...entry.phrasalVerbs].forEach((phrase) => {
    phrase.variants.forEach((form) => collectFormAudioKeys(form, keys));
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

  const isLinkedTarget =
    value.target_id !== undefined ||
    value.word_id !== undefined ||
    value.entry_id !== undefined;
  if (isLinkedTarget) {
    incrementReferenceText(counts, firstNonEmptySourceText(
      value.xh,
      value.xw,
      value.word,
      value.text,
      value.value,
    ));
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
  (form.inflectedForms ?? []).forEach((nested) => collectCanonicalFormReferenceTexts(nested, counts));
  (form.variants ?? []).forEach((nested) => collectCanonicalFormReferenceTexts(nested, counts));
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
  const violationCodeCounts = new Map<string, number>();
  const violations: AuditViolation[] = [];
  let violationCount = 0;
  let sourceEntries = 0;
  let canonicalRootEntries = 0;
  let canonicalEntries = 0;
  let senses = 0;
  let forms = 0;
  let boxes = 0;
  let references = 0;
  let sourceVariantBracketGroups = 0;
  let sourceDerivativeTopTextVariantBracketGroups = 0;
  let sourceSenseVariantBracketGroups = 0;
  let sourceTopTextVariantBracketGroups = 0;
  let sourceVariantTargets = 0;
  let canonicalVariantTargets = 0;
  let variantTargetComparisons = 0;
  let variantPresentationComparisons = 0;
  let inflectionOwnerComparisons = 0;
  let sourceInflectionForms = 0;
  let canonicalInflectionFormsCount = 0;
  const auditedBoxes = new Set<string>();

  const reportViolation = (code: string, entryId: string, detail: string): void => {
    violationCount += 1;
    increment(violationCodeCounts, code);
    if (violations.length < 100) {
      violations.push({ code, entryId, detail });
    }
  };

  const compareTextMultisets = (
    code: string,
    entryId: string,
    owner: string,
    source: Map<string, number>,
    canonical: Map<string, number>,
  ): void => {
    source.forEach((count, text) => {
      const canonicalCount = canonical.get(text) ?? 0;
      if (canonicalCount < count) {
        reportViolation(
          `missing-${code}`,
          entryId,
          `${owner}: ${text}: source=${count}, canonical=${canonicalCount}`,
        );
      }
    });
    canonical.forEach((count, text) => {
      const sourceCount = source.get(text) ?? 0;
      if (sourceCount < count) {
        reportViolation(
          `unexpected-${code}`,
          entryId,
          `${owner}: ${text}: source=${sourceCount}, canonical=${count}`,
        );
      }
    });
  };

  const compareInflections = (
    entryId: string,
    owner: string,
    source: InflectionAuditForm[],
    canonicalForms: CanonicalForm[],
  ): void => {
    const canonical = canonicalInflectionForms(canonicalForms);
    inflectionOwnerComparisons += 1;
    sourceInflectionForms += source.length;
    canonicalInflectionFormsCount += canonical.length;
    if (JSON.stringify(source) !== JSON.stringify(canonical)) {
      reportViolation(
        "inflection-projection-mismatch",
        entryId,
        `${owner}: source=${JSON.stringify(source)}, canonical=${JSON.stringify(canonical)}`,
      );
    }
  };

  const visitLabel = (label: CanonicalLabel, entryId: string): void => {
    const kind = label.kind ?? "<missing>";
    increment(labelKindCounts, kind);
    if (!allowedLabelKinds.has(kind)) {
      reportViolation("unexpected-label-kind", entryId, `${kind}: ${label.text}`);
    }
    if (label.text !== label.text.trim()) {
      reportViolation("label-surrounding-whitespace", entryId, `${kind}: ${JSON.stringify(label.text)}`);
    }
    if (isStructuralSeparator(label.text.trim())) {
      reportViolation("label-leading-structural-separator", entryId, `${kind}: ${label.text}`);
    }
    if (isPureStructuralPunctuation(label.text)) {
      reportViolation("label-pure-structural-punctuation", entryId, `${kind}: ${label.text}`);
    }
    if (hasResidualLabelWrapping(label.text)) {
      reportViolation("label-residual-structural-wrapping", entryId, `${kind}: ${label.text}`);
    }
  };

  const visitSense = (sense: CanonicalSense, entryId: string): void => {
    senses += 1;
    sense.labels.forEach((label) => visitLabel(label, entryId));
    (sense.variants ?? []).forEach((form) => visitForm(form, entryId));
    (sense.inflectedForms ?? []).forEach((form) => visitForm(form, entryId));
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
    const canonicalInlineTexts = canonicalTextCounts(sense.inlineUsage ?? []);
    compareTextMultisets(
      "inline-usage-text",
      entryId,
      sense.id ?? "<sense>",
      sourceInlineTexts,
      canonicalInlineTexts,
    );
    compareInflections(
      entryId,
      sense.id ?? "<sense>",
      sourceOwnedInflectionForms(sense.raw, { top_text: sense.raw.sng_text ?? null }),
      sense.inflectedForms ?? [],
    );
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
    if (kind === "punctuation") {
      reportViolation("renderable-punctuation-cross-reference", entryId, text);
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
    const sourceAudioKeys = collectSourceAudioKeys(box.raw);
    const canonicalAudioKeys = new Set<string>();
    collectBoxAudioKeys(box, canonicalAudioKeys);
    sourceAudioKeys.forEach((key) => {
      if (!canonicalAudioKeys.has(key)) {
        reportViolation("box-audio-key-loss", entryId, `${box.id ?? box.type ?? "<box>"}: ${key}`);
      }
    });
    canonicalAudioKeys.forEach((key) => {
      if (!sourceAudioKeys.has(key)) {
        reportViolation("box-unexpected-audio-key", entryId, `${box.id ?? box.type ?? "<box>"}: ${key}`);
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
    if (form.kind === "inflection" || form.kind === "variant") {
      const introducer = form.introducer?.text;
      if (introducer !== undefined) {
        if (isStructuralSeparator(introducer.trim())) {
          reportViolation("form-introducer-leading-structural-separator", entryId, `${form.kind}: ${introducer}`);
        }
        if (isPureStructuralPunctuation(introducer)) {
          reportViolation("form-introducer-pure-structural-punctuation", entryId, `${form.kind}: ${introducer}`);
        }
      }
    }
    (form.labels ?? []).forEach((label) => visitLabel(label, entryId));
    if (form.kind === "derivative" && isRecord(form.raw)) {
      const topData = isRecord(form.raw.top_g)
        ? form.raw.top_g
        : isRecord(form.raw.top_data)
          ? form.raw.top_data
          : undefined;
      compareTextMultisets(
        "form-inline-usage-text",
        entryId,
        form.id ?? form.text,
        sourceInlineUsageTexts(topData?.top_text),
        canonicalTextCounts(form.usage ?? []),
      );
      compareInflections(
        entryId,
        form.id ?? form.text,
        sourceOwnedInflectionForms(form.raw, topData),
        form.inflectedForms ?? [],
      );
    }
    (form.senses ?? []).forEach((sense) => visitSense(sense, entryId));
    (form.inflectedForms ?? []).forEach((nested) => visitForm(nested, entryId));
    (form.variants ?? []).forEach((variant) => visitForm(variant, entryId));
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
    entry.partsOfSpeech.forEach((part) => {
      if (part.text !== part.text.trim()) {
        reportViolation("part-of-speech-surrounding-whitespace", entry.id, JSON.stringify(part.text));
      }
      if (isStructuralSeparator(part.text)) {
        reportViolation("part-of-speech-leading-structural-separator", entry.id, part.text);
      }
      if (isPureStructuralPunctuation(part.text)) {
        reportViolation("part-of-speech-pure-structural-punctuation", entry.id, part.text);
      }
    });
    const topData = isRecord(entry.raw.top_data) ? entry.raw.top_data : undefined;
    compareTextMultisets(
      "headword-inline-usage-text",
      entry.id,
      "headword",
      sourceInlineUsageTexts(topData?.top_text),
      canonicalTextCounts(entry.headwordUsage ?? []),
    );
    compareInflections(
      entry.id,
      "headword",
      sourceOwnedInflectionForms(entry.raw, topData),
      entry.inflectedForms,
    );
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
        canonicalAudioKeys.forEach((key) => {
          if (!sourceAudioKeys.has(key)) {
            reportViolation("unexpected-audio-key", row.id, key);
          }
        });
        const sourceReferenceTexts = collectSourceCrossReferenceTexts(sourceBody);
        const canonicalReferenceTexts = collectCanonicalEntryCrossReferenceTexts(entry);
        compareTextMultisets(
          "cross-reference-text",
          row.id,
          "entry",
          sourceReferenceTexts,
          canonicalReferenceTexts,
        );
        const sourceVariants = sourceVariantTargetTexts(sourceBody);
        const canonicalVariants = collectCanonicalVariantTargetTexts(entry);
        sourceVariantBracketGroups += sourceVariants.structureCounts.bracketGroups;
        sourceDerivativeTopTextVariantBracketGroups +=
          sourceVariants.structureCounts.derivativeTopTextBracketGroups;
        sourceSenseVariantBracketGroups += sourceVariants.structureCounts.senseBracketGroups;
        sourceTopTextVariantBracketGroups += sourceVariants.structureCounts.topTextBracketGroups;
        sourceVariantTargets += sourceVariants.structureCounts.targets;
        canonicalVariantTargets += [...canonicalVariants.counts.values()]
          .reduce((total, count) => total + count, 0);
        sourceVariants.counts.forEach((count, text) => {
          variantTargetComparisons += 1;
          const canonicalCount = canonicalVariants.counts.get(text) ?? 0;
          if (canonicalCount < count) {
            reportViolation(
              "missing-bracket-variant-form",
              row.id,
              `${text}: source=${count}, canonical=${canonicalCount}`,
            );
          }
        });
        canonicalVariants.counts.forEach((count, text) => {
          const sourceCount = sourceVariants.counts.get(text) ?? 0;
          if (sourceCount < count) {
            reportViolation(
              "unexpected-bracket-variant-form",
              row.id,
              `${text}: source=${sourceCount}, canonical=${count}`,
            );
          }
        });
        sourceVariants.signatures.forEach((count, signature) => {
          variantPresentationComparisons += 1;
          const canonicalCount = canonicalVariants.signatures.get(signature) ?? 0;
          if (canonicalCount < count) {
            reportViolation(
              "missing-ordered-variant-presentation",
              row.id,
              `${signature}: source=${count}, canonical=${canonicalCount}`,
            );
          }
        });
        canonicalVariants.signatures.forEach((count, signature) => {
          const sourceCount = sourceVariants.signatures.get(signature) ?? 0;
          if (sourceCount < count) {
            reportViolation(
              "unexpected-ordered-variant-presentation",
              row.id,
              `${signature}: source=${sourceCount}, canonical=${count}`,
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
    sourceVariantBracketGroups,
    sourceDerivativeTopTextVariantBracketGroups,
    sourceSenseVariantBracketGroups,
    sourceTopTextVariantBracketGroups,
    sourceVariantTargets,
    canonicalVariantTargets,
    variantTargetComparisons,
    variantPresentationComparisons,
    inflectionOwnerComparisons,
    sourceInflectionForms,
    canonicalInflectionForms: canonicalInflectionFormsCount,
    sourceTagCounts: sortedCounts(sourceTagCounts),
    labelKindCounts: sortedCounts(labelKindCounts),
    formKindCounts: sortedCounts(formKindCounts),
    violationCodeCounts: sortedCounts(violationCodeCounts),
    violationCount,
    violations,
  }, null, 2));

  if (violationCount > 0) {
    process.exitCode = 1;
  }
}

main();
