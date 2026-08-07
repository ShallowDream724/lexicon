export type DictionarySearchItem = {
  kind: "dictionary";
  id: string;
  headword: string;
  partsOfSpeech: string[];
  translationPreview: string;
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
