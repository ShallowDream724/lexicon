export const PWA_API_PREFIX = "/api/v1";
export const PWA_MANIFEST_URL = "/manifest.webmanifest";
export const PWA_OFFLINE_URL = "/offline";
export const PWA_SERVICE_WORKER_URL = "/serwist/sw.js";

export const PWA_PRECACHE_GLOBS = [
  ".next/static/**/*.{js,css,woff,woff2}",
  "public/brand-mark.svg",
  "public/favicon-16.png",
  "public/favicon-32.png",
  "public/icon-192.png",
  "public/icon-512.png",
  "public/icons/app-192.png",
  "public/icons/app-512.png",
  "public/icons/maskable-192.png",
  "public/icons/maskable-512.png",
  "public/icons/apple-touch-icon.png",
] as const;

const PRECACHE_PUBLIC_URLS = new Set([
  "/brand-mark.svg",
  "/favicon-16.png",
  "/favicon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icons/app-192.png",
  "/icons/app-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  PWA_MANIFEST_URL,
  PWA_OFFLINE_URL,
]);

export type PwaRuntimePolicy =
  | "bypass"
  | "navigation-network-first"
  | "network-only";

export type PwaRequestDescriptor = {
  method: string;
  mode?: string;
  pathname: string;
  sameOrigin: boolean;
};

export function isDictionaryApiPath(pathname: string): boolean {
  return pathname === PWA_API_PREFIX || pathname.startsWith(`${PWA_API_PREFIX}/`);
}

export function classifyPwaRequest({
  method,
  mode,
  pathname,
  sameOrigin,
}: PwaRequestDescriptor): PwaRuntimePolicy {
  if (method.toUpperCase() !== "GET") {
    return "bypass";
  }
  if (sameOrigin && isDictionaryApiPath(pathname)) {
    return "network-only";
  }
  if (sameOrigin && mode === "navigate") {
    return "navigation-network-first";
  }
  return "bypass";
}

function normalizePrecacheUrl(url: string): string {
  const withoutQuery = url.replace(/[?#].*$/, "").replaceAll("\\", "/");
  if (withoutQuery.startsWith("public/")) {
    return `/${withoutQuery.slice("public/".length)}`;
  }
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

export function isSafePrecacheUrl(url: string): boolean {
  const normalized = normalizePrecacheUrl(url);
  if (/^\/(?:\.next|_next)\/static\/.+\.(?:css|js|woff2?)$/i.test(normalized)) {
    return true;
  }
  return PRECACHE_PUBLIC_URLS.has(normalized);
}

export function selectSafePrecacheEntries<T extends { url: string }>(
  entries: readonly T[],
): { manifest: T[]; rejected: string[] } {
  const manifest: T[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    if (isSafePrecacheUrl(entry.url)) {
      manifest.push(entry);
    } else {
      rejected.push(entry.url);
    }
  }
  return { manifest, rejected };
}
