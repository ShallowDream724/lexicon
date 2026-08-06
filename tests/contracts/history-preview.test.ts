import assert from "node:assert/strict";
import test from "node:test";

import type { HistoryRecord } from "../../src/lib/storage/learning-data";
import { historyPreviewRecords } from "../../src/features/dictionary/history-preview";

function historyRecord(
  key: string,
  headword: string,
  visitCount: number,
): HistoryRecord {
  return {
    key,
    dictionaryId: "test-dictionary",
    entryId: key,
    headword,
    visitedAt: 1,
    visitCount,
  };
}

test("history previews preserve recent order while merging duplicate headwords", () => {
  const preview = historyPreviewRecords([
    historyRecord("new-completion", "Completion", 2),
    historyRecord("rest", "rest", 4),
    historyRecord("old-completion", " completion ", 7),
  ]);

  assert.deepEqual(
    preview.map(({ entryId, headword, visitCount }) => ({
      entryId,
      headword,
      visitCount,
    })),
    [
      { entryId: "new-completion", headword: "Completion", visitCount: 9 },
      { entryId: "rest", headword: "rest", visitCount: 4 },
    ],
  );
});

test("history previews enforce their distinct-entry limit", () => {
  const preview = historyPreviewRecords([
    historyRecord("one", "one", 1),
    historyRecord("two", "two", 1),
    historyRecord("three", "three", 1),
  ], 2);

  assert.deepEqual(preview.map((record) => record.headword), ["one", "two"]);
});
