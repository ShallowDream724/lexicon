import { z } from "zod";

import type {
  CanonicalBoxBlock,
  CanonicalBoxSegment,
  CanonicalEntry,
  CanonicalExample,
  CanonicalForm,
  CanonicalGrammarUsageBox,
  CanonicalPhrase,
  CanonicalResourceCategory,
  CanonicalSense,
  CanonicalText,
} from "../../dictionary-schema/src/index";

import {
  isWellFormedUnicode,
  normalizeHeadwordForm,
  projectCanonicalEntryHeadwordForms,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORMS,
} from "./headword-forms";

export {
  projectCanonicalEntryHeadwordForms,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORMS,
} from "./headword-forms";

export const SEARCH_DOCUMENT_SCHEMA_VERSION = "2.2" as const;

export const SEARCH_DOCUMENT_ENGLISH_LOOKUP_KINDS = ["pattern"] as const;

export const SEARCH_DOCUMENT_SCOPES = [
  "sense",
  "phrase",
  "form",
  "example",
  "resource",
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
  form: 60,
  example: 30,
  resource: 60,
} as const;

export const SEARCH_DOCUMENT_SEMANTIC_ROLES = [
  "definition",
  "qualifier",
  "guidance",
  "expression",
  "example",
  "heading",
  "context",
] as const;

export const SEARCH_DOCUMENT_ORIGINS = ["use", "dis-g", "grammar-usage-box"] as const;

export type SearchDocumentScope = (typeof SEARCH_DOCUMENT_SCOPES)[number];
export type SearchDocumentSection = (typeof SEARCH_DOCUMENT_SECTIONS)[number];
export type SearchDocumentSemanticRole = (typeof SEARCH_DOCUMENT_SEMANTIC_ROLES)[number];
export type SearchDocumentOrigin = (typeof SEARCH_DOCUMENT_ORIGINS)[number];
export type SearchDocumentEnglishLookupKind =
  (typeof SEARCH_DOCUMENT_ENGLISH_LOOKUP_KINDS)[number];

export interface SearchDocumentEnglishLookupTerm {
  kind: SearchDocumentEnglishLookupKind;
  text: string;
}

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
  headwordForms?: string[];
  englishLookupTerms?: SearchDocumentEnglishLookupTerm[];
  englishText: string;
  candidateText?: string;
  definitionText?: string;
  chineseText: string;
  semanticRole: SearchDocumentSemanticRole;
  origin?: SearchDocumentOrigin;
  resourceCategory?: CanonicalResourceCategory;
  location: SearchDocumentLocation;
  weight: number;
}

const cjkPattern = /\p{Script=Han}/u;
const utf8Encoder = new TextEncoder();

const headwordFormSchema = z.string()
  .refine((value) => normalizeHeadwordForm(value).length > 0, "Expected a non-empty headword form")
  .refine(isWellFormedUnicode, "Expected valid Unicode")
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES,
    `Expected at most ${SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES} UTF-8 bytes`,
  )
  .refine(
    (value) => utf8Encoder.encode(normalizeHeadwordForm(value)).byteLength <= SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES,
    `Expected at most ${SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES} UTF-8 bytes after normalization`,
  );

const englishLookupTermSchema = z.object({
  kind: z.enum(SEARCH_DOCUMENT_ENGLISH_LOOKUP_KINDS),
  text: z.string().trim().min(1).max(1024),
});

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
  headwordForms: z.array(headwordFormSchema).max(SEARCH_DOCUMENT_MAX_HEADWORD_FORMS).optional(),
  englishLookupTerms: z.array(englishLookupTermSchema).max(64).optional(),
  englishText: z.string(),
  candidateText: z.string().optional(),
  definitionText: z.string().optional(),
  chineseText: z.string().min(1).refine(hasCjkText, "Expected Chinese text"),
  semanticRole: z.enum(SEARCH_DOCUMENT_SEMANTIC_ROLES),
  origin: z.enum(SEARCH_DOCUMENT_ORIGINS).optional(),
  resourceCategory: z.enum([
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
  ]).optional(),
  location: searchDocumentLocationSchema,
  weight: z.number().finite(),
}).superRefine((document, context) => {
  if ((document.scope === "resource") !== (document.resourceCategory !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "Resource documents require resourceCategory; other scopes must omit it",
    });
  }
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

function hasSourceText(value: BilingualSource | undefined): value is BilingualSource {
  return value !== undefined && sourceText(value).trim().length > 0;
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
  headwordForms: string[];
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
  candidateText?: string;
  definitionText?: string;
  chineseText: string;
  semanticRole: SearchDocumentSemanticRole;
  origin?: SearchDocumentOrigin;
  resourceCategory?: CanonicalResourceCategory;
  englishLookupTerms?: SearchDocumentEnglishLookupTerm[];
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
    ...(context.headwordForms.length > 0 ? { headwordForms: context.headwordForms } : {}),
    ...(candidate.englishLookupTerms?.length
      ? { englishLookupTerms: candidate.englishLookupTerms.map((term) => ({ ...term })) }
      : {}),
    englishText: candidate.englishText,
    ...(candidate.candidateText ? { candidateText: candidate.candidateText } : {}),
    ...(candidate.definitionText ? { definitionText: candidate.definitionText } : {}),
    chineseText: candidate.chineseText,
    semanticRole: candidate.semanticRole,
    ...(candidate.origin ? { origin: candidate.origin } : {}),
    ...(candidate.resourceCategory ? { resourceCategory: candidate.resourceCategory } : {}),
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
    document.candidateText ?? "",
    document.definitionText ?? "",
    document.chineseText,
    document.englishLookupTerms ?? [],
  ]);
}

function patternLookupTerms(patterns: readonly CanonicalText[]): SearchDocumentEnglishLookupTerm[] {
  const terms: SearchDocumentEnglishLookupTerm[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const value = normalizeText(pattern.text);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    terms.push({ kind: "pattern", text: value });
  }
  return terms;
}

function addBilingualDocument(
  context: ProjectionContext,
  candidate: Omit<DocumentCandidate, "englishText" | "candidateText" | "definitionText" | "chineseText"> & {
    englishText: BilingualSource;
    chineseText?: BilingualSource;
    candidateText?: BilingualSource;
    definitionText?: BilingualSource;
  },
): void {
  if (!context.documents || context.activeBoxProjection?.emit === false) {
    return;
  }
  const {
    englishText,
    chineseText: chineseSource,
    candidateText,
    definitionText,
    ...metadata
  } = candidate;
  const english = projectCanonicalText(englishText);
  const explicitChinese = chineseSource ? projectCanonicalText(chineseSource) : undefined;
  const chineseText = explicitChinese?.chineseText || (chineseSource ? sourceText(chineseSource) : english.chineseText);
  const projectedCandidate = hasSourceText(candidateText) ? projectCanonicalText(candidateText).englishText : "";
  const projectedDefinition = hasSourceText(definitionText) ? projectCanonicalText(definitionText).englishText : "";
  addDocument(context, {
    ...metadata,
    englishText: english.englishText,
    ...(projectedCandidate ? { candidateText: projectedCandidate } : {}),
    ...(projectedDefinition ? { definitionText: projectedDefinition } : {}),
    chineseText,
  });
}

function addBilingualSemanticDocument(
  context: ProjectionContext,
  candidate: Omit<DocumentCandidate, "englishText" | "candidateText" | "definitionText" | "chineseText"> & {
    englishText: BilingualSource;
    chineseText?: BilingualSource;
    candidateText?: BilingualSource;
    definitionText?: BilingualSource;
    subjectText?: BilingualSource;
  },
): void {
  const { subjectText, ...document } = candidate;
  if (
    hasSourceText(subjectText) &&
    !hasSourceText(document.candidateText) &&
    document.semanticRole !== "heading"
  ) {
    addBilingualDocument(context, {
      ...document,
      candidateText: subjectText,
      definitionText: document.definitionText ?? document.englishText,
    });
    return;
  }
  addBilingualDocument(context, document);
}

interface SegmentProjectionOptions {
  collection?: string;
  scope: Exclude<SearchDocumentScope, "example">;
  semanticRole: SearchDocumentSemanticRole;
  origin?: SearchDocumentOrigin;
  resourceCategory?: CanonicalResourceCategory;
  fallbackChineseText?: CanonicalText;
  subjectText?: BilingualSource;
}

function projectExample(
  context: ProjectionContext,
  example: CanonicalExample,
  section: SearchDocumentSection,
  path: string[],
  part?: string,
  resourceCategory?: CanonicalResourceCategory,
): void {
  indexLocation(context, example, {
    section,
    path,
    part,
    ownerId: example.id,
  });
  addBilingualDocument(context, {
    scope: resourceCategory ? "resource" : "example",
    section,
    path,
    part,
    ownerId: example.id,
    englishText: example.text,
    chineseText: example.translation,
    semanticRole: "example",
    ...(resourceCategory ? { origin: "grammar-usage-box" as const, resourceCategory } : {}),
  });
}

function projectSegments(
  context: ProjectionContext,
  segments: CanonicalBoxSegment[],
  section: SearchDocumentSection,
  path: string[],
  part: string | undefined,
  ownerId: string | undefined,
  options: SegmentProjectionOptions,
): void {
  for (const [index, segment] of segments.entries()) {
    const segmentPath = stablePath(path, options.collection ?? "segments", index);
    if (segment.kind === "text") {
      indexLocation(context, segment, { section, path: segmentPath, part, ownerId });
      const hasOwnChinese = hasCjkText(segment.value.text);
      const hasDirectTerm = hasSourceText(segment.term);
      addBilingualSemanticDocument(context, {
        scope: options.scope,
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: segment.value,
        ...(hasDirectTerm ? { candidateText: segment.term } : {}),
        ...(!hasDirectTerm && hasSourceText(options.subjectText) ? { subjectText: options.subjectText } : {}),
        ...(!hasOwnChinese && hasDirectTerm && options.fallbackChineseText
          ? { chineseText: options.fallbackChineseText }
          : {}),
        semanticRole: hasDirectTerm && options.scope === "resource" ? "expression" : segment.value.origin === "dis-g" ? "qualifier" : segment.value.origin === "use" ? "guidance" : options.semanticRole,
        ...(segment.value.origin ? { origin: segment.value.origin } : options.origin ? { origin: options.origin } : {}),
        ...(options.resourceCategory ? { resourceCategory: options.resourceCategory } : {}),
      });
    } else if (segment.kind === "example") {
      projectExample(context, segment.value, section, segmentPath, part, options.resourceCategory);
    } else if (segment.kind === "term") {
      indexLocation(context, segment, { section, path: segmentPath, part, ownerId });
      const termText = joinCanonicalText(segment.headword, segment.partOfSpeech);
      addBilingualSemanticDocument(context, {
        scope: options.scope,
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: termText,
        candidateText: segment.headword,
        ...(!hasCjkText(termText.text) && options.fallbackChineseText
          ? { chineseText: options.fallbackChineseText }
          : {}),
        semanticRole: options.scope === "resource" ? "expression" : options.semanticRole,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.resourceCategory ? { resourceCategory: options.resourceCategory } : {}),
      });
    }
  }
}

function projectGrammarUsageBox(
  context: ProjectionContext,
  box: CanonicalGrammarUsageBox,
  path: string[],
  part?: string,
  subjectText?: BilingualSource,
): void {
  const boxOwnerId = box.id;
  const resourceCategory = box.resourceCategory ?? "other";
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
    addBilingualSemanticDocument(context, {
      scope: "resource",
      section: "grammar-usage",
      path: [...path, "title"],
      part,
      ownerId: boxOwnerId,
      englishText: box.title,
      semanticRole: "heading",
      origin: "grammar-usage-box",
      resourceCategory,
    });
  }

  let fallbackChineseText = box.title && hasCjkText(box.title.text) ? box.title : undefined;
  for (const [blockIndex, block] of box.blocks.entries()) {
    if (block.kind === "heading" && hasCjkText(block.value.text)) {
      fallbackChineseText = block.value;
    }
    projectGrammarUsageBlock(
      context,
      block,
      stablePath(path, "blocks", blockIndex),
      boxOwnerId,
      part,
      fallbackChineseText,
      subjectText,
      resourceCategory,
    );
    if (block.kind === "paragraph" && hasCjkText(block.value.text)) {
      fallbackChineseText = block.value;
    }
  }
  context.activeBoxProjection = priorProjection;
}

function projectGrammarUsageBlock(
  context: ProjectionContext,
  block: CanonicalBoxBlock,
  path: string[],
  ownerId?: string,
  part?: string,
  fallbackChineseText?: CanonicalText,
  subjectText?: BilingualSource,
  resourceCategory: CanonicalResourceCategory = "other",
): void {
  if (block.kind === "heading") {
    indexLocation(context, block, {
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
    });
    addBilingualSemanticDocument(context, {
      scope: "resource",
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
      englishText: block.value,
      semanticRole: "heading",
      origin: "grammar-usage-box",
      resourceCategory,
    });
    return;
  }

  if (block.kind === "unknown") {
    indexLocation(context, block, {
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
    });
    addBilingualSemanticDocument(context, {
      scope: "resource",
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
      englishText: block.value,
      semanticRole: "context",
      origin: "grammar-usage-box",
      resourceCategory,
      ...(subjectText ? { subjectText } : {}),
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
      addBilingualSemanticDocument(context, {
        scope: "resource",
        section: "grammar-usage",
        path: [...path, "value"],
        part,
        ownerId,
        englishText: block.value,
        semanticRole: "context",
        origin: "grammar-usage-box",
        resourceCategory,
        ...(subjectText ? { subjectText } : {}),
      });
    }
    projectSegments(context, block.segments, "grammar-usage", path, part, ownerId, {
      scope: "resource",
      semanticRole: "context",
      origin: "grammar-usage-box",
      resourceCategory,
      fallbackChineseText,
      subjectText,
    });
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
        {
          scope: "resource",
          semanticRole: "context",
          origin: "grammar-usage-box",
          resourceCategory,
          fallbackChineseText,
          subjectText,
        },
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
          addBilingualSemanticDocument(context, {
            scope: "resource",
            section: "grammar-usage",
            path: [...cellPath, "value"],
            part,
            ownerId,
            englishText: cell.value,
            semanticRole: "context",
            origin: "grammar-usage-box",
            resourceCategory,
            ...(subjectText ? { subjectText } : {}),
          });
        }
        projectSegments(context, cell.segments, "grammar-usage", cellPath, part, ownerId, {
          scope: "resource",
          semanticRole: "context",
          origin: "grammar-usage-box",
          resourceCategory,
          fallbackChineseText,
          subjectText,
        });
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
  usageSubject?: BilingualSource,
  inheritedPatterns: readonly CanonicalText[] = [],
): void {
  const part = sense.partOfSpeech ?? inheritedPart;
  const senseOwnerId = phraseOwnerId ?? sense.id;
  indexLocation(context, sense, {
    section,
    path,
    part,
    ownerId: senseOwnerId,
  });
  if (sense.groupHeading) {
    const headingPath = [...path, "groupHeading"];
    indexLocation(context, sense.groupHeading, {
      section,
      path: headingPath,
      part,
      ownerId: senseOwnerId,
    });
    addBilingualDocument(context, {
      scope: phraseHeading ? "phrase" : "sense",
      section,
      path: headingPath,
      part,
      ownerId: senseOwnerId,
      englishText: sense.groupHeading,
      semanticRole: "qualifier",
    });
  }
  addBilingualDocument(context, {
    scope: phraseHeading ? "phrase" : "sense",
    section,
    path,
    part,
    ownerId: senseOwnerId,
    englishText: joinCanonicalText(phraseHeading, sense.definition),
    ...(phraseHeading ? { candidateText: phraseHeading, definitionText: sense.definition } : {}),
    chineseText: sense.translation,
    semanticRole: "definition",
    englishLookupTerms: patternLookupTerms([
      ...inheritedPatterns,
      ...(sense.patterns ?? []),
    ]),
  });

  for (const [index, usage] of (sense.inlineUsage ?? []).entries()) {
    const usagePath = stablePath(path, "inlineUsage", index);
    indexLocation(context, usage, { section, path: usagePath, part, ownerId: sense.id });
    addBilingualSemanticDocument(context, {
      scope: phraseHeading ? "phrase" : "sense",
      section,
      path: usagePath,
      part,
      ownerId: sense.id,
      englishText: usage,
      ...(usageSubject ? { subjectText: usageSubject } : {}),
      semanticRole: usage.origin === "dis-g" ? "qualifier" : "guidance",
      ...(usage.origin ? { origin: usage.origin } : {}),
    });
  }
  for (const [index, usage] of sense.usage.entries()) {
    const usagePath = stablePath(path, "usage", index);
    indexLocation(context, usage, { section, path: usagePath, part, ownerId: sense.id });
    addBilingualSemanticDocument(context, {
      scope: phraseHeading ? "phrase" : "sense",
      section,
      path: usagePath,
      part,
      ownerId: sense.id,
      englishText: usage,
      ...(usageSubject ? { subjectText: usageSubject } : {}),
      semanticRole: usage.origin === "dis-g" ? "qualifier" : "guidance",
      ...(usage.origin ? { origin: usage.origin } : {}),
    });
  }
  projectSegments(context, sense.definitionSegments ?? [], section, path, part, sense.id, {
    collection: "definitionSegments",
    scope: phraseHeading ? "phrase" : "sense",
    semanticRole: "definition",
    subjectText: usageSubject,
  });
  projectSegments(context, sense.usageSegments ?? [], section, path, part, sense.id, {
    collection: "usageSegments",
    scope: phraseHeading ? "phrase" : "sense",
    semanticRole: "guidance",
    subjectText: usageSubject,
  });

  for (const [index, example] of sense.examples.entries()) {
    projectExample(context, example, section, stablePath(path, "examples", index), part);
  }
  for (const [index, box] of sense.grammarUsageBoxes.entries()) {
    projectGrammarUsageBox(context, box, stablePath(path, "grammarUsageBoxes", index), part, usageSubject);
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
      usageSubject,
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
    addBilingualSemanticDocument(context, {
      scope: "phrase",
      section,
      path: usagePath,
      part: inheritedPart,
      ownerId: phrase.id,
      englishText: usage,
      subjectText: phrase.display,
      semanticRole: usage.origin === "dis-g" ? "qualifier" : "guidance",
      ...(usage.origin ? { origin: usage.origin } : {}),
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
      phrase.display,
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
      semanticRole: "definition",
    });
    for (const [usageIndex, usage] of (form.usage ?? []).entries()) {
      const usagePath = stablePath(formPath, "usage", usageIndex);
      indexLocation(context, usage, {
        section,
        path: usagePath,
        part,
        ownerId: form.id,
      });
      addBilingualSemanticDocument(context, {
        scope: "form",
        section,
        path: usagePath,
        part,
        ownerId: form.id,
        englishText: usage,
        subjectText: form.text,
        semanticRole: usage.origin === "dis-g" ? "qualifier" : "guidance",
        ...(usage.origin ? { origin: usage.origin } : {}),
      });
    }
    projectForms(context, form.variants ?? [], section, [...formPath, "variants"], part);
    projectForms(context, form.inflectedForms ?? [], section, [...formPath, "inflectedForms"], part);
    for (const [senseIndex, sense] of (form.senses ?? []).entries()) {
      projectSense(
        context,
        sense,
        section,
        stablePath(formPath, "senses", senseIndex),
        undefined,
        undefined,
        part,
        form.text,
      );
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

function nestedEntryUsageSubject(context: ProjectionContext, entry: CanonicalEntry): string | undefined {
  const subject = entry.displayHeadword || entry.headword;
  return normalizeHeadwordForm(entry.headword).toLocaleLowerCase() ===
    normalizeHeadwordForm(context.headword).toLocaleLowerCase()
    ? undefined
    : subject;
}

function projectEntry(
  context: ProjectionContext,
  entry: CanonicalEntry,
  path: string[],
  inheritedPart?: string,
  usageSubject?: BilingualSource,
): void {
  const part = entryPart(entry, inheritedPart);
  for (const [index, usage] of (entry.headwordUsage ?? []).entries()) {
    const usagePath = stablePath(path, "headwordUsage", index);
    indexLocation(context, usage, {
      section: "definitions",
      path: usagePath,
      part,
    });
    addBilingualSemanticDocument(context, {
      scope: "sense",
      section: "definitions",
      path: usagePath,
      part,
      englishText: usage,
      ...(usageSubject ? { subjectText: usageSubject } : {}),
      semanticRole: usage.origin === "dis-g" ? "qualifier" : "guidance",
      ...(usage.origin ? { origin: usage.origin } : {}),
    });
  }
  for (const [index, sense] of entry.senses.entries()) {
    projectSense(
      context,
      sense,
      "definitions",
      stablePath(path, "senses", index),
      undefined,
      undefined,
      part,
      usageSubject,
      entry.headwordPatterns ?? [],
    );
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
    projectGrammarUsageBox(context, box, stablePath(path, "grammarUsageBoxes", index), part, usageSubject);
  }
  for (const [index, subentry] of entry.subentries.entries()) {
    projectEntry(
      context,
      subentry,
      stablePath(path, "subentries", index),
      part,
      nestedEntryUsageSubject(context, subentry),
    );
  }
}

/** Projects already-validated canonical dictionary content into reverse-search documents. */
export function projectCanonicalEntrySearchDocuments(entry: CanonicalEntry): SearchDocument[] {
  const context: ProjectionContext = {
    dictionaryId: entry.dictionaryId,
    entryId: entry.id,
    headword: entry.headword,
    headwordForms: projectCanonicalEntryHeadwordForms(entry),
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
    headwordForms: [],
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
