import { z } from "zod";

import type {
  CanonicalBoxBlock,
  CanonicalBoxSegment,
  CanonicalEntry,
  CanonicalExample,
  CanonicalForm,
  CanonicalGrammarUsageBox,
  CanonicalPhrase,
  CanonicalSense,
  CanonicalText,
} from "../../dictionary-schema/src/index";

export const SEARCH_DOCUMENT_SCHEMA_VERSION = "1.2" as const;

export const SEARCH_DOCUMENT_SCOPES = [
  "sense",
  "phrase",
  "form",
  "usage",
  "example",
] as const;

export const SEARCH_DOCUMENT_SECTIONS = [
  "definitions",
  "idioms",
  "phrasal-verbs",
  "derived-forms",
  "grammar-usage",
] as const;

export const SEARCH_DOCUMENT_WEIGHTS = {
  sense: 160,
  phrase: 160,
  usage: 60,
  form: 60,
  example: 30,
} as const;

export type SearchDocumentScope = (typeof SEARCH_DOCUMENT_SCOPES)[number];
export type SearchDocumentSection = (typeof SEARCH_DOCUMENT_SECTIONS)[number];

export interface SearchDocumentLocation {
  section: SearchDocumentSection;
  part?: string;
  ownerId?: string;
  path: string[];
}

export interface SearchDocument {
  dictionaryId: string;
  entryId: string;
  scope: SearchDocumentScope;
  headword: string;
  englishText: string;
  chineseText: string;
  location: SearchDocumentLocation;
  weight: number;
}

const cjkPattern = /\p{Script=Han}/u;

export const searchDocumentLocationSchema = z.object({
  section: z.enum(SEARCH_DOCUMENT_SECTIONS),
  part: z.string().optional(),
  ownerId: z.string().optional(),
  path: z.array(z.string()),
});

export const searchDocumentSchema = z.object({
  dictionaryId: z.string().min(1),
  entryId: z.string().min(1),
  scope: z.enum(SEARCH_DOCUMENT_SCOPES),
  headword: z.string(),
  englishText: z.string(),
  chineseText: z.string().min(1).refine(hasCjkText, "Expected Chinese text"),
  location: searchDocumentLocationSchema,
  weight: z.number().finite(),
});

export const searchDocumentsSchema = z.array(searchDocumentSchema);

function hasCjkText(text: string): boolean {
  return cjkPattern.test(text) && text.replace(/\s+/gu, "").length > 0;
}

function textValue(text: CanonicalText | undefined): string {
  return text?.text ?? "";
}

function stablePath(path: readonly string[], collection: string, index: number): string[] {
  return [...path, collection, String(index)];
}

function joinText(...values: string[]): string {
  return values.filter((value) => value.trim().length > 0).join(" ").trim();
}

type BilingualSource = CanonicalText | string;

interface BilingualProjection {
  englishText: string;
  chineseText: string;
}

function sourceText(value: BilingualSource): string {
  return typeof value === "string" ? value : value.text;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isCjkPunctuation(value: string): boolean {
  return /[，。！？；：、】【、】【（）《》〈〉「」『』]/u.test(value);
}

function splitUnstructuredText(value: string): BilingualProjection {
  const english: string[] = [];
  const chinese: string[] = [];
  const units = Array.from(value);
  let pending = "";
  let previous: "english" | "chinese" | undefined;

  const nextLanguage = (from: number): "english" | "chinese" | undefined => {
    for (let index = from; index < units.length; index += 1) {
      if (cjkPattern.test(units[index]!)) return "chinese";
      if (!/\s/u.test(units[index]!) && !isCjkPunctuation(units[index]!)) return "english";
    }
    return undefined;
  };
  const append = (language: "english" | "chinese", content: string): void => {
    (language === "english" ? english : chinese).push(content);
  };

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const language = cjkPattern.test(unit)
      ? "chinese"
      : isCjkPunctuation(unit)
        ? "chinese"
        : /\s/u.test(unit)
          ? undefined
          : "english";
    if (!language) {
      pending += unit;
      continue;
    }
    if (pending) {
      append(language === "chinese" || previous === "chinese" || nextLanguage(index) === "chinese" ? "chinese" : "english", pending);
      pending = "";
    }
    append(language, unit);
    previous = language;
  }
  if (pending) append(previous ?? "english", pending);
  return { englishText: normalizeText(english.join("")), chineseText: normalizeText(chinese.join("")) };
}

function projectCanonicalText(value: BilingualSource): BilingualProjection {
  if (typeof value === "string") return splitUnstructuredText(value);
  if (value.tokens.length === 0) return splitUnstructuredText(value.text);

  const english: string[] = [];
  const chinese: string[] = [];
  let englishBoundary = false;
  let chineseBoundary = false;
  const append = (parts: string[], text: string, boundary: boolean): boolean => {
    if (!text) return boundary;
    if (boundary && parts.length > 0) parts.push(" ");
    parts.push(text);
    return false;
  };
  for (const token of value.tokens) {
    const tag = token.tag?.toLocaleLowerCase();
    if (tag === "custom-br" || !token.text.trim()) {
      englishBoundary = true;
      chineseBoundary = true;
      continue;
    }

    let projection: BilingualProjection;
    if (tag === "simp" || tag === "trad" || tag === "zh" || tag === "zho") {
      projection = { englishText: "", chineseText: token.text };
    } else if (tag === "eng" || tag === "en") {
      projection = { englishText: token.text, chineseText: "" };
    } else {
      projection = splitUnstructuredText(token.text);
    }
    englishBoundary = append(english, projection.englishText, englishBoundary);
    chineseBoundary = append(chinese, projection.chineseText, chineseBoundary);
  }
  return { englishText: normalizeText(english.join("")), chineseText: normalizeText(chinese.join("")) };
}

function joinCanonicalText(...values: Array<CanonicalText | undefined>): CanonicalText {
  const present = values.filter((value): value is CanonicalText => Boolean(value && value.text.trim()));
  return {
    text: present.map((value) => value.text).join(" "),
    tokens: present.every((value) => value.tokens.length > 0)
      ? present.flatMap((value, index) => index === 0 ? value.tokens : [{ text: " ", raw: {} }, ...value.tokens])
      : [],
    raw: {},
  };
}

interface ProjectionContext {
  dictionaryId: string;
  entryId: string;
  headword: string;
  entryWeight: number;
  documents?: SearchDocument[];
  documentsBySignature?: Map<string, SearchDocument>;
  locations?: WeakMap<object, SearchDocumentLocation>;
  boxProjections?: Map<string, BoxProjection>;
  activeBoxProjection?: BoxProjection;
}

interface BoxProjection {
  path: string[];
  documents: SearchDocument[];
  emit: boolean;
}

interface DocumentCandidate {
  scope: SearchDocumentScope;
  section: SearchDocumentSection;
  path: string[];
  englishText: string;
  chineseText: string;
  part?: string;
  ownerId?: string;
}

export interface CanonicalSearchLocationIndex {
  get(value: object): SearchDocumentLocation | undefined;
}

function candidateLocation(candidate: Pick<DocumentCandidate, "section" | "path" | "part" | "ownerId">): SearchDocumentLocation {
  return {
    section: candidate.section,
    ...(candidate.part ? { part: candidate.part } : {}),
    ...(candidate.ownerId ? { ownerId: candidate.ownerId } : {}),
    path: [...candidate.path],
  };
}

function indexLocation(
  context: ProjectionContext,
  value: object,
  candidate: Pick<DocumentCandidate, "section" | "path" | "part" | "ownerId">,
): void {
  const location = candidateLocation(candidate);
  const current = context.locations?.get(value);
  if (!current || location.path.length > current.path.length) {
    context.locations?.set(value, location);
  }
}

function addDocument(context: ProjectionContext, candidate: DocumentCandidate): void {
  if (!context.documents || !context.documentsBySignature || !hasCjkText(candidate.chineseText)) {
    return;
  }

  const document: SearchDocument = {
    dictionaryId: context.dictionaryId,
    entryId: context.entryId,
    scope: candidate.scope,
    headword: context.headword,
    englishText: candidate.englishText,
    chineseText: candidate.chineseText,
    location: candidateLocation(candidate),
    weight: SEARCH_DOCUMENT_WEIGHTS[candidate.scope] + context.entryWeight,
  };
  const signature = documentSignature(document);
  const existing = context.documentsBySignature.get(signature);
  if (!existing) {
    context.documentsBySignature.set(signature, document);
    context.documents.push(document);
    context.activeBoxProjection?.documents.push(document);
  } else if (documentLocationPriority(document) > documentLocationPriority(existing)) {
    Object.assign(existing, document);
  }
}

function documentLocationPriority(document: SearchDocument): number {
  const structuredSegment = document.location.path.some((part) =>
    part === "segments" || part.endsWith("Segments"),
  );
  return document.location.path.length * 2 + (structuredSegment ? 1 : 0);
}

function documentSignature(document: SearchDocument): string {
  return JSON.stringify([
    document.scope,
    document.location.section,
    document.location.part ?? "",
    document.location.ownerId || document.location.path,
    document.englishText,
    document.chineseText,
  ]);
}

function addBilingualDocument(
  context: ProjectionContext,
  candidate: Omit<DocumentCandidate, "englishText" | "chineseText"> & {
    englishText: BilingualSource;
    chineseText?: BilingualSource;
  },
): void {
  if (!context.documents || context.activeBoxProjection?.emit === false) {
    return;
  }
  const english = projectCanonicalText(candidate.englishText);
  const explicitChinese = candidate.chineseText ? projectCanonicalText(candidate.chineseText) : undefined;
  const chineseText = explicitChinese?.chineseText || (candidate.chineseText ? sourceText(candidate.chineseText) : english.chineseText);
  addDocument(context, { ...candidate, englishText: english.englishText, chineseText });
}

function projectExample(
  context: ProjectionContext,
  example: CanonicalExample,
  section: SearchDocumentSection,
  path: string[],
  part?: string,
): void {
  indexLocation(context, example, {
    section,
    path,
    part,
    ownerId: example.id,
  });
  addBilingualDocument(context, {
    scope: "example",
    section,
    path,
    part,
    ownerId: example.id,
    englishText: example.text,
    chineseText: example.translation,
  });
}

function projectSegments(
  context: ProjectionContext,
  segments: CanonicalBoxSegment[],
  section: SearchDocumentSection,
  path: string[],
  part?: string,
  ownerId?: string,
  collection = "segments",
): void {
  for (const [index, segment] of segments.entries()) {
    const segmentPath = stablePath(path, collection, index);
    if (segment.kind === "text") {
      indexLocation(context, segment, { section, path: segmentPath, part, ownerId });
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: segment.value,
      });
    } else if (segment.kind === "example") {
      projectExample(context, segment.value, section, segmentPath, part);
    } else if (segment.kind === "term") {
      indexLocation(context, segment, { section, path: segmentPath, part, ownerId });
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: joinCanonicalText(segment.headword, segment.partOfSpeech),
      });
    }
  }
}

function projectGrammarUsageBox(
  context: ProjectionContext,
  box: CanonicalGrammarUsageBox,
  path: string[],
  part?: string,
): void {
  const boxOwnerId = box.id;
  indexLocation(context, box, {
    section: "grammar-usage",
    path,
    part,
    ownerId: boxOwnerId,
  });
  const boxKey = box.id?.trim();
  const previous = boxKey ? context.boxProjections?.get(boxKey) : undefined;
  const emit = !previous || path.length > previous.path.length;
  if (emit && previous) {
    const removed = new Set(previous.documents);
    context.documents = context.documents?.filter((document) => !removed.has(document));
    for (const document of previous.documents) {
      const signature = documentSignature(document);
      if (context.documentsBySignature?.get(signature) === document) {
        context.documentsBySignature.delete(signature);
      }
    }
  }
  const projection: BoxProjection = { path: [...path], documents: [], emit };
  if (boxKey && emit) context.boxProjections?.set(boxKey, projection);
  const priorProjection = context.activeBoxProjection;
  context.activeBoxProjection = projection;
  if (box.title) {
    addBilingualDocument(context, {
      scope: "usage",
      section: "grammar-usage",
      path: [...path, "title"],
      part,
      ownerId: boxOwnerId,
      englishText: box.title,
    });
  }

  for (const [blockIndex, block] of box.blocks.entries()) {
    projectGrammarUsageBlock(
      context,
      block,
      stablePath(path, "blocks", blockIndex),
      boxOwnerId,
      part,
    );
  }
  context.activeBoxProjection = priorProjection;
}

function projectGrammarUsageBlock(
  context: ProjectionContext,
  block: CanonicalBoxBlock,
  path: string[],
  ownerId?: string,
  part?: string,
): void {
  if (block.kind === "heading" || block.kind === "unknown") {
    indexLocation(context, block, {
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
    });
    addBilingualDocument(context, {
      scope: "usage",
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
      englishText: block.value,
    });
    return;
  }

  if (block.kind === "paragraph") {
    indexLocation(context, block, {
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
    });
    if (block.segments.length === 0) {
      addBilingualDocument(context, {
        scope: "usage",
        section: "grammar-usage",
        path: [...path, "value"],
        part,
        ownerId,
        englishText: block.value,
      });
    }
    projectSegments(context, block.segments, "grammar-usage", path, part, ownerId);
    return;
  }

  if (block.kind === "list") {
    for (const [itemIndex, item] of block.items.entries()) {
      projectSegments(
        context,
        item.segments,
        "grammar-usage",
        stablePath(path, "items", itemIndex),
        part,
        ownerId,
      );
    }
    return;
  }

  if (block.kind === "table") {
    for (const [rowIndex, row] of block.rows.entries()) {
      const rowPath = stablePath(path, "rows", rowIndex);
      for (const [cellIndex, cell] of row.cells.entries()) {
        const cellPath = stablePath(rowPath, "cells", cellIndex);
        if (cell.segments.length === 0) {
          addBilingualDocument(context, {
            scope: "usage",
            section: "grammar-usage",
            path: [...cellPath, "value"],
            part,
            ownerId,
            englishText: cell.value,
          });
        }
        projectSegments(context, cell.segments, "grammar-usage", cellPath, part, ownerId);
      }
    }
  }
}

function projectSense(
  context: ProjectionContext,
  sense: CanonicalSense,
  section: SearchDocumentSection,
  path: string[],
  phraseHeading?: CanonicalText,
  phraseOwnerId?: string,
	  inheritedPart?: string,
): void {
  const part = sense.partOfSpeech ?? inheritedPart;
  const senseOwnerId = phraseOwnerId ?? sense.id;
  indexLocation(context, sense, {
    section,
    path,
    part,
    ownerId: senseOwnerId,
  });
  addBilingualDocument(context, {
    scope: phraseHeading ? "phrase" : "sense",
    section,
    path,
    part,
    ownerId: senseOwnerId,
    englishText: joinCanonicalText(phraseHeading, sense.definition),
    chineseText: sense.translation,
  });

  for (const [index, usage] of (sense.inlineUsage ?? []).entries()) {
    const usagePath = stablePath(path, "inlineUsage", index);
    indexLocation(context, usage, { section, path: usagePath, part, ownerId: sense.id });
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: usagePath,
      part,
      ownerId: sense.id,
      englishText: usage,
    });
  }
  for (const [index, usage] of sense.usage.entries()) {
    const usagePath = stablePath(path, "usage", index);
    indexLocation(context, usage, { section, path: usagePath, part, ownerId: sense.id });
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: usagePath,
      part,
      ownerId: sense.id,
      englishText: usage,
    });
  }
  projectSegments(context, sense.definitionSegments ?? [], section, path, part, sense.id, "definitionSegments");
  projectSegments(context, sense.usageSegments ?? [], section, path, part, sense.id, "usageSegments");

  for (const [index, example] of sense.examples.entries()) {
    projectExample(context, example, section, stablePath(path, "examples", index), part);
  }
  for (const [index, box] of sense.grammarUsageBoxes.entries()) {
    projectGrammarUsageBox(context, box, stablePath(path, "grammarUsageBoxes", index), part);
  }
  projectForms(context, sense.variants ?? [], section, [...path, "variants"], part);
  projectForms(context, sense.inflectedForms ?? [], section, [...path, "inflectedForms"], part);
  for (const [index, subsense] of sense.subsenses.entries()) {
	    projectSense(
	      context,
	      subsense,
	      section,
	      stablePath(path, "subsenses", index),
	      phraseHeading,
	      phraseOwnerId,
	      part,
	    );
  }
}

function projectPhrase(
  context: ProjectionContext,
  phrase: CanonicalPhrase,
  section: Extract<SearchDocumentSection, "idioms" | "phrasal-verbs">,
  path: string[],
	  inheritedPart?: string,
): void {
  indexLocation(context, phrase, {
    section,
    path,
    part: inheritedPart,
    ownerId: phrase.id,
  });
  for (const [index, usage] of phrase.leadingUsage.entries()) {
    const usagePath = stablePath(path, "leadingUsage", index);
    indexLocation(context, usage, {
      section,
      path: usagePath,
      part: inheritedPart,
      ownerId: phrase.id,
    });
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: usagePath,
      ownerId: phrase.id,
      englishText: usage,
    });
  }
  projectForms(context, phrase.variants, section, [...path, "variants"]);
  for (const [index, sense] of phrase.senses.entries()) {
    projectSense(
      context,
      sense,
      section,
      stablePath(path, "senses", index),
      phrase.display,
      phrase.id,
	      inheritedPart,
    );
  }
}

function projectForms(
  context: ProjectionContext,
  forms: CanonicalForm[],
  section: SearchDocumentSection,
  path: string[],
  inheritedPart?: string,
): void {
  for (const [index, form] of forms.entries()) {
    const formPath = [...path, String(index)];
    const part = form.partOfSpeech ?? inheritedPart;
    indexLocation(context, form, {
      section,
      path: formPath,
      part,
      ownerId: form.id,
    });
    addBilingualDocument(context, {
      scope: "form",
      section,
      path: formPath,
      part,
      ownerId: form.id,
      englishText: joinText(form.text, textValue(form.note)),
    });
    for (const [usageIndex, usage] of (form.usage ?? []).entries()) {
      const usagePath = stablePath(formPath, "usage", usageIndex);
      indexLocation(context, usage, {
        section,
        path: usagePath,
        part,
        ownerId: form.id,
      });
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: usagePath,
        part,
        ownerId: form.id,
        englishText: usage,
      });
    }
    projectForms(context, form.variants ?? [], section, [...formPath, "variants"], part);
    projectForms(context, form.inflectedForms ?? [], section, [...formPath, "inflectedForms"], part);
    for (const [senseIndex, sense] of (form.senses ?? []).entries()) {
	      projectSense(context, sense, section, stablePath(formPath, "senses", senseIndex), undefined, undefined, part);
    }
  }
}


function entryPart(entry: CanonicalEntry, inheritedPart?: string): string | undefined {
	  const parts = entry.partsOfSpeech.map((part) => part.text.trim()).filter(Boolean);
	  return parts.length === 1 ? parts[0] : inheritedPart;
}

const cefrSearchWeights: Readonly<Record<string, number>> = {
  A1: 160,
  A2: 120,
  B1: 85,
  B2: 50,
  C1: 25,
  C2: 10,
};

function entrySearchWeight(entry: CanonicalEntry): number {
  let levelWeight = 0;
  let frequencyWeight = 0;
  for (const label of entry.labels) {
    if (label.kind === "level") {
      levelWeight = Math.max(levelWeight, cefrSearchWeights[label.text.trim().toUpperCase()] ?? 0);
    } else if (label.kind === "frequency") {
      const value = label.text.replace(/\D/gu, "");
      frequencyWeight = Math.max(frequencyWeight, value === "3000" ? 40 : value === "5000" ? 20 : 0);
    }
  }
  return levelWeight + frequencyWeight;
}

function projectEntry(
	context: ProjectionContext,
	entry: CanonicalEntry,
	path: string[],
	inheritedPart?: string,
): void {
	  const part = entryPart(entry, inheritedPart);
  for (const [index, usage] of (entry.headwordUsage ?? []).entries()) {
    const usagePath = stablePath(path, "headwordUsage", index);
    indexLocation(context, usage, {
      section: "definitions",
      path: usagePath,
      part,
    });
    addBilingualDocument(context, {
      scope: "usage",
      section: "definitions",
      path: usagePath,
	      part,
      englishText: usage,
    });
  }
  for (const [index, sense] of entry.senses.entries()) {
	    projectSense(context, sense, "definitions", stablePath(path, "senses", index), undefined, undefined, part);
  }
  for (const [index, phrase] of entry.idioms.entries()) {
	    projectPhrase(context, phrase, "idioms", stablePath(path, "idioms", index), part);
  }
  for (const [index, phrase] of entry.phrasalVerbs.entries()) {
	    projectPhrase(context, phrase, "phrasal-verbs", stablePath(path, "phrasalVerbs", index), part);
  }
	  projectForms(context, entry.derivedForms, "derived-forms", [...path, "derivedForms"], part);
	  projectForms(context, entry.inflectedForms, "derived-forms", [...path, "inflectedForms"], part);
	  projectForms(context, entry.variants ?? [], "derived-forms", [...path, "variants"], part);
  for (const [index, box] of entry.grammarUsageBoxes.entries()) {
	    projectGrammarUsageBox(context, box, stablePath(path, "grammarUsageBoxes", index), part);
  }
  for (const [index, subentry] of entry.subentries.entries()) {
	    projectEntry(context, subentry, stablePath(path, "subentries", index), part);
  }
}

/** Projects already-validated canonical dictionary content into reverse-search documents. */
export function projectCanonicalEntrySearchDocuments(entry: CanonicalEntry): SearchDocument[] {
  const context: ProjectionContext = {
    dictionaryId: entry.dictionaryId,
    entryId: entry.id,
    headword: entry.headword,
    entryWeight: entrySearchWeight(entry),
    documents: [],
    documentsBySignature: new Map<string, SearchDocument>(),
    boxProjections: new Map<string, BoxProjection>(),
  };
  projectEntry(context, entry, []);
  return context.documents ?? [];
}

/** Builds a lightweight object-to-location index using the same traversal as the sidecar projector. */
export function indexCanonicalEntrySearchLocations(entry: CanonicalEntry): CanonicalSearchLocationIndex {
  const locations = new WeakMap<object, SearchDocumentLocation>();
  const context: ProjectionContext = {
    dictionaryId: entry.dictionaryId,
    entryId: entry.id,
    headword: entry.headword,
    entryWeight: 0,
    locations,
  };
  projectEntry(context, entry, []);
  return {
    get(value: object): SearchDocumentLocation | undefined {
      const location = locations.get(value);
      return location ? { ...location, path: [...location.path] } : undefined;
    },
  };
}
