import type {
  SearchDocumentLocation,
  SearchDocumentScope,
} from "../../../packages/dictionary-search/src/index";

export type DictionarySearchMatch = {
  scope: SearchDocumentScope;
  englishText: string;
  chineseText: string;
  location: SearchDocumentLocation;
};

export type DictionarySearchItem = {
  kind: "dictionary";
  id: string;
  headword: string;
  partsOfSpeech: string[];
  translationPreview: string;
  matches?: DictionarySearchMatch[];
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
