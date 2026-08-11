import { z } from "zod";

import {
  BundledBilingualAdapter,
  bundledBilingualEnvelopeSchema,
} from "../../../packages/adapters/src/index";
import type { CanonicalEntry } from "../../../packages/dictionary-schema/src/index";
import {
  searchDocumentLocationSchema,
} from "../../../packages/dictionary-search/src/index";
import {
  enhancementResourceSummariesSchema,
  etymologyArticleResponseSchema,
  etymologyResourceSummarySchema,
  type EtymologyArticleResponse,
  type EtymologyResourceSummary,
} from "../../../packages/enhancement-schema/src/index";
import {
  createDictionaryApiUrl,
  resolveDictionaryApiRoot,
} from "./api-url";
import {
  isChineseSearchQuery,
  DICTIONARY_SEARCH_SCOPE_ORDER,
  serializeDictionarySearchScopes,
} from "./search-scope";
import {
  dictionarySearchQueryLimit,
  type DictionarySearchMode,
} from "./search-mode";
import type {
  EnglishSearchCorrection,
  EnglishSearchGroup,
  SearchTarget,
} from "./search-target";

const dictionarySearchMatchSchema = z.object({
  scope: z.enum(DICTIONARY_SEARCH_SCOPE_ORDER),
  englishText: z.string().optional().default(""),
  chineseText: z.string(),
  location: searchDocumentLocationSchema,
  candidateText: z.string().optional(),
  definitionText: z.string().optional(),
  part: z.string().optional(),
  resourceCategory: z.string().min(1).max(64).optional(),
  semanticRole: z.enum([
    "definition",
    "qualifier",
    "guidance",
    "expression",
    "example",
    "heading",
    "context",
  ]).optional(),
  matchKind: z.enum([
    "headword",
    "variant",
    "phrase",
    "pattern",
    "etymology",
    "inflection",
  ]).optional(),
  relation: z.string().min(1).max(256).optional(),
}).transform((match) => ({
  ...match,
  ...(match.part ?? match.location.part
    ? { part: match.part ?? match.location.part }
    : {}),
  ...(match.resourceCategory ? { resourceCategory: match.resourceCategory } : {}),
  ...(match.semanticRole ? { semanticRole: match.semanticRole } : {}),
  ...(match.matchKind ? { matchKind: match.matchKind } : {}),
  ...(match.relation ? { relation: match.relation } : {}),
}));

const searchItemBaseSchema = z
  .object({
    id: z.string().optional(),
    entryId: z.string().optional(),
    headword: z.string(),
    partsOfSpeech: z.array(z.string()).optional(),
    translationPreview: z.string().optional(),
    headwordForms: z.array(z.string().min(1).max(256)).max(64).optional(),
  });

const dictionarySearchItemSchema = searchItemBaseSchema
  .extend({
    kind: z.literal("dictionary"),
    matches: z.array(dictionarySearchMatchSchema).optional(),
    matchesTotal: z.number().int().nonnegative().optional(),
  })
  .transform((item) => ({
    kind: "dictionary" as const,
    id: item.id ?? item.entryId ?? "",
    headword: item.headword,
    partsOfSpeech: item.partsOfSpeech ?? [],
    translationPreview: item.translationPreview ?? "",
    headwordForms: item.headwordForms ?? [],
    ...(item.matches?.length ? { matches: item.matches } : {}),
    ...(item.matchesTotal !== undefined ? { matchesTotal: item.matchesTotal } : {}),
  }))
  .refine((item) => item.id.length > 0, "Search result is missing an entry id.");

const etymologySearchItemSchema = searchItemBaseSchema
  .extend({
    kind: z.literal("etymology"),
    id: z.string().min(1),
  })
  .transform((item) => ({
    kind: "etymology" as const,
    id: item.id,
    headword: item.headword,
    partsOfSpeech: item.partsOfSpeech ?? [],
    translationPreview: item.translationPreview ?? "",
  }));

const searchItemSchema = z.discriminatedUnion("kind", [
  dictionarySearchItemSchema,
  etymologySearchItemSchema,
]);

const englishSearchGroupSchema = z.object({
  text: z.string(),
  kind: z.enum(["exact", "phrase", "token"]),
  items: z.array(searchItemSchema),
});

const englishSearchCorrectionSchema = z.object({
  input: z.string(),
  suggestion: z.string().min(1),
  items: z.array(searchItemSchema),
});

const searchResponseSchema = z.object({
  query: z.string().optional(),
  items: z.array(searchItemSchema),
  groups: z.array(englishSearchGroupSchema).optional(),
  correction: englishSearchCorrectionSchema.optional(),
  nextOffset: z.number().int().min(1).max(511).optional(),
  semanticStatus: z.enum(["applied", "degraded"]).optional(),
});

export function parseSearchTargets(payload: unknown): SearchTarget[] {
  return searchResponseSchema.parse(payload).items;
}

export type DictionarySearchPage = {
  items: SearchTarget[];
  nextOffset: number | null;
  semanticStatus?: "applied" | "degraded";
  groups?: EnglishSearchGroup[];
  correction?: EnglishSearchCorrection;
};

export function parseSearchPage(payload: unknown): DictionarySearchPage {
  const result = searchResponseSchema.parse(payload);
  return {
    items: result.items,
    nextOffset: result.nextOffset ?? null,
    ...(result.semanticStatus ? { semanticStatus: result.semanticStatus } : {}),
    ...(result.groups ? { groups: result.groups } : {}),
    ...(result.correction ? { correction: result.correction } : {}),
  };
}

const errorResponseSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
});

export type {
  DictionarySearchItem,
  DictionarySearchMatch,
  EnglishSearchCorrection,
  EnglishSearchGroup,
  EtymologySearchItem,
  SearchTarget,
} from "./search-target";

export type DictionaryEntryResponse = {
  entry: CanonicalEntry;
  enhancements: EtymologyResourceSummary[];
};

export class DictionaryClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DictionaryClientError";
  }
}

export { dictionarySearchQueryLimit } from "./search-mode";
export const dictionarySearchQueryTooLongCode = "query_too_long";

function assertSearchQueryLength(query: string): void {
  if (Array.from(query).length <= dictionarySearchQueryLimit) {
    return;
  }
  throw new DictionaryClientError(
    `Dictionary queries are limited to ${dictionarySearchQueryLimit} characters.`,
    400,
    dictionarySearchQueryTooLongCode,
  );
}

function apiRoot(): string {
  return resolveDictionaryApiRoot(
    process.env.NEXT_PUBLIC_DICTIONARY_API_URL,
    process.env.NODE_ENV,
  );
}

function apiUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return createDictionaryApiUrl(apiRoot(), path, origin);
}

async function responseError(response: Response): Promise<DictionaryClientError> {
  const fallback = `Dictionary request failed with status ${response.status}.`;
  try {
    const payload = errorResponseSchema.parse(await response.json());
    return new DictionaryClientError(
      payload.error?.message ?? payload.message ?? fallback,
      response.status,
      payload.error?.code,
    );
  } catch {
    return new DictionaryClientError(fallback, response.status);
  }
}

async function getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return response.json();
}

const adapter = new BundledBilingualAdapter({ dictionaryId: "core-english-zh" });

export const dictionaryClient = {
  async search(
    query: string,
    options: {
      limit?: number;
      scope?: readonly string[];
      mode?: DictionarySearchMode;
      signal?: AbortSignal;
    } = {},
  ): Promise<SearchTarget[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    assertSearchQueryLength(normalized);

    const url = apiUrl("search");
    url.searchParams.set("q", normalized);
    url.searchParams.set("limit", String(Math.min(Math.max(options.limit ?? 10, 1), 20)));
    if (options.scope !== undefined && isChineseSearchQuery(normalized)) {
      url.searchParams.set("scope", serializeDictionarySearchScopes(options.scope));
    }
    if (options.mode === "hybrid") {
      url.searchParams.set("mode", options.mode);
    }
    const payload = await getJson(url, options.signal);
    return parseSearchTargets(payload);
  },

  async searchPage(
    query: string,
    options: {
      limit?: number;
      offset?: number;
      scope?: readonly string[];
      mode?: DictionarySearchMode;
      signal?: AbortSignal;
    } = {},
  ): Promise<DictionarySearchPage> {
    const normalized = query.trim();
    if (!normalized) {
      return { items: [], nextOffset: null };
    }

    assertSearchQueryLength(normalized);

    const url = apiUrl("search");
    url.searchParams.set("q", normalized);
    url.searchParams.set("limit", String(Math.min(Math.max(options.limit ?? 32, 1), 256)));
    url.searchParams.set("submitted", "true");
    if (options.scope !== undefined && isChineseSearchQuery(normalized)) {
      url.searchParams.set("scope", serializeDictionarySearchScopes(options.scope));
    }
    if (options.mode === "hybrid") {
      url.searchParams.set("mode", options.mode);
    }
    const offset = Math.min(Math.max(options.offset ?? 0, 0), 511);
    if (offset > 0) {
      url.searchParams.set("offset", String(offset));
    }
    return parseSearchPage(await getJson(url, options.signal));
  },

  async entry(entryId: string, signal?: AbortSignal): Promise<DictionaryEntryResponse> {
    const url = apiUrl(`entries/${encodeURIComponent(entryId)}`);
    const payload = bundledBilingualEnvelopeSchema.parse(await getJson(url, signal));
    const enhancements = enhancementResourceSummariesSchema.parse(
      (payload as { enhancements?: unknown }).enhancements ?? [],
    );
    return { entry: adapter.adapt(payload), enhancements };
  },

  async etymologyTerm(term: string, signal?: AbortSignal): Promise<EtymologyResourceSummary> {
    const url = apiUrl(`enhancements/etymology/terms/${encodeURIComponent(term)}`);
    return etymologyResourceSummarySchema.parse(await getJson(url, signal));
  },

  async etymologyArticle(articleId: string, signal?: AbortSignal): Promise<EtymologyArticleResponse> {
    const url = apiUrl(`enhancements/etymology/articles/${encodeURIComponent(articleId)}`);
    return etymologyArticleResponseSchema.parse(await getJson(url, signal));
  },

  headwordAudioUrl(key: string): string {
    const url = apiUrl("media/headword-audio");
    url.searchParams.set("key", key);
    return url.toString();
  },

  exampleAudioUrl(key: string): string {
    const url = apiUrl("media/example-audio");
    url.searchParams.set("key", key);
    return url.toString();
  },

  illustrationUrl(key: string, variant: "full" | "thumbnail" = "full"): string {
    const url = apiUrl("media/illustration");
    url.searchParams.set("key", key);
    url.searchParams.set("variant", variant);
    return url.toString();
  },
};
