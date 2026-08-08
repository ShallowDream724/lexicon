import assert from "node:assert/strict";
import test from "node:test";

import {
  QUERY_HISTORY_LIST_LIMIT,
  cleanQueryHistoryDisplay,
  nextQueryHistoryRecord,
  normalizeQueryHistoryKey,
  retainQueryHistoryRecords,
  sortQueryHistoryNewestFirst,
  type QueryHistoryRecord,
} from "../../src/lib/storage/learning-data";
import {
  createLongPressController,
  queryHistoryDisplayText,
  queryHistoryPreviewRecords,
  supportsTouchLongPress,
} from "../../src/features/dictionary/query-history";

function record(key: string, submittedAt: number): QueryHistoryRecord {
  return { key, query: key, submittedAt, submitCount: 1 };
}

test("query history keeps the complete cleaned query while normalizing only its key", () => {
  const query = "  ＦＯＯ，  Value!\t ";
  assert.equal(cleanQueryHistoryDisplay(query), "ＦＯＯ， Value!");
  assert.equal(normalizeQueryHistoryKey(query), "foo, value!");

  const first = nextQueryHistoryRecord(query, undefined, 100);
  assert.deepEqual(first, {
    key: "foo, value!",
    query: "ＦＯＯ， Value!",
    submittedAt: 100,
    submitCount: 1,
  });
  assert.equal(queryHistoryDisplayText(first!), "ＦＯＯ， Value!");
});

test("equivalent submitted queries update one record and accumulate submissions", () => {
  const first = nextQueryHistoryRecord("Road  Map", undefined, 100)!;
  const repeated = nextQueryHistoryRecord("  road\tmap ", first, 200)!;

  assert.deepEqual(repeated, {
    key: "road map",
    query: "road map",
    submittedAt: 200,
    submitCount: 2,
  });
});

test("query history retention is deterministically newest-first and capped after concurrent writes", () => {
  const records = Array.from({ length: QUERY_HISTORY_LIST_LIMIT + 2 }, (_, index) =>
    record(`query-${index}`, index),
  );
  const retained = retainQueryHistoryRecords(records);

  assert.equal(retained.length, QUERY_HISTORY_LIST_LIMIT);
  assert.equal(retained[0]?.key, "query-101");
  assert.equal(retained.at(-1)?.key, "query-2");
  assert.deepEqual(
    sortQueryHistoryNewestFirst([record("z", 1), record("a", 1)]).map(({ key }) => key),
    ["a", "z"],
  );
});

test("deleting one visible query lets the next ordered record fill its preview slot", () => {
  const records = [record("one", 4), record("two", 3), record("three", 2), record("four", 1)];
  const afterDelete = sortQueryHistoryNewestFirst(records.filter(({ key }) => key !== "one"));
  assert.deepEqual(queryHistoryPreviewRecords(afterDelete, 3).map(({ key }) => key), [
    "two",
    "three",
    "four",
  ]);
});

test("long press only fires after its delay and cancels for movement, scrolling, or pointer cancellation", () => {
  let callback: (() => void) | undefined;
  let cleared = 0;
  let fired = 0;
  const controller = createLongPressController({
    onLongPress: () => {
      fired += 1;
    },
    scheduler: {
      setTimeout(next) {
        callback = next;
        return "timer";
      },
      clearTimeout() {
        cleared += 1;
      },
    },
  });

  controller.start({ pointerId: 1, clientX: 10, clientY: 10 });
  controller.move({ pointerId: 1, clientX: 23, clientY: 10 });
  callback?.();
  assert.equal(fired, 0);

  controller.start({ pointerId: 2, clientX: 10, clientY: 10 });
  controller.cancel();
  callback?.();
  assert.equal(fired, 0);

  controller.start({ pointerId: 3, clientX: 10, clientY: 10 });
  controller.end(3);
  callback?.();
  assert.equal(fired, 0);

  controller.start({ pointerId: 4, clientX: 10, clientY: 10 });
  callback?.();
  assert.equal(fired, 1);
  assert.equal(controller.consumeClick(), true);
  assert.equal(controller.consumeClick(), false);
  assert.ok(cleared >= 3);
});

test("long press is enabled only for touch pointers, independent of viewport size", () => {
  assert.equal(supportsTouchLongPress("touch"), true);
  assert.equal(supportsTouchLongPress("mouse"), false);
  assert.equal(supportsTouchLongPress("pen"), false);
});
