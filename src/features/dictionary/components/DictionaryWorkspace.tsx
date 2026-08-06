"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import type { CanonicalEntry } from "../../../../packages/dictionary-schema/src/index";
import {
  dictionaryClient,
  type DictionarySearchItem,
} from "../../../lib/dictionary-client/client";
import {
  learningData,
  type FavoriteRecord,
  type HistoryRecord,
  type NoteRecord,
} from "../../../lib/storage/learning-data";
import { demoEntry } from "../demo-entry";
import { projectEntryPart } from "../entry-sections";
import {
  fallbackSearchQueries,
  normalizeSearchQuery,
  resolveSearchMatches,
} from "../search-matches";
import { activeSectionForScroll } from "../scroll-spy-model";
import { DictionaryHeader } from "./DictionaryHeader";
import { DictionaryHome } from "./DictionaryHome";
import { EntryView } from "./EntryView";
import { InlineLookup } from "./InlineLookup";
import { SearchResults } from "./SearchResults";
import { type LibraryTab, WorkspaceDrawer } from "./WorkspaceDrawer";

type DrawerState =
  | { mode: "note" }
  | { mode: "library"; tab: LibraryTab }
  | null;

type WorkspaceView = "home" | "loading" | "entry" | "search-results";

export type WorkspaceInitialRoute =
  | { kind: "home" }
  | { kind: "entry"; entryId: string }
  | { kind: "query"; query: string };

type DictionaryWorkspaceProps = {
  initialRoute?: WorkspaceInitialRoute;
};

type SearchResultsState = {
  query: string;
  items: DictionarySearchItem[];
  pending: boolean;
  error: string | null;
};

const emptySearchResults: SearchResultsState = {
  query: "",
  items: [],
  pending: false,
  error: null,
};

function updateRoute(url: string, mode: "push" | "replace"): void {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current === url) {
    return;
  }
  if (mode === "replace") {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function DictionaryWorkspace({
  initialRoute = { kind: "home" },
}: DictionaryWorkspaceProps) {
  const [query, setQuery] = useState(initialRoute.kind === "query" ? initialRoute.query : "");
  const [entry, setEntry] = useState<CanonicalEntry>(demoEntry);
  const [view, setView] = useState<WorkspaceView>(
    initialRoute.kind === "home"
      ? "home"
      : initialRoute.kind === "entry"
        ? "loading"
        : "search-results",
  );
  const [searchResults, setSearchResults] = useState<SearchResultsState>(
    initialRoute.kind === "query"
      ? { query: initialRoute.query, items: [], pending: true, error: null }
      : emptySearchResults,
  );
  const [suggestions, setSuggestions] = useState<DictionarySearchItem[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [note, setNote] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [entryPending, setEntryPending] = useState(initialRoute.kind === "entry");
  const [activePartIndex, setActivePartIndex] = useState(0);
  const [activeSectionId, setActiveSectionId] = useState("definitions");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wordPageRef = useRef<HTMLElement>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const submittedSearchRequest = useRef<AbortController | null>(null);
  const submittedSearchQuery = useRef<string | null>(null);
  const entryRequest = useRef<AbortController | null>(null);
  const activeAudio = useRef<HTMLAudioElement | null>(null);

  const refreshLearningData = useCallback(async () => {
    const [nextHistory, nextFavorites, nextNotes] = await Promise.all([
      learningData.listHistory(),
      learningData.listFavorites(),
      learningData.listNotes(),
    ]);
    setHistory(nextHistory);
    setFavorites(nextFavorites);
    setNotes(nextNotes);
  }, []);

  const loadEntryLearningState = useCallback(async (nextEntry: CanonicalEntry) => {
    const identity = {
      dictionaryId: nextEntry.dictionaryId,
      entryId: nextEntry.id,
    };
    await learningData.recordVisit({ ...identity, headword: nextEntry.headword });
    const [nextFavorite, nextNote, nextHistory, nextFavorites, nextNotes] = await Promise.all([
      learningData.isFavorite(identity),
      learningData.getNote(identity),
      learningData.listHistory(),
      learningData.listFavorites(),
      learningData.listNotes(),
    ]);
    return {
      favorite: nextFavorite,
      note: nextNote?.text ?? "",
      history: nextHistory,
      favorites: nextFavorites,
      notes: nextNotes,
    };
  }, []);

  const selectEntry = useCallback(
    async (
      entryId: string,
      options: { route?: "none" | "push" | "replace" } = {},
    ): Promise<boolean | null> => {
      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      submittedSearchRequest.current?.abort();
      submittedSearchRequest.current = null;
      entryRequest.current?.abort();
      const controller = new AbortController();
      entryRequest.current = controller;
      setEntryPending(true);
      setSearchOpen(false);
      setSearchPending(false);
      setSuggestions([]);

      try {
        const nextEntry = await dictionaryClient.entry(entryId, controller.signal);
        if (entryRequest.current !== controller || controller.signal.aborted) {
          return null;
        }
        setSearchError(null);
        setView("entry");
        setEntry(nextEntry);
        setFavorite(false);
        setNote("");
        setActivePartIndex(0);
        setActiveSectionId("definitions");
        setQuery(nextEntry.headword);
        const route = options.route ?? "push";
        if (route !== "none") {
          const nextUrl = `${window.location.pathname}?entry=${encodeURIComponent(nextEntry.id)}`;
          updateRoute(nextUrl, route);
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
        const learningState = await loadEntryLearningState(nextEntry);
        if (entryRequest.current !== controller || controller.signal.aborted) {
          return null;
        }
        setFavorite(learningState.favorite);
        setNote(learningState.note);
        setHistory(learningState.history);
        setFavorites(learningState.favorites);
        setNotes(learningState.notes);
        return true;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }
        if (entryRequest.current === controller) {
          setSearchError("词典服务暂不可用");
          inputRef.current?.focus();
        }
        return false;
      } finally {
        if (entryRequest.current === controller) {
          entryRequest.current = null;
          setEntryPending(false);
        }
      }
    },
    [loadEntryLearningState],
  );

  const showHome = useCallback((shouldUpdateRoute: boolean): void => {
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    submittedSearchRequest.current?.abort();
    submittedSearchRequest.current = null;
    submittedSearchQuery.current = null;
    entryRequest.current?.abort();
    entryRequest.current = null;
    activeAudio.current?.pause();
    setView("home");
    setSearchResults(emptySearchResults);
    setEntryPending(false);
    setSearchOpen(false);
    setSearchPending(false);
    setSuggestions([]);
    setSearchError(null);
    setAudioError(null);
    setActivePartIndex(0);
    setActiveSectionId("definitions");
    setDrawer(null);
    setQuery("");
    if (shouldUpdateRoute) {
      const homeUrl = window.location.pathname;
      updateRoute(homeUrl, "push");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const runSearch = useCallback(
    async (
      rawQuery: string,
      options: { route?: "none" | "push" | "replace" } = {},
    ): Promise<boolean | null> => {
      const requestedQuery = rawQuery.normalize("NFKC").trim().replace(/\s+/g, " ");
      if (!requestedQuery) {
        showHome(options.route !== "none");
        return false;
      }

      if (submittedSearchQuery.current === requestedQuery) {
        return null;
      }

      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      submittedSearchRequest.current?.abort();
      entryRequest.current?.abort();
      entryRequest.current = null;
      const controller = new AbortController();
      submittedSearchRequest.current = controller;
      submittedSearchQuery.current = requestedQuery;

      setQuery(requestedQuery);
      setSearchOpen(false);
      setSearchPending(false);
      setSearchError(null);
      setEntryPending(false);
      setView("search-results");
      setSearchResults({
        query: requestedQuery,
        items: [],
        pending: true,
        error: null,
      });

      try {
        const primaryItems = await dictionaryClient.search(requestedQuery, {
          limit: 20,
          signal: controller.signal,
        });
        if (submittedSearchRequest.current !== controller || controller.signal.aborted) {
          return null;
        }

        let resolution = resolveSearchMatches(requestedQuery, primaryItems);
        if (resolution.kind === "candidates" && resolution.items.length === 0) {
          for (const fallbackQuery of fallbackSearchQueries(requestedQuery)) {
            const fallbackItems = await dictionaryClient.search(fallbackQuery, {
              limit: 20,
              signal: controller.signal,
            });
            if (fallbackItems.length) {
              resolution = { kind: "candidates", items: fallbackItems };
              break;
            }
          }
        }
        if (submittedSearchRequest.current !== controller || controller.signal.aborted) {
          return null;
        }
        setSearchResults({
          query: requestedQuery,
          items: resolution.kind === "candidates" ? resolution.items : primaryItems,
          pending: false,
          error: null,
        });

        if (resolution.kind === "direct") {
          submittedSearchRequest.current = null;
          const route = options.route === "none" ? "replace" : options.route ?? "push";
          return await selectEntry(resolution.entryId, { route });
        }

        const route = options.route ?? "push";
        if (route !== "none") {
          updateRoute(
            `${window.location.pathname}?q=${encodeURIComponent(requestedQuery)}`,
            route,
          );
        }
        window.scrollTo({ top: 0, behavior: "auto" });
        return true;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }
        setSearchResults({
          query: requestedQuery,
          items: [],
          pending: false,
          error: "词典服务暂不可用",
        });
        const route = options.route ?? "push";
        if (route !== "none") {
          updateRoute(
            `${window.location.pathname}?q=${encodeURIComponent(requestedQuery)}`,
            route,
          );
        }
        return false;
      } finally {
        if (submittedSearchRequest.current === controller) {
          submittedSearchRequest.current = null;
        }
        if (submittedSearchQuery.current === requestedQuery) {
          submittedSearchQuery.current = null;
        }
      }
    },
    [selectEntry, showHome],
  );

  useEffect(() => {
    const syncLocation = () => {
      const parameters = new URLSearchParams(window.location.search);
      const requestedEntry = parameters.get("entry");
      const requestedQuery = parameters.get("q");
      if (requestedEntry) {
        setView("loading");
        void selectEntry(requestedEntry, { route: "none" }).then((loaded) => {
          if (loaded === false) {
            window.history.replaceState(null, "", window.location.pathname);
            showHome(false);
          }
        });
        return;
      }
      if (requestedQuery?.trim()) {
        void runSearch(requestedQuery, { route: "none" });
        return;
      }
      showHome(false);
    };

    const learningDataTimer = window.setTimeout(() => {
      void refreshLearningData();
    }, 0);
    syncLocation();
    window.addEventListener("popstate", syncLocation);

    return () => {
      window.clearTimeout(learningDataTimer);
      window.removeEventListener("popstate", syncLocation);
      suggestionRequest.current?.abort();
      submittedSearchRequest.current?.abort();
      entryRequest.current?.abort();
    };
  }, [refreshLearningData, runSearch, selectEntry, showHome]);

  useEffect(() => {
    const normalized = query.trim();
    if (!searchOpen || !normalized) {
      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      return;
    }

    const controller = new AbortController();
    suggestionRequest.current?.abort();
    suggestionRequest.current = controller;
    const timer = window.setTimeout(() => {
      setSearchPending(true);
      void dictionaryClient
        .search(normalized, { limit: 10, signal: controller.signal })
        .then((results) => {
          if (suggestionRequest.current !== controller) {
            return;
          }
          setSuggestions(results);
          setSearchError(null);
        })
        .catch((error) => {
          if (!isAbortError(error) && suggestionRequest.current === controller) {
            setSuggestions([]);
            setSearchError("词典服务暂不可用");
          }
        })
        .finally(() => {
          if (suggestionRequest.current === controller) {
            suggestionRequest.current = null;
            setSearchPending(false);
          }
        });
    }, 180);

    return () => {
      controller.abort();
      if (suggestionRequest.current === controller) {
        suggestionRequest.current = null;
      }
      window.clearTimeout(timer);
    };
  }, [query, searchOpen]);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedQuery = normalizeSearchQuery(query);
    const currentEntryIsOpen =
      view === "entry" && normalizeSearchQuery(entry.headword) === normalizedQuery;
    const currentResultsAreShown =
      view === "search-results" &&
      !searchResults.error &&
      normalizeSearchQuery(searchResults.query) === normalizedQuery;
    if (normalizedQuery && (currentEntryIsOpen || currentResultsAreShown)) {
      setSearchOpen(false);
      setSearchPending(false);
      return;
    }
    void runSearch(query, { route: "push" });
  };

  const updateQuery = (value: string) => {
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    submittedSearchRequest.current?.abort();
    submittedSearchRequest.current = null;
    submittedSearchQuery.current = null;
    setQuery(value);
    setSuggestions([]);
    if (!value.trim()) {
      setSearchPending(false);
    }
    setSearchError(null);
    setSearchOpen(true);
  };

  const clearQuery = () => {
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    submittedSearchRequest.current?.abort();
    submittedSearchRequest.current = null;
    submittedSearchQuery.current = null;
    setQuery("");
    setSuggestions([]);
    setSearchPending(false);
    setSearchError(null);
    setSearchOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const toggleFavorite = async () => {
    const next = await learningData.setFavorite(
      {
        dictionaryId: entry.dictionaryId,
        entryId: entry.id,
        headword: entry.headword,
      },
      !favorite,
    );
    setFavorite(next);
    await refreshLearningData();
  };

  const saveNote = async () => {
    await learningData.saveNote(
      {
        dictionaryId: entry.dictionaryId,
        entryId: entry.id,
        headword: entry.headword,
      },
      note,
    );
    await refreshLearningData();
    setDrawer(null);
  };

  const playAudio = useCallback((key: string, kind: "headword" | "example") => {
    activeAudio.current?.pause();
    const source =
      kind === "headword"
        ? dictionaryClient.headwordAudioUrl(key)
        : dictionaryClient.exampleAudioUrl(key);
    const audio = new Audio(source);
    activeAudio.current = audio;
    setAudioError(null);
    void audio.play().catch(() => {
      if (activeAudio.current === audio) {
        setAudioError("音频暂不可用");
      }
    });
  }, []);

  useEffect(
    () => () => {
      activeAudio.current?.pause();
      activeAudio.current = null;
    },
    [],
  );

  const openLibrary = async (tab: "history" | "favorites") => {
    await refreshLearningData();
    setDrawer({ mode: "library", tab });
  };

  const projection = useMemo(
    () => projectEntryPart(entry, activePartIndex),
    [activePartIndex, entry],
  );
  const sidebarItems = projection.navigation;

  const scrollToSection = useCallback((sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  const changePart = (index: number) => {
    setActivePartIndex(index);
    setActiveSectionId("definitions");
    window.requestAnimationFrame(() => scrollToSection("definitions"));
  };

  useEffect(() => {
    let frame = 0;
    const updateActiveSection = () => {
      frame = 0;
      const current = activeSectionForScroll(
        sidebarItems.flatMap((item) => {
          const section = document.getElementById(item.id);
          return section ? [{ id: item.id, top: section.getBoundingClientRect().top }] : [];
        }),
        {
          anchor: 80,
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight,
        },
        sidebarItems[0]?.id ?? "definitions",
      );
      setActiveSectionId(current);
    };
    const handleScroll = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(updateActiveSection);
      }
    };

    updateActiveSection();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [entry.id, sidebarItems]);

  return (
    <main className="dictionary-app" id="dictionary-top">
      <DictionaryHeader
        homeMode={view === "home"}
        query={query}
        suggestions={suggestions}
        history={history}
        searchPending={searchPending}
        searchOpen={searchOpen}
        searchError={searchError}
        inputRef={inputRef}
        onQueryChange={updateQuery}
        onClearQuery={clearQuery}
        onSearchFocus={() => setSearchOpen(true)}
        onSearchBlur={() => window.setTimeout(() => {
          setSearchOpen(false);
          setSearchPending(false);
        }, 100)}
        onDismissSearch={() => {
          setSearchOpen(false);
          setSearchPending(false);
        }}
        onSubmit={submitSearch}
        onHome={() => showHome(true)}
        onSelect={(entryId) => void selectEntry(entryId, { route: "push" })}
        onOpenLibrary={(tab) => void openLibrary(tab)}
      />

      {view === "home" ? (
        <DictionaryHome
          history={history}
          favorites={favorites}
          onSelect={(entryId) => void selectEntry(entryId, { route: "push" })}
          onOpenLibrary={(tab) => void openLibrary(tab)}
        />
      ) : view === "loading" ? (
        <div className="entry-loading-shell" role="status" aria-label="正在加载词条">
          <span aria-hidden="true" />
        </div>
      ) : view === "search-results" ? (
        <div className="search-results-shell">
          <SearchResults
            error={searchResults.error}
            items={searchResults.items}
            onRetry={() => void runSearch(searchResults.query, { route: "none" })}
            onSelect={(entryId) => void selectEntry(entryId, { route: "push" })}
            pending={searchResults.pending}
            query={searchResults.query}
          />
        </div>
      ) : <div className="dictionary-shell">
        <aside className="entry-sidebar" aria-label="词条目录">
          <h2>目录</h2>
          <nav>
            {sidebarItems.map((item, index) => (
              <button
                className={item.id === activeSectionId ? "is-active" : ""}
                key={`${item.id}-${index}`}
                type="button"
                onClick={() => {
                  setActiveSectionId(item.id);
                  scrollToSection(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <button
            className="entry-back-to-top"
            type="button"
            title="回到顶部"
            aria-label="回到顶部"
            onClick={() => scrollToSection("dictionary-top")}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </aside>

        <section className="word-page" ref={wordPageRef}>
          <EntryView
            activeSectionId={activeSectionId}
            entry={entry}
            projection={projection}
            favorite={favorite}
            entryPending={entryPending}
            audioError={audioError}
            resolveIllustration={dictionaryClient.illustrationUrl}
            onPartChange={changePart}
            onSelectEntry={(entryId) => void selectEntry(entryId, { route: "push" })}
            onToggleFavorite={() => void toggleFavorite()}
            onOpenNote={() => setDrawer({ mode: "note" })}
            onPlayAudio={playAudio}
            onJump={scrollToSection}
          />
          <InlineLookup
            onLookup={(lookupQuery) => runSearch(lookupQuery, { route: "push" })}
            rootRef={wordPageRef}
          />
        </section>
      </div>}

      <WorkspaceDrawer
        {...(drawer?.mode === "note"
          ? {
              open: true as const,
              mode: "note" as const,
              headword: entry.headword,
              note,
              onNoteChange: setNote,
              onSaveNote: () => void saveNote(),
              onClose: () => setDrawer(null),
            }
          : drawer?.mode === "library"
            ? {
                open: true as const,
                mode: "library" as const,
                tab: drawer.tab,
                history,
                favorites,
                notes,
                onTabChange: (tab: LibraryTab) => setDrawer({ mode: "library", tab }),
                onSelect: (entryId: string) => {
                  setDrawer(null);
                  void selectEntry(entryId, { route: "push" });
                },
                onClose: () => setDrawer(null),
              }
            : { open: false as const, onClose: () => setDrawer(null) })}
      />
    </main>
  );
}
