import type {
  SearchDocumentLocation,
} from "../../../packages/dictionary-search/src/index";
import type { DictionarySearchResultScope } from "./search-scope";

export type DictionarySearchMatch = {
  scope: DictionarySearchResultScope;
  englishText: string;
  chineseText: string;
  location: SearchDocumentLocation;
  candidateText?: string;
  definitionText?: string;
  part?: string;
  resourceCategory?: string;
  semanticRole?: "definition" | "qualifier" | "guidance" | "expression" | "example" | "heading" | "context";
  matchKind?: "headword" | "variant" | "phrase" | "pattern" | "etymology" | "inflection";
  relation?: string;
};

export type DictionarySearchItem = {
  kind: "dictionary";
  id: string;
  headword: string;
  partsOfSpeech: string[];
  translationPreview: string;
  headwordForms?: string[];
  matches?: DictionarySearchMatch[];
  matchesTotal?: number;
};

export type EtymologySearchItem = {
  kind: "etymology";
  id: string;
  headword: string;
  partsOfSpeech: string[];
  translationPreview: string;
};

export type SearchTarget = DictionarySearchItem | EtymologySearchItem;

export type EnglishSearchGroup = {
  text: string;
  kind: "exact" | "phrase" | "token";
  items: SearchTarget[];
};

export type EnglishSearchCorrection = {
  input: string;
  suggestion: string;
  items: SearchTarget[];
};

export function searchTargetKey(target: SearchTarget): string {
  return `${target.kind}:${target.id}`;
}
