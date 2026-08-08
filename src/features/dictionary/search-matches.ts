import { searchTargetKey, type SearchTarget } from "../../lib/dictionary-client/search-target";

export type { DictionarySearchItem, EtymologySearchItem, SearchTarget } from "../../lib/dictionary-client/search-target";

export type SearchMatchResolution =
  | { kind: "direct"; target: SearchTarget }
  | { kind: "candidates"; items: SearchTarget[] };

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00b7\u2027]/g, "")
    .trim()
    .toLocaleLowerCase();
}

export function isChineseSearchQuery(value: string): boolean {
  return /\p{Script=Han}/u.test(value.normalize("NFKC"));
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
  items: readonly SearchTarget[],
): SearchMatchResolution {
  const uniqueItems = items.filter((item, index) =>
    items.findIndex((candidate) => searchTargetKey(candidate) === searchTargetKey(item)) === index,
  );
  const normalizedQuery = normalizeSearchQuery(query);
  const exactDictionaryMatches = uniqueItems.filter(
    (item): item is Extract<SearchTarget, { kind: "dictionary" }> =>
      item.kind === "dictionary" && normalizeSearchQuery(item.headword) === normalizedQuery,
  );
  const exactEtymologyMatches = uniqueItems.filter(
    (item): item is Extract<SearchTarget, { kind: "etymology" }> =>
      item.kind === "etymology" && normalizeSearchQuery(item.headword) === normalizedQuery,
  );

  if (isChineseSearchQuery(query)) {
    return {
      kind: "candidates",
      items: uniqueItems.toSorted((left, right) =>
        left.kind === right.kind ? 0 : left.kind === "dictionary" ? -1 : 1,
      ),
    };
  }

  if (exactDictionaryMatches.length === 1) {
    return { kind: "direct", target: exactDictionaryMatches[0]! };
  }
  if (exactDictionaryMatches.length === 0 && exactEtymologyMatches.length === 1) {
    return { kind: "direct", target: exactEtymologyMatches[0]! };
  }
  return {
    kind: "candidates",
    items: uniqueItems.toSorted((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "dictionary" ? -1 : 1,
    ),
  };
}
