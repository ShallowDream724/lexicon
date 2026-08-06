/// <reference lib="webworker" />

import {
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
} from "serwist";

import {
  classifyPwaRequest,
  PWA_OFFLINE_URL,
} from "./cache-policy";

declare global {
  interface WorkerGlobalScope {
    __SW_MANIFEST: Array<PrecacheEntry | string> | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope &
  typeof globalThis & {
    __SW_MANIFEST: Array<PrecacheEntry | string> | undefined;
  };

const runtimeCaching: RuntimeCaching[] = [
  {
    matcher: ({ request, sameOrigin, url }) =>
      classifyPwaRequest({
        method: request.method,
        mode: request.mode,
        pathname: url.pathname,
        sameOrigin,
      }) === "network-only",
    method: "GET",
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ request, sameOrigin, url }) =>
      classifyPwaRequest({
        method: request.method,
        mode: request.mode,
        pathname: url.pathname,
        sameOrigin,
      }) === "navigation-network-first",
    method: "GET",
    handler: new NetworkFirst({
      cacheName: "lexicon-navigation-v1",
      networkTimeoutSeconds: 4,
      plugins: [
        new ExpirationPlugin({
          maxAgeSeconds: 7 * 24 * 60 * 60,
          maxEntries: 8,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  },
];

const serwist = new Serwist({
  cacheId: "lexicon-workbench",
  clientsClaim: true,
  navigationPreload: true,
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    concurrency: 6,
  },
  runtimeCaching,
  skipWaiting: false,
  fallbacks: {
    entries: [
      {
        url: PWA_OFFLINE_URL,
        matcher: ({ request }) => request.mode === "navigate",
      },
    ],
  },
});

serwist.addEventListeners();
