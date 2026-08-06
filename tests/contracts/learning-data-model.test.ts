import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_LIST_LIMIT,
  nextHistoryRecord,
} from "../../src/lib/storage/learning-data";

test("retains a 100-entry history window by default", () => {
  assert.equal(HISTORY_LIST_LIMIT, 100);
});

test("revisiting an entry keeps its identity and accumulates its visit count", () => {
  const first = nextHistoryRecord(
    { dictionaryId: "core", entryId: "good", headword: "good" },
    undefined,
    100,
  );
  const revisited = nextHistoryRecord(
    { dictionaryId: "core", entryId: "good", headword: "good" },
    first,
    200,
  );

  assert.deepEqual(revisited, {
    ...first,
    visitedAt: 200,
    visitCount: 2,
  });
});
