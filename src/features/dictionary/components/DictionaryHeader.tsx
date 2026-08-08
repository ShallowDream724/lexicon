"use client";

import {
  Clock3,
  Home,
  Library,
  LoaderCircle,
  Search,
  Star,
  X,
} from "lucide-react";
import Image from "next/image";
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useState,
} from "react";

import type { QueryHistoryRecord } from "../../../lib/storage/learning-data";
import type { SearchTarget } from "../../../lib/dictionary-client/client";
import {
  queryHistoryDisplayText,
  queryHistoryPreviewRecords,
  useLongPress,
} from "../query-history";
import type { ReadingScale } from "../reading-scale";
import { ReadingScaleControl } from "./ReadingScaleControl";

type DictionaryHeaderProps = {
  homeMode: boolean;
  query: string;
  suggestions: SearchTarget[];
  queryHistory: QueryHistoryRecord[];
  searchPending: boolean;
  searchOpen: boolean;
  searchError: string | null;
  fontScale: ReadingScale;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onClearQuery: () => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  onDismissSearch: () => void;
  onHome: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (target: SearchTarget) => void;
  onSelectQueryHistory: (query: string) => void;
  onDeleteQueryHistory: (key: string) => void;
  onFontScaleChange: (value: ReadingScale) => void;
  onOpenLibrary: (tab: "history" | "favorites") => void;
};

type QueryHistoryItemProps = {
  record: QueryHistoryRecord;
  onSelect: (query: string) => void;
  onDelete: (key: string) => void;
};

function QueryHistoryItem({ record, onSelect, onDelete }: QueryHistoryItemProps) {
  const longPress = useLongPress(() => onDelete(record.key));
  const query = queryHistoryDisplayText(record);

  return (
    <span className="search-recent-item">
      <button
        className="search-recent-query"
        type="button"
        title={query}
        aria-label={query}
        {...longPress}
        onClick={() => onSelect(query)}
      >
        <span>{query}</span>
      </button>
      <button
        className="search-recent-delete"
        type="button"
        title={`删除查询：${query}`}
        aria-label={`删除查询：${query}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onDelete(record.key)}
      >
        <X aria-hidden="true" />
      </button>
    </span>
  );
}

export function DictionaryHeader({
  homeMode,
  query,
  suggestions,
  queryHistory,
  searchPending,
  searchOpen,
  searchError,
  fontScale,
  inputRef,
  onQueryChange,
  onClearQuery,
  onSearchFocus,
  onSearchBlur,
  onDismissSearch,
  onHome,
  onSubmit,
  onSelect,
  onSelectQueryHistory,
  onDeleteQueryHistory,
  onFontScaleChange,
  onOpenLibrary,
}: DictionaryHeaderProps) {
  const [activeOption, setActiveOption] = useState(-1);
  const showSuggestions =
    searchOpen && Boolean(query.trim()) && suggestions.length > 0;
  const visibleQueryHistory = queryHistoryPreviewRecords(queryHistory);
  const optionCount = showSuggestions ? suggestions.length : 0;

  const selectOption = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) {
      setActiveOption(-1);
      onSelect(suggestion);
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && searchOpen) {
      event.preventDefault();
      setActiveOption(-1);
      onDismissSearch();
      return;
    }

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && optionCount) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveOption((current) => {
        if (current < 0) {
          return direction > 0 ? 0 : optionCount - 1;
        }
        return (current + direction + optionCount) % optionCount;
      });
      return;
    }

    if (event.key === "Enter" && activeOption >= 0 && activeOption < optionCount) {
      event.preventDefault();
      selectOption(activeOption);
    }
  };

  const normalizedQuery = query.replace(/[\u00b7\u2027]/g, "").trim().toLocaleLowerCase();

  const clearQuery = () => {
    setActiveOption(-1);
    onClearQuery();
  };

  return (
    <header className={`dictionary-header${homeMode ? " is-home" : ""}`}>
      <div className="header-topbar">
        <button className="header-home" type="button" title="首页" aria-label="首页" onClick={onHome}>
          <Home aria-hidden="true" />
        </button>

        <nav className="header-tools" aria-label="个人词库">
          <button
            className="header-tool"
            type="button"
            title="浏览记录"
            aria-label="浏览记录"
            onClick={() => onOpenLibrary("history")}
          >
            <Clock3 />
          </button>
          <button
            className="header-tool"
            type="button"
            title="收藏词条"
            aria-label="收藏词条"
            onClick={() => onOpenLibrary("favorites")}
          >
            <Star />
          </button>
          <ReadingScaleControl value={fontScale} onChange={onFontScaleChange} />
          <span className="header-divider" aria-hidden="true" />
          <span className="header-library-label">
            <Library aria-hidden="true" />
            本地词库
          </span>
        </nav>
      </div>

      <div className={`header-search-region${homeMode ? " is-home" : ""}`}>
        <div className="product-mark" aria-label="Lexicon">
          <span className="product-mark-icon" aria-hidden="true">
            <Image src="/brand-mark.svg" alt="" width={30} height={30} priority />
          </span>
          <span className="product-mark-copy">
            <strong>LEXICON</strong>
            <span>ENGLISH · 中文</span>
          </span>
        </div>
        <form className="search-form" role="search" onSubmit={onSubmit}>
          <div className="search-input-row">
            <Search className="search-leading-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="输入要查询的单词或短语"
              aria-label="查询单词或短语"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls={showSuggestions ? "dictionary-search-results" : undefined}
              aria-activedescendant={
                activeOption >= 0 && activeOption < optionCount
                  ? `dictionary-search-option-${activeOption}`
                  : undefined
              }
              onChange={(event) => {
                setActiveOption(-1);
                onQueryChange(event.target.value);
              }}
              onFocus={() => {
                setActiveOption(-1);
                onSearchFocus();
              }}
              onBlur={onSearchBlur}
              onKeyDown={handleSearchKeyDown}
            />
            {searchPending ? (
              <LoaderCircle className="search-pending-icon" aria-label="正在查询" />
            ) : null}
            {query ? (
              <button
                className="search-clear-button"
                type="button"
                title="清空查询"
                aria-label="清空查询"
                onMouseDown={(event) => event.preventDefault()}
                onClick={clearQuery}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
            <button className="search-submit-button" type="submit">
              查询
            </button>
          </div>

          {visibleQueryHistory.length ? (
            <div className="search-recent-row" aria-label="历史查询">
              <span>历史查询：</span>
              {visibleQueryHistory.map((record) => (
                <QueryHistoryItem
                  key={record.key}
                  record={record}
                  onSelect={onSelectQueryHistory}
                  onDelete={onDeleteQueryHistory}
                />
              ))}
            </div>
          ) : null}

          {searchError ? (
            <p className="search-error" role="status">
              {searchError}
            </p>
          ) : null}

          {showSuggestions ? (
            <div
              className="search-options"
              id="dictionary-search-results"
              role="listbox"
              aria-label="查询结果"
            >
              {suggestions.map((suggestion, index) => {
                const exactMatch =
                  suggestion.headword
                    .replace(/[\u00b7\u2027]/g, "")
                    .trim()
                    .toLocaleLowerCase() === normalizedQuery;
                return (
                  <button
                    key={`${suggestion.kind}-${suggestion.id}`}
                    id={`dictionary-search-option-${index}`}
                    className={`search-option${activeOption === index ? " is-active" : ""}${exactMatch ? " is-exact" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={activeOption === index}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setActiveOption(index)}
                    onClick={() => onSelect(suggestion)}
                  >
                    <span className="search-option-headword">{suggestion.headword}</span>
                    <span className="search-option-details">
                      {suggestion.partsOfSpeech.length ? (
                        <span className="search-option-pos">
                          {suggestion.partsOfSpeech.join(" · ")}
                        </span>
                      ) : null}
                      {suggestion.translationPreview ? (
                        <span className="search-option-preview">
                          {suggestion.translationPreview}
                        </span>
                      ) : null}
                      {suggestion.kind === "etymology" ? (
                        <span className="search-option-preview">仅词源</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

        </form>
      </div>
    </header>
  );
}
