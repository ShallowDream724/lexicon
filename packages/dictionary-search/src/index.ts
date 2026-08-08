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

export const SEARCH_DOCUMENT_SCHEMA_VERSION = "1.0" as const;

export const SEARCH_DOCUMENT_SCOPES = [
  "sense",
  "phrase",
  "example",
  "usage",
  "form",
] as const;

export const SEARCH_DOCUMENT_SECTIONS = [
  "definitions",
  "idioms",
  "phrasal-verbs",
  "derived-forms",
  "grammar-usage",
] as const;

export const SEARCH_DOCUMENT_WEIGHTS = {
  sense: 100,
  phrase: 100,
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

function nonCjkProjection(text: string): string {
  return text.replace(/\p{Script=Han}/gu, "").replace(/\s+/gu, " ").trim();
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

interface ProjectionContext {
  dictionaryId: string;
  entryId: string;
  headword: string;
  documents: SearchDocument[];
  signatures: Set<string>;
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

function addDocument(context: ProjectionContext, candidate: DocumentCandidate): void {
  if (!hasCjkText(candidate.chineseText)) {
    return;
  }

  const document: SearchDocument = {
    dictionaryId: context.dictionaryId,
    entryId: context.entryId,
    scope: candidate.scope,
    headword: context.headword,
    englishText: candidate.englishText,
    chineseText: candidate.chineseText,
    location: {
      section: candidate.section,
      ...(candidate.part ? { part: candidate.part } : {}),
      ...(candidate.ownerId ? { ownerId: candidate.ownerId } : {}),
      path: candidate.path,
    },
    weight: SEARCH_DOCUMENT_WEIGHTS[candidate.scope],
  };
  const signature = JSON.stringify(document);
  if (!context.signatures.has(signature)) {
    context.signatures.add(signature);
    context.documents.push(document);
  }
}

function addBilingualDocument(
  context: ProjectionContext,
  candidate: Omit<DocumentCandidate, "englishText" | "chineseText"> & {
    englishText: string;
    chineseText?: string;
  },
): void {
  const chineseText = candidate.chineseText ?? "";
  if (hasCjkText(chineseText)) {
    addDocument(context, {
      ...candidate,
      englishText: nonCjkProjection(candidate.englishText),
      chineseText,
    });
    return;
  }

  if (hasCjkText(candidate.englishText)) {
    addDocument(context, {
      ...candidate,
      englishText: nonCjkProjection(candidate.englishText),
      chineseText: candidate.englishText,
    });
  }
}

function projectExample(
  context: ProjectionContext,
  example: CanonicalExample,
  section: SearchDocumentSection,
  path: string[],
  part?: string,
): void {
  addBilingualDocument(context, {
    scope: "example",
    section,
    path,
    part,
    ownerId: example.id,
    englishText: example.text.text,
    chineseText: textValue(example.translation),
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
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: segment.value.text,
      });
    } else if (segment.kind === "example") {
      projectExample(context, segment.value, section, segmentPath, part);
    } else if (segment.kind === "term") {
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: segmentPath,
        part,
        ownerId,
        englishText: joinText(segment.headword.text, textValue(segment.partOfSpeech)),
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
  if (box.title) {
    addBilingualDocument(context, {
      scope: "usage",
      section: "grammar-usage",
      path: [...path, "title"],
      part,
      ownerId: boxOwnerId,
      englishText: box.title.text,
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
}

function projectGrammarUsageBlock(
  context: ProjectionContext,
  block: CanonicalBoxBlock,
  path: string[],
  ownerId?: string,
  part?: string,
): void {
  if (block.kind === "heading" || block.kind === "unknown") {
    addBilingualDocument(context, {
      scope: "usage",
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
      englishText: block.value.text,
    });
    return;
  }

  if (block.kind === "paragraph") {
    addBilingualDocument(context, {
      scope: "usage",
      section: "grammar-usage",
      path: [...path, "value"],
      part,
      ownerId,
      englishText: block.value.text,
    });
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
        addBilingualDocument(context, {
          scope: "usage",
          section: "grammar-usage",
          path: [...cellPath, "value"],
          part,
          ownerId,
          englishText: cell.value.text,
        });
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
  phraseHeading?: string,
  phraseOwnerId?: string,
	  inheritedPart?: string,
): void {
	  const part = sense.partOfSpeech ?? inheritedPart;
  const senseOwnerId = phraseOwnerId ?? sense.id;
  addBilingualDocument(context, {
    scope: phraseHeading ? "phrase" : "sense",
    section,
    path,
    part,
    ownerId: senseOwnerId,
    englishText: joinText(phraseHeading ?? "", textValue(sense.definition)),
    chineseText: textValue(sense.translation),
  });

  for (const [index, usage] of (sense.inlineUsage ?? []).entries()) {
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: stablePath(path, "inlineUsage", index),
      part,
      ownerId: sense.id,
      englishText: usage.text,
    });
  }
  for (const [index, usage] of sense.usage.entries()) {
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: stablePath(path, "usage", index),
      part,
      ownerId: sense.id,
      englishText: usage.text,
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
  for (const [index, usage] of phrase.leadingUsage.entries()) {
    addBilingualDocument(context, {
      scope: "usage",
      section,
      path: stablePath(path, "leadingUsage", index),
      ownerId: phrase.id,
      englishText: usage.text,
    });
  }
  projectForms(context, phrase.variants, section, [...path, "variants"]);
  for (const [index, sense] of phrase.senses.entries()) {
    projectSense(
      context,
      sense,
      section,
      stablePath(path, "senses", index),
      phrase.display.text,
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
    addBilingualDocument(context, {
      scope: "form",
      section,
      path: formPath,
      part,
      ownerId: form.id,
      englishText: joinText(form.text, textValue(form.note)),
    });
    for (const [usageIndex, usage] of (form.usage ?? []).entries()) {
      addBilingualDocument(context, {
        scope: "usage",
        section,
        path: stablePath(formPath, "usage", usageIndex),
        part,
        ownerId: form.id,
        englishText: usage.text,
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

function projectEntry(
	context: ProjectionContext,
	entry: CanonicalEntry,
	path: string[],
	inheritedPart?: string,
): void {
	  const part = entryPart(entry, inheritedPart);
  for (const [index, usage] of (entry.headwordUsage ?? []).entries()) {
    addBilingualDocument(context, {
      scope: "usage",
      section: "definitions",
      path: stablePath(path, "headwordUsage", index),
	      part,
      englishText: usage.text,
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
    documents: [],
    signatures: new Set<string>(),
  };
  projectEntry(context, entry, []);
  return context.documents;
}
