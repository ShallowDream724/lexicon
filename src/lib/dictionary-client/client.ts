import { z } from "zod";

import {
  BundledBilingualAdapter,
  bundledBilingualEnvelopeSchema,
} from "../../../packages/adapters/src/index";
import type { CanonicalEntry } from "../../../packages/dictionary-schema/src/index";
import {
  createDictionaryApiUrl,
  resolveDictionaryApiRoot,
} from "./api-url";

const searchItemSchema = z
  .object({
    id: z.string().optional(),
    entryId: z.string().optional(),
    headword: z.string(),
    partsOfSpeech: z.array(z.string()).optional(),
    translationPreview: z.string().optional(),
  })
  .transform((item) => ({
    id: item.id ?? item.entryId ?? "",
    headword: item.headword,
    partsOfSpeech: item.partsOfSpeech ?? [],
    translationPreview: item.translationPreview ?? "",
  }))
  .refine((item) => item.id.length > 0, "Search result is missing an entry id.");

const searchResponseSchema = z.object({
  query: z.string().optional(),
  items: z.array(searchItemSchema),
});

const errorResponseSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
});

export type DictionarySearchItem = z.infer<typeof searchItemSchema>;

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
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<DictionarySearchItem[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const url = apiUrl("search");
    url.searchParams.set("q", normalized);
    url.searchParams.set("limit", String(Math.min(Math.max(options.limit ?? 10, 1), 20)));
    const payload = await getJson(url, options.signal);
    return searchResponseSchema.parse(payload).items;
  },

  async entry(entryId: string, signal?: AbortSignal): Promise<CanonicalEntry> {
    const url = apiUrl(`entries/${encodeURIComponent(entryId)}`);
    const payload = bundledBilingualEnvelopeSchema.parse(await getJson(url, signal));
    return adapter.adapt(payload);
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

  illustrationUrl(key: string): string {
    const url = apiUrl("media/illustration");
    url.searchParams.set("key", key);
    return url.toString();
  },
};
