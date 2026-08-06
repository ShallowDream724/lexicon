const DEVELOPMENT_API_ROOT = "http://localhost:8787/api/v1";
const PRODUCTION_API_ROOT = "/api/v1";

export function resolveDictionaryApiRoot(
  configuredRoot: string | undefined,
  environment: string | undefined,
): string {
  const fallback =
    environment === "production" ? PRODUCTION_API_ROOT : DEVELOPMENT_API_ROOT;
  return (configuredRoot?.trim() || fallback).replace(/\/$/, "");
}

export function createDictionaryApiUrl(root: string, path: string, origin: string): URL {
  const value = `${root}/${path.replace(/^\//, "")}`;
  return root.startsWith("/") ? new URL(value, origin) : new URL(value);
}
