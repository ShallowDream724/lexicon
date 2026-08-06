import assert from "node:assert/strict";
import test from "node:test";

import {
  createDictionaryApiUrl,
  resolveDictionaryApiRoot,
} from "../../src/lib/dictionary-client/api-url";

test("production defaults to the self-hosted same-origin API", () => {
  const root = resolveDictionaryApiRoot(undefined, "production");
  assert.equal(root, "/api/v1");
  assert.equal(
    createDictionaryApiUrl(root, "/search", "https://dictionary.example").toString(),
    "https://dictionary.example/api/v1/search",
  );
});

test("local development and explicit API roots remain absolute", () => {
  assert.equal(
    resolveDictionaryApiRoot(undefined, "development"),
    "http://localhost:8787/api/v1",
  );
  const root = resolveDictionaryApiRoot(" https://api.example/v1/ ", "production");
  assert.equal(root, "https://api.example/v1");
  assert.equal(
    createDictionaryApiUrl(root, "entries/a%20b", "https://ignored.example").toString(),
    "https://api.example/v1/entries/a%20b",
  );
});
