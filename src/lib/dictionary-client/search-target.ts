import type {
  SearchDocumentLocation,
  SearchDocumentScope,
} from "../../../packages/dictionary-search/src/index";

export type DictionarySearchMatch = {
  scope: SearchDocumentScope;
  englishText: string;
  chineseText: string;
  location: SearchDocumentLocation;
  candidateText?: string;
  definitionText?: string;
  part?: string;
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

export function searchTargetKey(target: SearchTarget): string {
  return `${target.kind}:${target.id}`;
}
