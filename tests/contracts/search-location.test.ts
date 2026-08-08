import assert from "node:assert/strict";
import test from "node:test";

import {
  findSearchLocationElement,
  searchLocationAttributes,
  searchLocationContains,
  searchLocationPathKey,
} from "../../src/features/dictionary/search-location";

test("encodes canonical paths without ambiguous separators", () => {
  assert.equal(
    searchLocationPathKey(["subentries", "0", "senses/usage", "1"]),
    "subentries/0/senses%2Fusage/1",
  );
});

test("matches a resource location to any indexed descendant", () => {
  assert.equal(searchLocationContains({
    section: "grammar-usage",
    ownerId: "box",
    path: ["grammarUsageBoxes", "0"],
  }, {
    section: "grammar-usage",
    ownerId: "box",
    path: ["grammarUsageBoxes", "0", "blocks", "2", "value"],
  }), true);
  assert.equal(searchLocationContains({
    section: "definitions",
    path: ["senses", "0"],
  }, {
    section: "definitions",
    path: ["senses", "1"],
  }), false);
  assert.equal(searchLocationContains({
    section: "grammar-usage",
    ownerId: "other-box",
    path: ["grammarUsageBoxes", "0"],
  }, {
    section: "grammar-usage",
    ownerId: "box",
    path: ["grammarUsageBoxes", "0", "blocks", "2", "value"],
  }), false);
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

test("prefers the matching owner and never selects a conflicting exact path", () => {
  const conflicting = {
    dataset: { searchPath: "senses/0/usage/0", searchOwnerId: "other-sense" },
  } as unknown as HTMLElement;
  const preciseChild = {
    dataset: { searchPath: "senses/0/usage/0" },
  } as unknown as HTMLElement;
  const root = {
    querySelectorAll(selector: string) {
      return selector === "[data-search-path]" ? [conflicting, preciseChild] : [];
    },
  } as unknown as ParentNode;

  assert.equal(findSearchLocationElement({
    section: "definitions",
    ownerId: "sense",
    path: ["senses", "0", "usage", "0"],
  }, root), preciseChild);
});
