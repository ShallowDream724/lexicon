import type {
  DictionarySearchMatch,
  SearchTarget,
} from "../../../lib/dictionary-client/search-target";
import { isChineseSearchQuery } from "../search-matches";

type SearchResultsProps = {
  query: string;
  items: readonly SearchTarget[];
  pending: boolean;
  error?: string | null;
  onSelect: (target: SearchTarget, match?: DictionarySearchMatch) => void;
  onRetry?: () => void;
};

const matchLabels: Record<DictionarySearchMatch["scope"], string> = {
  sense: "词义",
  phrase: "词组",
  example: "例句",
  usage: "用法",
  form: "词形",
};

export function SearchResults({
  query,
  items,
  pending,
  error,
  onSelect,
  onRetry,
}: SearchResultsProps) {
  const reverseLookup = isChineseSearchQuery(query);
  return (
    <section
      aria-busy={pending}
      aria-label={`“${query}”的搜索结果`}
      className="search-results"
    >
      <h1>
        {reverseLookup
          ? `“${query}”的相关英文词条`
          : items.length ? "你要找的是不是：" : "查询结果"}
      </h1>

      {pending ? <p className="search-results-status" role="status">正在查询</p> : null}

      {!pending && error ? (
        <div className="search-results-error" role="alert">
          <p>{error}</p>
          {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
        </div>
      ) : null}

      {!pending && !error && items.length ? (
        <ul className="search-results-list" aria-label="词条">
          {items.map((item) => {
            const matches = item.kind === "dictionary" ? item.matches ?? [] : [];
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
                <ul className="search-result-evidence-list" aria-label={`${item.headword} 的匹配内容`}>
                  {matches.map((match, index) => (
                    <li key={`${match.scope}-${match.location.path.join("-")}-${index}`}>
                      <button type="button" onClick={() => onSelect(item, match)}>
                        <span className="search-result-scope">{matchLabels[match.scope]}</span>
                        <span className="search-result-evidence-copy">
                          {match.englishText ? (
                            <span className="search-result-english">{match.englishText}</span>
                          ) : null}
                          <span className="search-result-chinese">{match.chineseText}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
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
    </section>
  );
}
