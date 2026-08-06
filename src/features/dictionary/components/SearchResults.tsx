import type { DictionarySearchItem } from "../search-matches";

type SearchResultsProps = {
  query: string;
  items: readonly DictionarySearchItem[];
  pending: boolean;
  error?: string | null;
  onSelect: (entryId: string) => void;
  onRetry?: () => void;
};

export function SearchResults({
  query,
  items,
  pending,
  error,
  onSelect,
  onRetry,
}: SearchResultsProps) {
  return (
    <section
      aria-busy={pending}
      aria-label={`“${query}”的搜索结果`}
      className="search-results"
    >
      <h1>{items.length ? "你要找的是不是：" : "查询结果"}</h1>

      {pending ? <p className="search-results-status" role="status">正在查询</p> : null}

      {!pending && error ? (
        <div className="search-results-error" role="alert">
          <p>{error}</p>
          {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
        </div>
      ) : null}

      {!pending && !error && items.length ? (
        <ul className="search-results-list" aria-label="词条">
          {items.map((item) => (
            <li key={item.id}>
              <button
                className="search-result-item"
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <strong>{item.headword}</strong>
                {item.partsOfSpeech.length ? (
                  <span className="search-result-pos">{item.partsOfSpeech.join(", ")}</span>
                ) : null}
                {item.translationPreview ? (
                  <span className="search-result-translation">{item.translationPreview}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!pending && !error && !items.length ? (
        <p className="search-results-empty">没有找到与“{query}”匹配的词条</p>
      ) : null}
    </section>
  );
}
