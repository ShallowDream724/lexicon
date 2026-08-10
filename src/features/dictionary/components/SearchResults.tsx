import { ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import type {
  DictionarySearchMatch,
  SearchTarget,
} from "../../../lib/dictionary-client/search-target";
import {
  searchScopeCategoryEnabled,
  toggleSearchScopeCategory,
  type DictionarySearchScope,
  type DictionarySearchScopeCategory,
} from "../../../lib/dictionary-client/search-scope";
import {
  isChineseSearchQuery,
  normalizeSearchQuery,
} from "../search-matches";

const initialEvidenceCount = 3;

type SearchResultsProps = {
  query: string;
  items: readonly SearchTarget[];
  pending: boolean;
  error?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string | null;
  nextResultCount?: number;
  scope?: readonly DictionarySearchScope[];
  mode?: "hybrid";
  semanticStatus?: "applied" | "degraded";
  onSelect: (target: SearchTarget, match?: DictionarySearchMatch) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onScopeChange?: (scope: DictionarySearchScope[]) => void;
};

const scopeCategoryLabels: Record<DictionarySearchScopeCategory, string> = {
  terms: "词义与短语",
  usage: "用法",
  example: "例句",
};

const scopeCategories: readonly DictionarySearchScopeCategory[] = ["terms", "usage", "example"];

const matchLabels: Record<DictionarySearchMatch["scope"], string> = {
  sense: "词义",
  phrase: "短语",
  example: "例句",
  usage: "用法",
  form: "词形",
};

const compactPartLabels: Readonly<Record<string, string>> = {
  "abbr.": "abbr.",
  "adj.": "adj.",
  "adv.": "adv.",
  "auxiliary verb": "aux. v.",
  "combining form": "comb. form",
  "conj.": "conj.",
  "definite article": "def. art.",
  "det.": "det.",
  exclamation: "excl.",
  "indefinite article": "indef. art.",
  "infinitive marker": "inf. marker",
  "linking verb": "linking v.",
  "modal verb": "modal v.",
  noun: "n.",
  number: "num.",
  "ordinal number": "ord. num.",
  prefix: "pref.",
  "prep.": "prep.",
  "pron.": "pron.",
  "short form": "short f.",
  suffix: "suff.",
  symbol: "symb.",
  verb: "v.",
};

export function compactEvidencePartLabel(part: string): string {
  const normalized = part.trim().replace(/^,\s*/, "");
  return compactPartLabels[normalized.toLowerCase()] ?? normalized;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flexibleLiteralPattern(value: string): string {
  return Array.from(value, (character) => {
    if (character === "'" || character === "’") {
      return "['’]";
    }
    if (/\s/u.test(character)) {
      return "\\s+[ˈˌ]?";
    }
    if (/[-‐‑–—]/u.test(character)) {
      return "[-‐‑–—][ˈˌ]?";
    }
    return escapeRegularExpression(character);
  }).join("");
}

function evidenceTermPattern(headword: string, headwordForms: readonly string[]): RegExp | null {
  const normalizedHeadword = normalizeSearchQuery(headword);
  if (!/[\p{L}\p{N}]/u.test(normalizedHeadword)) {
    return null;
  }

  const surfaceTerms = new Set([normalizedHeadword]);
  for (const form of headwordForms) {
    const normalizedForm = normalizeSearchQuery(form);
    if (/[\p{L}\p{N}]/u.test(normalizedForm)) {
      surfaceTerms.add(normalizedForm);
    }
  }

  const alternatives = Array.from(surfaceTerms)
    .sort((left, right) => right.length - left.length)
    .map(flexibleLiteralPattern);
  return new RegExp(
    `(?<![\\p{L}\\p{N}ˈˌ])([ˈˌ]?(?:${alternatives.join("|")}))(?![\\p{L}\\p{N}])`,
    "giu",
  );
}

function evidenceText(
  text: string,
  headword: string,
  headwordForms: readonly string[],
): ReactNode {
  const pattern = evidenceTermPattern(headword, headwordForms);
  if (!pattern) {
    return text;
  }
  const parts = text.split(pattern);
  if (parts.length === 1) {
    return text;
  }
  return parts.map((part, index) => index % 2 === 1 ? (
    <strong className="search-result-match-term" key={index}>{part}</strong>
  ) : (
    <Fragment key={index}>{part}</Fragment>
  ));
}

export function SearchResults({
  query,
  items,
  pending,
  error,
  hasMore = false,
  loadingMore = false,
  loadMoreError,
  nextResultCount,
  scope,
  mode,
  semanticStatus,
  onSelect,
  onLoadMore,
  onRetry,
  onScopeChange,
}: SearchResultsProps) {
  const [evidenceExpansion, setEvidenceExpansion] = useState<{
    query: string;
    keys: ReadonlySet<string>;
  }>(() => ({ query, keys: new Set() }));
  const reverseLookup = isChineseSearchQuery(query);
  const semanticDegraded =
    reverseLookup && mode === "hybrid" && semanticStatus === "degraded";
  const enabledScopeCategories = scopeCategories.filter((category) =>
    searchScopeCategoryEnabled(scope ?? [], category),
  );
  return (
    <section
      aria-busy={pending}
      aria-label={`“${query}”的搜索结果`}
      className="search-results"
    >
      <div className="search-results-heading">
        <h1>
          {reverseLookup
            ? `“${query}”的相关英文词条`
            : items.length ? "你要找的是不是：" : "查询结果"}
        </h1>
        {semanticDegraded ? (
          <p className="search-results-semantic-status" role="status">
            部分相关结果暂未显示
          </p>
        ) : null}
      </div>

      {reverseLookup && scope && onScopeChange ? (
        <div className="search-results-scope" role="group" aria-label="搜索范围">
          {scopeCategories.map((category) => {
            const checked = searchScopeCategoryEnabled(scope, category);
            return (
              <label key={category}>
                <input
                  checked={checked}
                  disabled={checked && enabledScopeCategories.length === 1}
                  type="checkbox"
                  onChange={() => onScopeChange(toggleSearchScopeCategory(scope, category))}
                />
                <span>{scopeCategoryLabels[category]}</span>
              </label>
            );
          })}
        </div>
      ) : null}

      {pending ? <p className="visually-hidden" role="status">正在查询</p> : null}

      {!pending && error ? (
        <div className="search-results-error" role="alert">
          <p>{error}</p>
          {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
        </div>
      ) : null}

      {!error && items.length ? (
        <ul className="search-results-list" aria-label="词条">
          {items.map((item) => {
            const matches = item.kind === "dictionary" ? item.matches ?? [] : [];
            const headwordForms = item.kind === "dictionary" ? item.headwordForms ?? [] : [];
            const evidenceCount = item.kind === "dictionary"
              ? item.matchesTotal ?? matches.length
              : 0;
            const evidenceKey = `${query}\u0000${item.kind}\u0000${item.id}`;
            const expanded = evidenceExpansion.query === query
              && evidenceExpansion.keys.has(evidenceKey);
            const visibleMatches = expanded ? matches : matches.slice(0, initialEvidenceCount);
            const canToggleEvidence =
              evidenceCount > initialEvidenceCount && matches.length > initialEvidenceCount;
            const evidenceListId = `search-result-evidence-${item.kind}-${item.id}`;
            return (
            <li key={`${item.kind}-${item.id}`}>
              <div className={`search-result${matches.length ? " has-evidence" : ""}`}>
              <button
                className="search-result-item"
                type="button"
                onClick={() => onSelect(item, matches[0])}
              >
                <strong>{item.headword}</strong>
                {item.partsOfSpeech.length ? (
                  <span className="search-result-pos">{item.partsOfSpeech.join(", ")}</span>
                ) : null}
                {item.translationPreview && !matches.length ? (
                  <span className="search-result-translation">{item.translationPreview}</span>
                ) : null}
                {item.kind === "etymology" ? (
                  <span className="search-result-translation">仅词源</span>
                ) : null}
              </button>
              {matches.length ? (
                <ul
                  className="search-result-evidence-list"
                  id={evidenceListId}
                  aria-label={`${item.headword} 的匹配内容`}
                >
                  {visibleMatches.map((match, index) => (
                    <li key={`${match.scope}-${match.location.path.join("-")}-${index}`}>
                      <button type="button" onClick={() => onSelect(item, match)}>
                        <span className="search-result-scope" data-scope={match.scope}>
                          <span className="search-result-scope-label">
                            {matchLabels[match.scope]}
                          </span>
                          {match.part ? (
                            <span className="search-result-scope-part">
                              {compactEvidencePartLabel(match.part)}
                            </span>
                          ) : null}
                        </span>
                        <span className="search-result-evidence-copy">
                          {match.candidateText || match.englishText ? (
                            <span className="search-result-candidate">
                              {evidenceText(
                                match.candidateText || match.englishText,
                                item.headword,
                                headwordForms,
                              )}
                            </span>
                          ) : null}
                          <span className="search-result-chinese">{match.chineseText}</span>
                          {match.definitionText ? (
                            <span className="search-result-definition">
                              {evidenceText(match.definitionText, item.headword, headwordForms)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {matches.length && canToggleEvidence ? (
                <div className="search-result-evidence-toggle">
                  <button
                    aria-controls={evidenceListId}
                    aria-expanded={expanded}
                    type="button"
                    onClick={() => {
                      setEvidenceExpansion((current) => {
                        const next = new Set(current.query === query ? current.keys : []);
                        if (next.has(evidenceKey)) {
                          next.delete(evidenceKey);
                        } else {
                          next.add(evidenceKey);
                        }
                        return { query, keys: next };
                      });
                    }}
                  >
                    {expanded ? "收起匹配内容" : `显示全部 ${evidenceCount} 条匹配`}
                  </button>
                </div>
              ) : null}
              </div>
            </li>
            );
          })}
        </ul>
      ) : null}

      {!pending && !error && !items.length ? (
        <p className="search-results-empty">没有找到与“{query}”匹配的词条</p>
      ) : null}

      {!pending && !error && hasMore && onLoadMore ? (
        <div className="search-results-more">
          {loadMoreError ? <p role="alert">{loadMoreError}</p> : null}
          <button disabled={loadingMore} type="button" onClick={onLoadMore}>
            <span>{loadingMore ? "正在加载" : nextResultCount ? `继续显示至 ${nextResultCount} 条` : "显示更多结果"}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
