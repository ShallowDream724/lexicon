import assert from "node:assert/strict";
import test from "node:test";

import { librarySelectionReducer } from "../../src/features/dictionary/library-selection";

test("toggles an individual record without mutating the current selection", () => {
  const current = new Set(["history:a"]);
  const added = librarySelectionReducer(current, { type: "toggle", key: "history:b" });
  const removed = librarySelectionReducer(added, { type: "toggle", key: "history:a" });

  assert.deepEqual([...current], ["history:a"]);
  assert.deepEqual([...added], ["history:a", "history:b"]);
  assert.deepEqual([...removed], ["history:b"]);
});

test("select-all de-duplicates keys and clear removes every selection", () => {
  const selected = librarySelectionReducer(new Set(["obsolete"]), {
    type: "select-all",
    keys: ["favorite:a", "favorite:b", "favorite:a"],
  });
  const cleared = librarySelectionReducer(selected, { type: "clear" });

  assert.deepEqual([...selected], ["favorite:a", "favorite:b"]);
  assert.deepEqual([...cleared], []);
});
