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
  example: "例句与搭配",
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
  evidenceText?: string,
  evidenceTranslation?: string,
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
    return dictionarySearchExampleEvidenceLabel(evidenceText ?? "", evidenceTranslation ?? "");
  }
  return resourceCategory && resourceCategory in resourceCategoryLabels
    ? resourceCategoryLabels[resourceCategory as DictionarySearchResourceCategory]
    : "扩展资料";
}

export function dictionarySearchExampleEvidenceLabel(
  text: string,
  translation: string,
): "例句" | "搭配" | "例证" {
  const normalized = normalizeExampleEvidenceTypography(text);
  const firstSemanticCharacter = normalized.match(/[\p{L}\p{N}]/u)?.[0];
  const sentenceStart = Boolean(
    firstSemanticCharacter && /[\p{Lu}\p{N}]/u.test(firstSemanticCharacter),
  );
  const sentenceEnd = /[.!?…]["'’”»\)\]]*$/u.test(normalized);
  const translationEnd = hasTranslatedSentenceEnd(translation);
  if (sentenceStart && sentenceEnd && translationEnd) {
    return "例句";
  }
  if (!(sentenceStart && sentenceEnd) && !translationEnd) {
    return "搭配";
  }
  return "例证";
}

function normalizeExampleEvidenceTypography(text: string): string {
  let value = text.normalize("NFKC").trim();
  while (value.startsWith("(")) {
    const closing = matchingParenthesis(value, 0);
    if (closing < 0 || !/\s/u.test(value[closing + 1] ?? "")) {
      break;
    }
    value = value.slice(closing + 1).trimStart();
  }
  while (value.endsWith(")")) {
    const opening = matchingOpeningParenthesis(value, value.length - 1);
    if (opening < 0 || !value.slice(opening + 1, -1).trimStart().startsWith("=")) {
      break;
    }
    value = value.slice(0, opening).trimEnd();
  }
  return value;
}

function matchingParenthesis(value: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function matchingOpeningParenthesis(value: string, closing: number): number {
  let depth = 0;
  for (let index = closing; index >= 0; index -= 1) {
    if (value[index] === ")") depth += 1;
    if (value[index] === "(" && --depth === 0) return index;
  }
  return -1;
}

function hasTranslatedSentenceEnd(text: string): boolean {
  let value = text.normalize("NFKC").trim();
  while (value.endsWith(")")) {
    const opening = matchingOpeningParenthesis(value, value.length - 1);
    if (opening < 0) break;
    const prefix = value.slice(0, opening).trimEnd();
    if (!/[。！？!?…]["'’”」』】\]]*$/u.test(prefix)) break;
    value = prefix;
  }
  return /[。！？!?…]["'’”」』】\)\]]*$/u.test(value);
}
