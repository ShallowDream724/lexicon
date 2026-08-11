export const DICTIONARY_SEARCH_SCOPE_ORDER = [
  "sense",
  "phrase",
  "form",
  "example",
  "resource",
] as const;

export type DictionarySearchScope = (typeof DICTIONARY_SEARCH_SCOPE_ORDER)[number];

export const DICTIONARY_SEARCH_SCOPE_CATEGORY_ORDER = [
  "meaning",
  "phrase",
  "example",
  "resource",
] as const;

export type DictionarySearchScopeCategory =
  (typeof DICTIONARY_SEARCH_SCOPE_CATEGORY_ORDER)[number];

const scopeCategories: Record<
  DictionarySearchScopeCategory,
  readonly DictionarySearchScope[]
> = {
  meaning: ["sense", "form"],
  phrase: ["phrase"],
  example: ["example"],
  resource: ["resource"],
};

export const DICTIONARY_SEARCH_SCOPE_CATEGORY_LABELS: Record<
  DictionarySearchScopeCategory,
  string
> = {
  meaning: "词义",
  phrase: "短语",
  example: "例句",
  resource: "扩展资料",
};

export const DEFAULT_CHINESE_SEARCH_SCOPES: readonly DictionarySearchScope[] = [
  ...scopeCategories.meaning,
  ...scopeCategories.phrase,
];

export type DictionarySearchResultScope = DictionarySearchScope;

export type DictionarySearchResourceCategory =
  | "which-word"
  | "language-bank"
  | "wordfinder"
  | "synonyms"
  | "express-yourself"
  | "collocations"
  | "homophones"
  | "british-american"
  | "more-about"
  | "vocabulary-building"
  | "grammar"
  | "help"
  | "origin"
  | "note"
  | "other";

export type DictionarySearchMatchSource = "sense" | "phrase" | "example" | "resource";

const resourceCategoryLabels: Record<DictionarySearchResourceCategory, string> = {
  "which-word": "词语辨析",
  "language-bank": "用语库",
  wordfinder: "词汇联想",
  synonyms: "同义词辨析",
  "express-yourself": "情景表达",
  collocations: "搭配",
  homophones: "同音词",
  "british-american": "英美差异",
  "more-about": "拓展说明",
  "vocabulary-building": "词汇扩展",
  grammar: "语法说明",
  help: "使用提示",
  origin: "词语来源",
  note: "词典说明",
  other: "扩展资料",
};

export function normalizeDictionarySearchScopes(
  values: Iterable<string>,
): DictionarySearchScope[] {
  const selected = new Set<string>(values);
  return DICTIONARY_SEARCH_SCOPE_ORDER.filter((scope) => selected.has(scope));
}

export function parseChineseSearchScopes(value: string | null | undefined): DictionarySearchScope[] {
  const scopes = normalizeDictionarySearchScopes(value?.split(",") ?? []);
  return scopes.length || value === "" ? scopes : [...DEFAULT_CHINESE_SEARCH_SCOPES];
}

export function serializeDictionarySearchScopes(scopes: Iterable<string>): string {
  return normalizeDictionarySearchScopes(scopes).join(",");
}

export function hasSelectedChineseSearchScope(scopes: Iterable<string>): boolean {
  return normalizeDictionarySearchScopes(scopes).length > 0;
}

export function isChineseSearchQuery(value: string): boolean {
  return /\p{Script=Han}/u.test(value.normalize("NFKC"));
}

export function searchScopeCategoryEnabled(
  scopes: Iterable<string>,
  category: DictionarySearchScopeCategory | string,
): boolean {
  const categoryScopes = scopeCategories[category as DictionarySearchScopeCategory];
  if (!categoryScopes) {
    return false;
  }
  const selected = new Set(normalizeDictionarySearchScopes(scopes));
  return categoryScopes.every((scope) => selected.has(scope));
}

export function toggleSearchScopeCategory(
  scopes: Iterable<string>,
  category: DictionarySearchScopeCategory | string,
): DictionarySearchScope[] {
  const current = normalizeDictionarySearchScopes(scopes);
  const selected = new Set(current);
  const categoryScopes = scopeCategories[category as DictionarySearchScopeCategory];
  if (!categoryScopes) {
    return current;
  }
  const enabled = categoryScopes.every((scope) => selected.has(scope));
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
  mode?: "hybrid",
): string {
  return `${query}\u0000${scopes ? serializeDictionarySearchScopes(scopes) : ""}\u0000${mode ?? ""}`;
}

export function dictionarySearchMatchSource(scope: DictionarySearchResultScope): DictionarySearchMatchSource {
  switch (scope) {
    case "sense":
    case "form":
      return "sense";
    case "phrase":
      return "phrase";
    case "example":
      return "example";
    case "resource":
      return "resource";
  }
}

export function dictionarySearchMatchSourceLabel(
  scope: DictionarySearchResultScope,
  resourceCategory?: string,
  matchKind?: string,
  semanticRole?: "definition" | "qualifier" | "guidance" | "expression" | "example" | "heading" | "context",
): string {
  if (matchKind === "inflection" || matchKind === "variant") {
    return "词形";
  }
  const source = dictionarySearchMatchSource(scope);
  if (semanticRole === "qualifier") {
    return "适用范围";
  }
  if (semanticRole === "guidance") {
    return source === "phrase" ? "短语说明" : "用法提示";
  }
  if (source === "sense") {
    return "词义";
  }
  if (source === "phrase") {
    return "短语";
  }
  if (source === "example") {
    return "例句";
  }
  return resourceCategory && resourceCategory in resourceCategoryLabels
    ? resourceCategoryLabels[resourceCategory as DictionarySearchResourceCategory]
    : "扩展资料";
}
