import assert from "node:assert/strict";
import test from "node:test";

import {
  searchLocationAttributes,
  searchLocationPathKey,
} from "../../src/features/dictionary/search-location";

test("encodes canonical paths without ambiguous separators", () => {
  assert.equal(
    searchLocationPathKey(["subentries", "0", "senses/usage", "1"]),
    "subentries/0/senses%2Fusage/1",
  );
});

test("prefers an explicit rendered owner while retaining the canonical path", () => {
  assert.deepEqual(searchLocationAttributes({
    section: "definitions",
    ownerId: "source-owner",
    path: ["senses", "0"],
  }, "rendered-owner"), {
    "data-search-owner-id": "rendered-owner",
    "data-search-path": "senses/0",
  });
});
