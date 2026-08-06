export type DictionarySearchItem = {
  id: string;
  headword: string;
  partsOfSpeech: string[];
  translationPreview: string;
};

export type SearchMatchResolution =
  | { kind: "direct"; entryId: string }
  | { kind: "candidates"; items: DictionarySearchItem[] };

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00b7\u2027]/g, "")
    .trim()
    .toLocaleLowerCase();
}

export function fallbackSearchQueries(value: string): string[] {
  const word = normalizeSearchQuery(value);
  if (!/^[a-z]+$/.test(word)) {
    return [];
  }

  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (candidate.length >= 3 && candidate !== word && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  const addRegularStem = (stem: string) => {
    const last = stem.at(-1);
    const previous = stem.at(-2);
    if (last && last === previous && !/[aeiou]/.test(last)) {
      add(stem.slice(0, -1));
      return;
    }
    add(stem);
    add(`${stem}e`);
  };

  if (word.endsWith("ied") && word.length > 4) {
    add(`${word.slice(0, -3)}y`);
  } else if (word.endsWith("ed") && word.length > 4) {
    addRegularStem(word.slice(0, -2));
  } else if (word.endsWith("ing") && word.length > 5) {
    addRegularStem(word.slice(0, -3));
  } else if (word.endsWith("ies") && word.length > 4) {
    add(`${word.slice(0, -3)}y`);
  } else if (word.endsWith("es") && word.length > 4) {
    add(word.slice(0, -2));
  } else if (word.endsWith("s") && word.length > 3) {
    add(word.slice(0, -1));
  }

  return candidates.slice(0, 2);
}

export function resolveSearchMatches(
  query: string,
  items: readonly DictionarySearchItem[],
): SearchMatchResolution {
  const uniqueItems = items.filter((item, index) =>
    items.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const normalizedQuery = normalizeSearchQuery(query);
  const exactMatches = uniqueItems.filter(
    (item) => normalizeSearchQuery(item.headword) === normalizedQuery,
  );

  return exactMatches.length === 1
    ? { kind: "direct", entryId: exactMatches[0]!.id }
    : { kind: "candidates", items: uniqueItems };
}
