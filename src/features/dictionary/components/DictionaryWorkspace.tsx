"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import type { CanonicalEntry } from "../../../../packages/dictionary-schema/src/index";
import type { SearchDocumentLocation } from "../../../../packages/dictionary-search/src/index";
import type {
  EtymologyArticleResponse,
  EtymologyResourceSummary,
} from "../../../../packages/enhancement-schema/src/index";
import {
  dictionaryClient,
  type SearchTarget,
} from "../../../lib/dictionary-client/client";
import { searchTargetKey } from "../../../lib/dictionary-client/search-target";
import {
  dictionarySearchRequestKey,
  parseChineseSearchScopes,
  type DictionarySearchScope,
} from "../../../lib/dictionary-client/search-scope";
import {
  learningData,
  type FavoriteRecord,
  type HistoryRecord,
  type LearningPreferences,
  type NoteRecord,
  type QueryHistoryRecord,
} from "../../../lib/storage/learning-data";
import { demoEntry } from "../demo-entry";
import { entryPartIndexFor, projectEntryPart } from "../entry-sections";
import {
  fallbackSearchQueries,
  isChineseSearchQuery,
  normalizeSearchQuery,
  resolveSearchMatches,
} from "../search-matches";
import { dictionarySearchErrorMessage } from "../search-errors";
import { activeSectionForScroll } from "../scroll-spy-model";
import { createResultPageSessionStore } from "../result-page-session";
import {
  parseWorkspaceRoute,
  workspaceRouteUrl,
  type EtymologyRoute,
  type WorkspaceRoute as WorkspaceInitialRoute,
} from "../workspace-route";
import { DictionaryHeader } from "./DictionaryHeader";
import { DictionaryHome } from "./DictionaryHome";
import { DialogPortalProvider } from "./DialogPortal";
import { EntryView } from "./EntryView";
import { EtymologyOnlyView } from "./EtymologyOnlyView";
import { InlineLookup } from "./InlineLookup";
import { SearchResults } from "./SearchResults";
import { type LibraryTab, WorkspaceDrawer } from "./WorkspaceDrawer";

type DrawerState =
  | { mode: "note" }
  | { mode: "library"; tab: LibraryTab }
  | null;

type WorkspaceView = "home" | "loading" | "entry" | "etymology" | "search-results";

export type { WorkspaceRoute as WorkspaceInitialRoute } from "../workspace-route";

type DictionaryWorkspaceProps = {
  initialRoute?: WorkspaceInitialRoute;
};

type SearchResultsState = {
  query: string;
  scope?: DictionarySearchScope[];
  items: SearchTarget[];
  pending: boolean;
  error: string | null;
  nextOffset: number | null;
  loadingMore: boolean;
  loadMoreError: string | null;
  articleTarget?: EtymologyRoute;
};

const initialReverseResultCount = 32;
const maximumReverseResultCount = 512;
const maximumCachedResultPages = 3;

function normalizeSubmittedQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function nextReverseResultCount(offset: number): number {
  return Math.min(Math.max(offset, initialReverseResultCount) * 2, maximumReverseResultCount);
}

const emptySearchResults: SearchResultsState = {
  query: "",
  items: [],
  pending: false,
  error: null,
  nextOffset: null,
  loadingMore: false,
  loadMoreError: null,
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
  const [enhancements, setEnhancements] = useState<EtymologyResourceSummary[]>([]);
  const [prefetchedEtymologyArticle, setPrefetchedEtymologyArticle] = useState<
    EtymologyArticleResponse | undefined
  >();
  const [autoOpenEtymology, setAutoOpenEtymology] = useState(false);
  const [etymology, setEtymology] = useState<EtymologyRoute | undefined>(
    initialRoute.kind === "entry"
      ? initialRoute.etymology
      : initialRoute.kind === "etymology"
        ? initialRoute.etymology
        : undefined,
  );
  const [view, setView] = useState<WorkspaceView>(
    initialRoute.kind === "home"
      ? "home"
      : "loading",
  );
  const [searchResults, setSearchResults] = useState<SearchResultsState>(
    initialRoute.kind === "query"
      ? {
          query: initialRoute.query,
          scope: initialRoute.scope,
          items: [],
          pending: true,
          error: null,
          nextOffset: null,
          loadingMore: false,
          loadMoreError: null,
        }
      : emptySearchResults,
  );
  const [suggestions, setSuggestions] = useState<SearchTarget[]>([]);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [fontScale, setFontScale] = useState<LearningPreferences["fontScale"]>("default");
  const [favorite, setFavorite] = useState(false);
  const [note, setNote] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [entryPending, setEntryPending] = useState(initialRoute.kind === "entry");
  const [activePartIndex, setActivePartIndex] = useState(0);
  const [activeSectionId, setActiveSectionId] = useState("definitions");
  const [pendingSearchLocation, setPendingSearchLocation] = useState<
    SearchDocumentLocation | undefined
  >();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wordPageRef = useRef<HTMLElement>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const submittedSearchRequest = useRef<AbortController | null>(null);
  const resultPageRequest = useRef<AbortController | null>(null);
  const submittedSearchKey = useRef<string | null>(null);
  const queryHistoryMutationRevision = useRef(0);
  const fontScaleMutationRevision = useRef(0);
  const fontScaleWrite = useRef<Promise<void>>(Promise.resolve());
  const entryRequest = useRef<AbortController | null>(null);
  const etymologyNavigationRequest = useRef<AbortController | null>(null);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const viewState = useRef(view);
  const searchResultsState = useRef(searchResults);
  const resultPageRestoreFrame = useRef<number | null>(null);
  const [resultPageSessions] = useState(
    () => createResultPageSessionStore<SearchResultsState>(maximumCachedResultPages),
  );

  useLayoutEffect(() => {
    viewState.current = view;
    searchResultsState.current = searchResults;
  }, [searchResults, view]);

  const cancelResultPageScrollRestore = useCallback((): void => {
    if (resultPageRestoreFrame.current !== null) {
      window.cancelAnimationFrame(resultPageRestoreFrame.current);
      resultPageRestoreFrame.current = null;
    }
  }, []);

  const scheduleResultPageScrollRestore = useCallback((scrollY: number): void => {
    cancelResultPageScrollRestore();
    resultPageRestoreFrame.current = window.requestAnimationFrame(() => {
      resultPageRestoreFrame.current = window.requestAnimationFrame(() => {
        resultPageRestoreFrame.current = null;
        window.scrollTo({ top: scrollY, behavior: "auto" });
      });
    });
  }, [cancelResultPageScrollRestore]);

  const captureResultPageSession = useCallback((): void => {
    const current = searchResultsState.current;
    if (
      viewState.current !== "search-results" ||
      current.pending ||
      !current.items.length
    ) {
      return;
    }
    resultPageSessions.write(
      dictionarySearchRequestKey(current.query, current.scope),
      {
        state: { ...current, loadingMore: false },
        scrollY: Math.max(0, window.scrollY),
      },
    );
  }, [resultPageSessions]);

  const restoreResultPageSession = useCallback((
    rawQuery: string,
    requestedScope?: readonly DictionarySearchScope[],
  ): boolean => {
    const requestedQuery = normalizeSubmittedQuery(rawQuery);
    const scope = isChineseSearchQuery(requestedQuery)
      ? parseChineseSearchScopes(requestedScope?.join(","))
      : undefined;
    const session = resultPageSessions.read(
      dictionarySearchRequestKey(requestedQuery, scope),
    );
    if (!session) {
      return false;
    }

    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    submittedSearchRequest.current?.abort();
    submittedSearchRequest.current = null;
    submittedSearchKey.current = null;
    resultPageRequest.current?.abort();
    resultPageRequest.current = null;
    entryRequest.current?.abort();
    entryRequest.current = null;
    etymologyNavigationRequest.current?.abort();
    etymologyNavigationRequest.current = null;
    activeAudio.current?.pause();

    setQuery(session.state.query);
    setSearchResults({ ...session.state, pending: false, loadingMore: false });
    setEtymology(undefined);
    setAutoOpenEtymology(false);
    setEntryPending(false);
    setSearchOpen(false);
    setSearchPending(false);
    setSuggestions([]);
    setSearchError(null);
    setAudioError(null);
    setPendingSearchLocation(undefined);
    setDrawer(null);
    setView("search-results");
    scheduleResultPageScrollRestore(session.scrollY);
    return true;
  }, [resultPageSessions, scheduleResultPageScrollRestore]);

  const refreshLearningData = useCallback(async () => {
    const [nextQueryHistory, nextHistory, nextFavorites, nextNotes] = await Promise.all([
      learningData.listQueryHistory(),
      learningData.listHistory(),
      learningData.listFavorites(),
      learningData.listNotes(),
    ]);
    setQueryHistory(nextQueryHistory);
    setHistory(nextHistory);
    setFavorites(nextFavorites);
    setNotes(nextNotes);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revision = fontScaleMutationRevision.current;
    void learningData.getPreferences().then((preferences) => {
      if (!cancelled && fontScaleMutationRevision.current === revision) {
        setFontScale(preferences.fontScale);
      }
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const updateFontScale = useCallback((nextFontScale: LearningPreferences["fontScale"]): void => {
    fontScaleMutationRevision.current += 1;
    setFontScale(nextFontScale);
    fontScaleWrite.current = fontScaleWrite.current
      .catch(() => undefined)
      .then(async () => {
        await learningData.updatePreferences({ fontScale: nextFontScale });
      });
  }, []);

  const resyncQueryHistory = useCallback(async (revision: number): Promise<void> => {
    try {
      const records = await learningData.listQueryHistory();
      if (queryHistoryMutationRevision.current === revision) {
        setQueryHistory(records);
      }
    } catch {
      // Personal history must never block dictionary navigation.
    }
  }, []);

  const recordExplicitQuery = useCallback((rawQuery: string): void => {
    const revision = ++queryHistoryMutationRevision.current;
    void learningData.recordQueryHistory(rawQuery).then(
      () => resyncQueryHistory(revision),
      () => resyncQueryHistory(revision),
    );
  }, [resyncQueryHistory]);

  const deleteQueryHistory = useCallback((key: string): void => {
    const revision = ++queryHistoryMutationRevision.current;
    setQueryHistory((current) => current.filter((record) => record.key !== key));
    void learningData.deleteQueryHistory(key).then(
      () => resyncQueryHistory(revision),
      () => resyncQueryHistory(revision),
    );
  }, [resyncQueryHistory]);

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
      options: {
        route?: "none" | "push" | "replace";
        etymology?: EtymologyRoute;
        searchLocation?: SearchDocumentLocation;
      } = {},
    ): Promise<boolean | null> => {
      captureResultPageSession();
      cancelResultPageScrollRestore();
      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      etymologyNavigationRequest.current?.abort();
      etymologyNavigationRequest.current = null;
      submittedSearchRequest.current?.abort();
      submittedSearchRequest.current = null;
      resultPageRequest.current?.abort();
      resultPageRequest.current = null;
      entryRequest.current?.abort();
      const controller = new AbortController();
      entryRequest.current = controller;
      setEntryPending(true);
      setEtymology(options.etymology);
      if (!options.etymology?.articleId) {
        setPrefetchedEtymologyArticle(undefined);
      }
      setSearchOpen(false);
      setSearchPending(false);
      setSuggestions([]);
      setPendingSearchLocation(undefined);

      try {
        const loadedEntry = await dictionaryClient.entry(entryId, controller.signal);
        if (entryRequest.current !== controller || controller.signal.aborted) {
          return null;
        }
        setSearchError(null);
        setView("entry");
        setEntry(loadedEntry.entry);
        setEnhancements(loadedEntry.enhancements);
        setFavorite(false);
        setNote("");
        const searchLocation = options.searchLocation;
        setActivePartIndex(entryPartIndexFor(loadedEntry.entry, searchLocation?.part));
        setActiveSectionId(
          searchLocation && searchLocation.section !== "grammar-usage"
            ? searchLocation.section
            : "definitions",
        );
        setPendingSearchLocation(searchLocation);
        setQuery(loadedEntry.entry.headword);
        const route = options.route ?? "push";
        if (route !== "none") {
          updateRoute(
            workspaceRouteUrl(window.location.pathname, {
              kind: "entry",
              entryId: loadedEntry.entry.id,
              ...(options.etymology ? { etymology: options.etymology } : {}),
            }),
            route,
          );
        }
        if (!searchLocation) {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        const learningState = await loadEntryLearningState(loadedEntry.entry);
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
          setPendingSearchLocation(undefined);
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
    [cancelResultPageScrollRestore, captureResultPageSession, loadEntryLearningState],
  );

  const selectEtymology = useCallback(
    (
      nextEtymology: EtymologyRoute,
      options: { route?: "none" | "push" | "replace"; openFirstArticle?: boolean } = {},
    ): void => {
      captureResultPageSession();
      cancelResultPageScrollRestore();
      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      etymologyNavigationRequest.current?.abort();
      etymologyNavigationRequest.current = null;
      submittedSearchRequest.current?.abort();
      submittedSearchRequest.current = null;
      resultPageRequest.current?.abort();
      resultPageRequest.current = null;
      entryRequest.current?.abort();
      entryRequest.current = null;
      setEtymology(nextEtymology);
      setAutoOpenEtymology(options.openFirstArticle ?? false);
      if (!nextEtymology.articleId) {
        setPrefetchedEtymologyArticle(undefined);
      }
      setEntryPending(false);
      setSearchOpen(false);
      setSearchPending(false);
      setSuggestions([]);
      setPendingSearchLocation(undefined);
      setSearchError(null);
      setView("etymology");
      setQuery(nextEtymology.term);
      const route = options.route ?? "push";
      if (route !== "none") {
        updateRoute(
          workspaceRouteUrl(window.location.pathname, {
            kind: "etymology",
            etymology: nextEtymology,
          }),
          route,
        );
      }
      window.scrollTo({ top: 0, behavior: "auto" });
    },
    [cancelResultPageScrollRestore, captureResultPageSession],
  );

  const selectSearchTarget = useCallback(
    (
      target: SearchTarget,
      options: {
        route?: "none" | "push" | "replace";
        articleTarget?: EtymologyRoute;
        searchLocation?: SearchDocumentLocation;
      } = {},
    ): Promise<boolean | null> => {
      if (target.kind === "etymology") {
        selectEtymology(
          { term: target.id, articleId: options.articleTarget?.articleId },
          { route: options.route, openFirstArticle: !options.articleTarget?.articleId },
        );
        return Promise.resolve(true);
      }
      return selectEntry(target.id, {
        route: options.route,
        etymology: options.articleTarget,
        searchLocation: options.searchLocation ?? target.matches?.[0]?.location,
      });
    },
    [selectEntry, selectEtymology],
  );

  const showHome = useCallback((shouldUpdateRoute: boolean): void => {
    captureResultPageSession();
    cancelResultPageScrollRestore();
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    submittedSearchRequest.current?.abort();
    submittedSearchRequest.current = null;
    resultPageRequest.current?.abort();
    resultPageRequest.current = null;
    submittedSearchKey.current = null;
    entryRequest.current?.abort();
    entryRequest.current = null;
    activeAudio.current?.pause();
    etymologyNavigationRequest.current?.abort();
    etymologyNavigationRequest.current = null;
    setPrefetchedEtymologyArticle(undefined);
    setView("home");
    setEnhancements([]);
    setEtymology(undefined);
    setAutoOpenEtymology(false);
    setSearchResults(emptySearchResults);
    setEntryPending(false);
    setSearchOpen(false);
    setSearchPending(false);
    setSuggestions([]);
    setSearchError(null);
    setAudioError(null);
    setActivePartIndex(0);
    setActiveSectionId("definitions");
    setPendingSearchLocation(undefined);
    setDrawer(null);
    setQuery("");
    if (shouldUpdateRoute) {
      const homeUrl = window.location.pathname;
      updateRoute(homeUrl, "push");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [cancelResultPageScrollRestore, captureResultPageSession]);

  const runSearch = useCallback(
    async (
      rawQuery: string,
      options: {
        preserveResultPage?: boolean;
        route?: "none" | "push" | "replace";
        targetArticleId?: string;
        scope?: readonly DictionarySearchScope[];
      } = {},
    ): Promise<boolean | null> => {
      const requestedQuery = normalizeSubmittedQuery(rawQuery);
      if (!requestedQuery) {
        showHome(options.route !== "none");
        return false;
      }

      captureResultPageSession();
      cancelResultPageScrollRestore();

      const reverseLookup = isChineseSearchQuery(requestedQuery);
      const scope = reverseLookup
        ? parseChineseSearchScopes(options.scope?.join(","))
        : undefined;
      const previousResults = searchResultsState.current;
      const preserveResultPage =
        options.preserveResultPage === true &&
        viewState.current === "search-results" &&
        normalizeSubmittedQuery(previousResults.query) === requestedQuery;
      const requestKey = dictionarySearchRequestKey(requestedQuery, scope);
      if (
        submittedSearchKey.current === requestKey &&
        submittedSearchRequest.current &&
        !submittedSearchRequest.current.signal.aborted
      ) {
        return null;
      }

      suggestionRequest.current?.abort();
      suggestionRequest.current = null;
      etymologyNavigationRequest.current?.abort();
      etymologyNavigationRequest.current = null;
      submittedSearchRequest.current?.abort();
      resultPageRequest.current?.abort();
      resultPageRequest.current = null;
      entryRequest.current?.abort();
      entryRequest.current = null;
      const controller = new AbortController();
      submittedSearchRequest.current = controller;
      submittedSearchKey.current = requestKey;

      setQuery(requestedQuery);
      if (!options.targetArticleId) {
        setPrefetchedEtymologyArticle(undefined);
      }
      setSearchOpen(false);
      setSearchPending(false);
      setSearchError(null);
      setEntryPending(false);
      setPendingSearchLocation(undefined);
      if (!preserveResultPage) {
        setView("loading");
      }
      setSearchResults({
        query: requestedQuery,
        scope,
        items: preserveResultPage ? previousResults.items : [],
        pending: true,
        error: null,
        nextOffset: null,
        loadingMore: false,
        loadMoreError: null,
      });

      try {
        const primaryPage = reverseLookup
          ? await dictionaryClient.searchPage(requestedQuery, {
              limit: initialReverseResultCount,
              scope,
              signal: controller.signal,
            })
          : {
              items: await dictionaryClient.search(requestedQuery, {
                limit: 20,
                signal: controller.signal,
              }),
              nextOffset: null,
            };
        if (submittedSearchRequest.current !== controller || controller.signal.aborted) {
          return null;
        }

        let resolution = resolveSearchMatches(requestedQuery, primaryPage.items);
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
        if (resolution.kind === "direct") {
          submittedSearchRequest.current = null;
          const route = options.route === "none" ? "replace" : options.route ?? "push";
          const articleTarget = options.targetArticleId
            ? { term: requestedQuery, articleId: options.targetArticleId }
            : undefined;
          return await selectSearchTarget(resolution.target, { route, articleTarget });
        }

        setSearchResults({
          query: requestedQuery,
          scope,
          items: resolution.items,
          pending: false,
          error: null,
          nextOffset: reverseLookup ? primaryPage.nextOffset : null,
          loadingMore: false,
          loadMoreError: null,
          articleTarget: options.targetArticleId
            ? { term: requestedQuery, articleId: options.targetArticleId }
            : undefined,
        });
        setView("search-results");
        const route = options.route ?? "push";
        if (route !== "none") {
          updateRoute(workspaceRouteUrl(window.location.pathname, {
            kind: "query",
            query: requestedQuery,
            ...(scope ? { scope } : {}),
          }), route);
        }
        window.scrollTo({ top: 0, behavior: "auto" });
        return true;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }
        if (submittedSearchRequest.current !== controller || controller.signal.aborted) {
          return null;
        }
        setSearchResults({
          query: requestedQuery,
          scope,
          items: [],
          pending: false,
          error: dictionarySearchErrorMessage(error),
          nextOffset: null,
          loadingMore: false,
          loadMoreError: null,
        });
        setView("search-results");
        const route = options.route ?? "push";
        if (route !== "none") {
          updateRoute(workspaceRouteUrl(window.location.pathname, {
            kind: "query",
            query: requestedQuery,
            ...(scope ? { scope } : {}),
          }), route);
        }
        return false;
      } finally {
        if (submittedSearchRequest.current === controller) {
          submittedSearchRequest.current = null;
          if (submittedSearchKey.current === requestKey) {
            submittedSearchKey.current = null;
          }
        }
      }
  },
    [cancelResultPageScrollRestore, captureResultPageSession, selectSearchTarget, showHome],
  );

  const loadMoreSearchResults = useCallback(async (): Promise<void> => {
    const requestedQuery = searchResults.query;
    const scope = searchResults.scope;
    const offset = searchResults.nextOffset;
    if (
      offset === null ||
      searchResults.pending ||
      searchResults.loadingMore ||
      !isChineseSearchQuery(requestedQuery)
    ) {
      return;
    }

    resultPageRequest.current?.abort();
    const controller = new AbortController();
    resultPageRequest.current = controller;
    const targetCount = nextReverseResultCount(offset);
    setSearchResults((current) =>
      current.query === requestedQuery
        ? { ...current, loadingMore: true, loadMoreError: null }
        : current,
    );

    try {
      const page = await dictionaryClient.searchPage(requestedQuery, {
        limit: targetCount - offset,
        offset,
        scope,
        signal: controller.signal,
      });
      if (resultPageRequest.current !== controller || controller.signal.aborted) {
        return;
      }
      setSearchResults((current) => {
        if (
          current.query !== requestedQuery ||
          current.nextOffset !== offset ||
          dictionarySearchRequestKey(current.query, current.scope) !==
            dictionarySearchRequestKey(requestedQuery, scope)
        ) {
          return current;
        }
        const seen = new Set(current.items.map(searchTargetKey));
        const additions = page.items.filter((item) => {
          const key = searchTargetKey(item);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
        return {
          ...current,
          items: [...current.items, ...additions],
          nextOffset: page.nextOffset,
          loadMoreError: null,
        };
      });
    } catch (error) {
      if (!isAbortError(error) && resultPageRequest.current === controller) {
        setSearchResults((current) =>
          current.query === requestedQuery
            && dictionarySearchRequestKey(current.query, current.scope) ===
              dictionarySearchRequestKey(requestedQuery, scope)
            ? { ...current, loadMoreError: "更多结果暂时无法加载" }
            : current,
        );
      }
    } finally {
      if (resultPageRequest.current === controller) {
        resultPageRequest.current = null;
        setSearchResults((current) =>
          current.query === requestedQuery
            && dictionarySearchRequestKey(current.query, current.scope) ===
              dictionarySearchRequestKey(requestedQuery, scope)
            ? { ...current, loadingMore: false }
            : current,
        );
      }
    }
  }, [searchResults]);

  const navigateEtymologyLink = useCallback((term: string, articleId?: string) => {
    if (!articleId) {
      void runSearch(term, { route: "push" });
      return;
    }
    etymologyNavigationRequest.current?.abort();
    const controller = new AbortController();
    etymologyNavigationRequest.current = controller;
    void dictionaryClient
      .etymologyArticle(articleId, controller.signal)
      .then((article) => {
        if (etymologyNavigationRequest.current !== controller || controller.signal.aborted) {
          return;
        }
        setPrefetchedEtymologyArticle(article);
        void runSearch(article.term, { route: "push", targetArticleId: article.article.id });
      })
      .catch((error) => {
        if (!isAbortError(error) && etymologyNavigationRequest.current === controller) {
          setSearchError("词源内容暂不可用");
        }
      })
      .finally(() => {
        if (etymologyNavigationRequest.current === controller) {
          etymologyNavigationRequest.current = null;
        }
      });
  }, [runSearch]);

  useEffect(() => {
    const syncLocation = () => {
      captureResultPageSession();
      const route = parseWorkspaceRoute(new URLSearchParams(window.location.search));
      if (route.kind === "entry") {
        setView("loading");
        void selectEntry(route.entryId, { route: "none", etymology: route.etymology }).then((loaded) => {
          if (loaded === false) {
            window.history.replaceState(null, "", window.location.pathname);
            showHome(false);
          }
        });
        return;
      }
      if (route.kind === "etymology") {
        selectEtymology(route.etymology, { route: "none" });
        return;
      }
      if (route.kind === "query") {
        if (restoreResultPageSession(route.query, route.scope)) {
          return;
        }
        updateRoute(workspaceRouteUrl(window.location.pathname, route), "replace");
        void runSearch(route.query, { route: "none", scope: route.scope });
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
      resultPageRequest.current?.abort();
      entryRequest.current?.abort();
      etymologyNavigationRequest.current?.abort();
      cancelResultPageScrollRestore();
    };
  }, [
    cancelResultPageScrollRestore,
    captureResultPageSession,
    refreshLearningData,
    restoreResultPageSession,
    runSearch,
    selectEntry,
    selectEtymology,
    showHome,
  ]);

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
            setSearchError(dictionarySearchErrorMessage(error));
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
    if (normalizedQuery) {
      recordExplicitQuery(query);
    }
    const currentEntryIsOpen =
      (view === "entry" && normalizeSearchQuery(entry.headword) === normalizedQuery) ||
      (view === "etymology" && normalizeSearchQuery(etymology?.term ?? "") === normalizedQuery);
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
    resultPageRequest.current?.abort();
    resultPageRequest.current = null;
    submittedSearchKey.current = null;
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
    resultPageRequest.current?.abort();
    resultPageRequest.current = null;
    submittedSearchKey.current = null;
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

  const runLibraryBulkAction = useCallback(async (
    tab: LibraryTab,
    keys: string[],
  ): Promise<void> => {
    if (tab === "history") {
      await learningData.deleteHistory(keys);
    } else if (tab === "favorites") {
      await learningData.removeFavorites(keys);
    } else {
      await learningData.deleteNotes(keys);
    }

    const identity = { dictionaryId: entry.dictionaryId, entryId: entry.id };
    const [nextQueryHistory, nextHistory, nextFavorites, nextNotes, nextFavorite, nextNote] =
      await Promise.all([
        learningData.listQueryHistory(),
        learningData.listHistory(),
        learningData.listFavorites(),
        learningData.listNotes(),
        learningData.isFavorite(identity),
        learningData.getNote(identity),
      ]);
    setQueryHistory(nextQueryHistory);
    setHistory(nextHistory);
    setFavorites(nextFavorites);
    setNotes(nextNotes);
    setFavorite(nextFavorite);
    setNote(nextNote?.text ?? "");
  }, [entry.dictionaryId, entry.id]);

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
    setPendingSearchLocation(undefined);
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
    <DialogPortalProvider fontScale={fontScale}>
      <main className="dictionary-app" data-font-scale={fontScale} id="dictionary-top">
        <DictionaryHeader
          homeMode={view === "home"}
          query={query}
          suggestions={suggestions}
          queryHistory={queryHistory}
          searchPending={searchPending}
          searchOpen={searchOpen}
          searchError={searchError}
          fontScale={fontScale}
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
          onSelect={(target) => {
            recordExplicitQuery(query || target.headword);
            void selectSearchTarget(target, { route: "push" });
          }}
          onSelectQueryHistory={(historicalQuery) => {
            setQuery(historicalQuery);
            recordExplicitQuery(historicalQuery);
            void runSearch(historicalQuery, { route: "push" });
          }}
          onDeleteQueryHistory={deleteQueryHistory}
          onFontScaleChange={updateFontScale}
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
              hasMore={searchResults.nextOffset !== null}
              items={searchResults.items}
              loadingMore={searchResults.loadingMore}
              loadMoreError={searchResults.loadMoreError}
              nextResultCount={searchResults.nextOffset === null
                ? undefined
                : nextReverseResultCount(searchResults.nextOffset)}
              onLoadMore={() => void loadMoreSearchResults()}
              onRetry={() => void runSearch(searchResults.query, {
                route: "none",
                scope: searchResults.scope,
              })}
              onScopeChange={(scope) => void runSearch(searchResults.query, {
                preserveResultPage: true,
                route: "push",
                scope,
              })}
              onSelect={(target, match) => void selectSearchTarget(target, {
                route: "push",
                articleTarget: searchResults.articleTarget,
                searchLocation: match?.location,
              })}
              pending={searchResults.pending}
              query={searchResults.query}
              scope={searchResults.scope}
            />
          </div>
        ) : view === "etymology" && etymology ? (
          <div className="etymology-only-shell">
            <EtymologyOnlyView
              articleId={etymology.articleId}
              autoOpen={autoOpenEtymology}
              prefetchedArticle={prefetchedEtymologyArticle}
              onArticleChange={(articleId) => {
                const next = { term: etymology.term, articleId };
                setEtymology(next);
                updateRoute(
                  workspaceRouteUrl(window.location.pathname, { kind: "etymology", etymology: next }),
                  "push",
                );
              }}
              onNavigate={navigateEtymologyLink}
              term={etymology.term}
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
              enhancements={enhancements}
              projection={projection}
              favorite={favorite}
              entryPending={entryPending}
              audioError={audioError}
              resolveIllustration={dictionaryClient.illustrationUrl}
              onPartChange={changePart}
              onSelectEntry={(entryId) => void selectEntry(entryId, { route: "push" })}
              etymology={etymology}
              prefetchedEtymologyArticle={prefetchedEtymologyArticle}
              onEtymologyChange={(nextEtymology) => {
                setEtymology(nextEtymology ?? undefined);
                updateRoute(
                  workspaceRouteUrl(window.location.pathname, {
                    kind: "entry",
                    entryId: entry.id,
                    ...(nextEtymology ? { etymology: nextEtymology } : {}),
                  }),
                  "push",
                );
              }}
              onNavigateEtymology={navigateEtymologyLink}
              searchLocation={pendingSearchLocation}
              onSearchLocationSettled={(location) => {
                setPendingSearchLocation((current) => current === location ? undefined : current);
              }}
              onToggleFavorite={() => void toggleFavorite()}
              onOpenNote={() => setDrawer({ mode: "note" })}
              onPlayAudio={playAudio}
              onJump={scrollToSection}
            />
            <InlineLookup
              onLookup={(lookupQuery) => {
                recordExplicitQuery(lookupQuery);
                return runSearch(lookupQuery, { route: "push" });
              }}
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
                  onBulkAction: runLibraryBulkAction,
                  onSelect: (entryId: string) => {
                    setDrawer(null);
                    void selectEntry(entryId, { route: "push" });
                  },
                  onClose: () => setDrawer(null),
                }
              : { open: false as const, onClose: () => setDrawer(null) })}
        />
      </main>
    </DialogPortalProvider>
  );
}
