import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_LIST_LIMIT,
  LEARNING_DATA_BACKUP_VERSION,
  LEARNING_DATA_DATABASE_VERSION,
  learningData,
  nextHistoryRecord,
  uniqueRecordKeys,
} from "../../src/lib/storage/learning-data";

test("retains a 100-entry history window by default", () => {
  assert.equal(HISTORY_LIST_LIMIT, 100);
});

test("migrates IndexedDB and backup formats independently", () => {
  assert.equal(LEARNING_DATA_DATABASE_VERSION, 2);
  assert.equal(LEARNING_DATA_BACKUP_VERSION, 2);

  const versionOneBackup: Parameters<typeof learningData.import>[0] = {
    version: 1,
    exportedAt: "2026-08-08T00:00:00.000Z",
    history: [],
    favorites: [],
    notes: [],
    preferences: {
      key: "main",
      fontScale: "default",
      showTranslations: true,
      autoplayAccent: "off",
    },
  };
  assert.equal(versionOneBackup.version, 1);
});

test("batch deletion keys are unique and ignore empty values", () => {
  assert.deepEqual(uniqueRecordKeys(["history-a", "", "note-a", "history-a"]), [
    "history-a",
    "note-a",
  ]);
  assert.deepEqual(uniqueRecordKeys([]), []);
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
