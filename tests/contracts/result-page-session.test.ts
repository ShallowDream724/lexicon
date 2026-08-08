import assert from "node:assert/strict";
import test from "node:test";

import { createResultPageSessionStore } from "../../src/features/dictionary/result-page-session";

test("keeps result count and scroll position isolated by canonical request key", () => {
  const sessions = createResultPageSessionStore<{ itemCount: number }>();
  sessions.write("词汇\0sense,phrase,form", {
    state: { itemCount: 128 },
    scrollY: 4_280,
  });
  sessions.write("词汇\0sense,phrase,form,example", {
    state: { itemCount: 64 },
    scrollY: 1_920,
  });

  assert.deepEqual(sessions.read("词汇\0sense,phrase,form"), {
    state: { itemCount: 128 },
    scrollY: 4_280,
  });
  assert.deepEqual(sessions.read("词汇\0sense,phrase,form,example"), {
    state: { itemCount: 64 },
    scrollY: 1_920,
  });
});

test("evicts the least recently used result page at its fixed capacity", () => {
  const sessions = createResultPageSessionStore<number>(2);
  sessions.write("first", { state: 32, scrollY: 100 });
  sessions.write("second", { state: 64, scrollY: 200 });
  assert.equal(sessions.read("first")?.state, 32);

  sessions.write("third", { state: 128, scrollY: 300 });

  assert.equal(sessions.read("second"), undefined);
  assert.equal(sessions.read("first")?.scrollY, 100);
  assert.equal(sessions.read("third")?.state, 128);
});
