import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateManifest } from "../scripts/runtime-data.mjs";

test("runtime release manifest pins clean database artifacts", async () => {
  const manifest = validateManifest(JSON.parse(await readFile(new URL("../runtime-assets.json", import.meta.url), "utf8")));
  assert.deepEqual(
    manifest.assets.map((asset) => asset.file),
    ["dictionary.db", "etymology.db"],
  );
  assert.ok(manifest.assets.every((asset) => asset.runtimeSchema === 3));
});

test("runtime release manifest rejects path traversal", () => {
  assert.throws(() =>
    validateManifest({
      schemaVersion: 1,
      releaseTag: "test",
      baseUrl: "https://example.test/",
      assets: [{ file: "../dictionary.db", bytes: 1, sha256: "0".repeat(64) }],
    }),
  );
});
