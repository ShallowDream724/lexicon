import { createSerwistRoute } from "@serwist/turbopack";

import {
  PWA_MANIFEST_URL,
  PWA_OFFLINE_URL,
  PWA_PRECACHE_GLOBS,
  selectSafePrecacheEntries,
} from "@/src/platform/pwa/cache-policy";

const buildRevision =
  process.env.LEXICON_BUILD_REVISION?.trim() || "development";

export const {
  dynamic,
  dynamicParams,
  revalidate,
  generateStaticParams,
  GET,
} = createSerwistRoute({
  additionalPrecacheEntries: [
    { url: PWA_MANIFEST_URL, revision: buildRevision },
    { url: PWA_OFFLINE_URL, revision: buildRevision },
  ],
  esbuildOptions: {
    legalComments: "none",
    sourcemap: false,
  },
  globPatterns: [...PWA_PRECACHE_GLOBS],
  manifestTransforms: [
    async (entries) => {
      const { manifest, rejected } = selectSafePrecacheEntries(entries);
      return {
        manifest,
        warnings: rejected.map(
          (url) => `Excluded unexpected PWA precache entry: ${url}`,
        ),
      };
    },
  ],
  maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  swSrc: "src/platform/pwa/service-worker.ts",
  useNativeEsbuild: true,
});
