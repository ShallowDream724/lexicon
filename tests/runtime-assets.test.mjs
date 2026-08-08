import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateManifest } from "../scripts/runtime-data.mjs";

test("runtime release manifest pins the complete runtime asset set", async () => {
  const manifest = validateManifest(JSON.parse(await readFile(new URL("../runtime-assets.json", import.meta.url), "utf8")));
  assert.deepEqual(
    manifest.assets.map((asset) => asset.file),
    ["dictionary.db", "etymology.db", "reverse-search.db", "headword-audio.zip"],
  );
  const dictionary = manifest.assets.find((asset) => asset.file === "dictionary.db");
  const reverseSearch = manifest.assets.find((asset) => asset.file === "reverse-search.db");
  assert.equal(dictionary.runtimeSchema, 3);
  assert.equal(reverseSearch.runtimeSchema, 3);
  assert.equal(reverseSearch.records, 188851);
  assert.equal(reverseSearch.bytes, 69894144);
  assert.equal(reverseSearch.sha256, "5f5b0d024141d6be17e76ef62a83206a2ca750984cd793bc52094b6a8298aaf5");
  assert.equal(reverseSearch.primarySha256, dictionary.sha256);
  const audio = manifest.assets.find((asset) => asset.kind === "headword-audio");
  assert.equal(audio.records, 128010);
  assert.ok(audio.bytes > 1024 ** 3);
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
