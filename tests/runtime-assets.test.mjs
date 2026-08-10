import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateManifest } from "../scripts/runtime-data.mjs";

test("runtime release manifest pins the complete runtime asset set", async () => {
  const manifest = validateManifest(JSON.parse(await readFile(new URL("../runtime-assets.json", import.meta.url), "utf8")));
  assert.deepEqual(
    manifest.assets.map((asset) => asset.file),
    ["dictionary.db", "etymology.db", "reverse-search.db", "semantic-search.db", "headword-audio.zip"],
  );
  const dictionary = manifest.assets.find((asset) => asset.file === "dictionary.db");
  const reverseSearch = manifest.assets.find((asset) => asset.file === "reverse-search.db");
  assert.equal(dictionary.runtimeSchema, 3);
  assert.equal(reverseSearch.runtimeSchema, 5);
  assert.equal(reverseSearch.projectionVersion, "1.4");
  assert.equal(reverseSearch.records, 188851);
  assert.equal(reverseSearch.bytes, 72228864);
  assert.equal(reverseSearch.sha256, "6a5288a931c1818fa064e030dc6476b72724717444ee751f52e26fc38e73fab0");
  assert.equal(reverseSearch.primarySha256, dictionary.sha256);
  const semanticSearch = manifest.assets.find((asset) => asset.file === "semantic-search.db");
  assert.equal(semanticSearch.runtimeSchema, 2);
  assert.equal(semanticSearch.projectionVersion, "1.1");
  assert.equal(semanticSearch.records, 178382);
  assert.equal(semanticSearch.documents, 188851);
  assert.equal(semanticSearch.bytes, 252542976);
  assert.equal(semanticSearch.sha256, "c17d6b478e0ab0dfa5868abf32209b84dab6b1c82abacfac8ae5ccc24fe4273b");
  assert.equal(semanticSearch.primarySha256, dictionary.sha256);
  assert.equal(semanticSearch.reverseSearchSha256, reverseSearch.sha256);
  assert.equal(semanticSearch.modelKey, "qwen3-embedding-4b-1024-v1");
  assert.equal(semanticSearch.dimensions, 1024);
  const audio = manifest.assets.find((asset) => asset.kind === "headword-audio");
  assert.equal(audio.records, 128010);
  assert.ok(audio.bytes > 1024 ** 3);
});

test("runtime release manifest rejects a semantic sidecar built from another search corpus", () => {
  assert.throws(() =>
    validateManifest({
      schemaVersion: 2,
      releaseTag: "test",
      baseUrl: "https://example.test/",
      assets: [
        { kind: "database", file: "dictionary.db", bytes: 1, records: 1, runtimeSchema: 1, sha256: "0".repeat(64) },
        { kind: "database", file: "reverse-search.db", bytes: 1, records: 1, runtimeSchema: 1, sha256: "1".repeat(64), primarySha256: "0".repeat(64) },
        {
          kind: "database",
          file: "semantic-search.db",
          bytes: 1,
          records: 1,
          documents: 1,
          runtimeSchema: 1,
          sha256: "2".repeat(64),
          primarySha256: "0".repeat(64),
          reverseSearchSha256: "3".repeat(64),
          model: "test-model",
          modelKey: "test-model-v1",
          dimensions: 1,
          quantization: "symmetric-int8-127",
        },
      ],
    }),
  );
});

test("runtime release manifest rejects a reverse-search sidecar built from another primary database", () => {
  assert.throws(() =>
    validateManifest({
      schemaVersion: 2,
      releaseTag: "test",
      baseUrl: "https://example.test/",
      assets: [
        { kind: "database", file: "dictionary.db", bytes: 1, records: 1, runtimeSchema: 1, sha256: "0".repeat(64) },
        { kind: "database", file: "reverse-search.db", bytes: 1, records: 1, runtimeSchema: 1, sha256: "1".repeat(64), primarySha256: "2".repeat(64) },
      ],
    }),
  );
});

test("runtime release manifest rejects path traversal", () => {
  assert.throws(() =>
    validateManifest({
      schemaVersion: 2,
      releaseTag: "test",
      baseUrl: "https://example.test/",
      assets: [
        { kind: "database", file: "../dictionary.db", bytes: 1, records: 1, runtimeSchema: 1, sha256: "0".repeat(64) },
      ],
    }),
  );
});

test("runtime release manifest rejects mismatched asset kinds", () => {
  assert.throws(() =>
    validateManifest({
      schemaVersion: 2,
      releaseTag: "test",
      baseUrl: "https://example.test/",
      assets: [{ kind: "headword-audio", file: "audio.db", bytes: 1, records: 1, sha256: "0".repeat(64) }],
    }),
  );
});
