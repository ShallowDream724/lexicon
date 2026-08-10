import lemmatizer from "wink-lemmatizer";

import type { CanonicalEntry } from "../../dictionary-schema/src/index";
import type { SearchDocument } from "./index";
import {
  normalizeHeadwordForm,
  projectCanonicalEntryHeadwordForms,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES,
  SEARCH_DOCUMENT_MAX_HEADWORD_FORMS,
} from "./headword-forms";

type LemmatizerPart = "adjective" | "noun" | "verb";

const englishSurfacePattern = /\p{L}+(?:['’]\p{L}+)?/gu;
const utf8Encoder = new TextEncoder();

function morphologyKey(value: string): string {
  return normalizeHeadwordForm(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[·ˈˌ]/gu, "")
    .replace(/’/gu, "'")
    .toLowerCase();
}

function morphologyParts(value: string | undefined, fallback: readonly string[]): LemmatizerPart[] {
  const selected = value?.trim() ? [value] : fallback;
  const text = selected.join(" ").toLowerCase();
  const parts: LemmatizerPart[] = [];
  if (/\b(?:adj|adjective)\b/u.test(text)) parts.push("adjective");
  if (/\b(?:n|noun)\b/u.test(text)) parts.push("noun");
  if (/\b(?:v|verb)\b/u.test(text)) parts.push("verb");
  return parts;
}

function lemma(part: LemmatizerPart, value: string): string {
  return lemmatizer[part](value);
}

interface EntryMorphologyContext {
  lemmaKeys: Set<string>;
  partsByEntryPath: Map<string, string[]>;
}

function entryPathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function documentEntryPath(path: readonly string[]): string[] {
  let end = 0;
  for (let index = 0; index + 1 < path.length; index += 1) {
    if (path[index] === "subentries") end = index + 2;
  }
  return path.slice(0, end);
}

function entryMorphologyContext(entry: CanonicalEntry): EntryMorphologyContext {
  const lemmaKeys = new Set<string>();
  const partsByEntryPath = new Map<string, string[]>();
  const root = morphologyKey(entry.headword);
  if (!/^[a-z]+(?:'[a-z]+)?$/u.test(root)) return { lemmaKeys, partsByEntryPath };

  const visit = (current: CanonicalEntry, path: string[]): void => {
    if (morphologyKey(current.headword) !== root) return;
    partsByEntryPath.set(entryPathKey(path), current.partsOfSpeech.map((part) => part.text));
    lemmaKeys.add(root);
    for (const variant of current.variants ?? []) {
      const key = morphologyKey(variant.text);
      if (/^[a-z]+(?:'[a-z]+)?$/u.test(key)) lemmaKeys.add(key);
    }
    current.subentries.forEach((subentry, index) => {
      visit(subentry, [...path, "subentries", String(index)]);
    });
  };

  visit(entry, []);
  return { lemmaKeys, partsByEntryPath };
}

/**
 * Adds only forms observed in projected evidence and validated against the entry lemma.
 * This build-only pass supplements source-declared forms without shipping morphology code.
 */
export function enrichSearchDocumentsWithObservedHeadwordForms(
  entry: CanonicalEntry,
  documents: readonly SearchDocument[],
): SearchDocument[] {
  if (documents.length === 0) return [];

  const forms = projectCanonicalEntryHeadwordForms(entry);
  const seen = new Set(forms.map((form) => morphologyKey(form)));
  const { lemmaKeys, partsByEntryPath } = entryMorphologyContext(entry);
  const rootKey = morphologyKey(entry.headword);

  if (lemmaKeys.size > 0 && forms.length < SEARCH_DOCUMENT_MAX_HEADWORD_FORMS) {
    for (const document of documents) {
      const entryParts = partsByEntryPath.get(entryPathKey(documentEntryPath(document.location.path)));
      if (!entryParts) continue;
      const parts = morphologyParts(document.location.part, entryParts);
      if (parts.length === 0) continue;
      const evidence = [document.candidateText, document.definitionText, document.englishText]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      for (const match of evidence.matchAll(englishSurfacePattern)) {
        const surface = match[0];
        const surfaceKey = morphologyKey(surface);
        if (
          !surfaceKey ||
          surfaceKey === rootKey ||
          seen.has(surfaceKey) ||
          utf8Encoder.encode(surface).byteLength > SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES
        ) {
          continue;
        }
        if (!parts.some((part) => lemmaKeys.has(morphologyKey(lemma(part, surfaceKey))))) continue;
        seen.add(surfaceKey);
        forms.push(surface);
        if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS) break;
      }
      if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS) break;
    }
  }

  return documents.map((document) => forms.length > 0
    ? { ...document, headwordForms: forms }
    : { ...document, headwordForms: undefined });
}
