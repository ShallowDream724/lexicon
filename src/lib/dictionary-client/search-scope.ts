export const DICTIONARY_SEARCH_SCOPE_ORDER = [
  "sense",
  "phrase",
  "form",
  "usage",
  "example",
] as const;

export type DictionarySearchScope = (typeof DICTIONARY_SEARCH_SCOPE_ORDER)[number];

export type DictionarySearchScopeCategory = "terms" | "usage" | "example";

const scopeCategories: Record<DictionarySearchScopeCategory, readonly DictionarySearchScope[]> = {
  terms: ["sense", "phrase", "form"],
  usage: ["usage"],
  example: ["example"],
};

export const DEFAULT_CHINESE_SEARCH_SCOPES: readonly DictionarySearchScope[] = scopeCategories.terms;

export function normalizeDictionarySearchScopes(
  values: Iterable<string>,
): DictionarySearchScope[] {
  const selected = new Set<string>(values);
  return DICTIONARY_SEARCH_SCOPE_ORDER.filter((scope) => selected.has(scope));
}

export function parseChineseSearchScopes(value: string | null | undefined): DictionarySearchScope[] {
  const scopes = normalizeDictionarySearchScopes(value?.split(",") ?? []);
  return scopes.length ? scopes : [...DEFAULT_CHINESE_SEARCH_SCOPES];
}

export function serializeDictionarySearchScopes(scopes: Iterable<string>): string {
  return normalizeDictionarySearchScopes(scopes).join(",");
}

export function isChineseSearchQuery(value: string): boolean {
  return /\p{Script=Han}/u.test(value.normalize("NFKC"));
}

export function searchScopeCategoryEnabled(
  scopes: Iterable<string>,
  category: DictionarySearchScopeCategory,
): boolean {
  const selected = new Set(normalizeDictionarySearchScopes(scopes));
  return scopeCategories[category].every((scope) => selected.has(scope));
}

export function toggleSearchScopeCategory(
  scopes: Iterable<string>,
  category: DictionarySearchScopeCategory,
): DictionarySearchScope[] {
  const current = normalizeDictionarySearchScopes(scopes);
  const selected = new Set(current);
  const categoryScopes = scopeCategories[category];
  const enabled = categoryScopes.every((scope) => selected.has(scope));
  const enabledCategories = (Object.keys(scopeCategories) as DictionarySearchScopeCategory[])
    .filter((candidate) => searchScopeCategoryEnabled(current, candidate));

  if (enabled && enabledCategories.length === 1) {
    return current;
  }
  for (const scope of categoryScopes) {
    if (enabled) {
      selected.delete(scope);
    } else {
      selected.add(scope);
    }
  }
  return normalizeDictionarySearchScopes(selected);
}

export function dictionarySearchRequestKey(
  query: string,
  scopes: Iterable<string> | undefined,
): string {
  return `${query}\u0000${scopes ? serializeDictionarySearchScopes(scopes) : ""}`;
}
