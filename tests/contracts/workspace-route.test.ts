import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkspaceRoute,
  workspaceRouteUrl,
} from "../../src/features/dictionary/workspace-route";

test("preserves a dictionary entry while addressing an etymology article", () => {
  const route = parseWorkspaceRoute(new URLSearchParams("entry=word-42&etymology=word&article=noun-1"));
  assert.deepEqual(route, {
    kind: "entry",
    entryId: "word-42",
    etymology: { term: "word", articleId: "noun-1" },
  });
  assert.equal(workspaceRouteUrl("/", route), "/?entry=word-42&etymology=word&article=noun-1");
});

test("uses an etymology-only route without synthesizing a dictionary entry", () => {
  const route = parseWorkspaceRoute(new URLSearchParams("etymology=origo&article=noun-1"));
  assert.deepEqual(route, {
    kind: "etymology",
    etymology: { term: "origo", articleId: "noun-1" },
  });
  assert.equal(workspaceRouteUrl("/lookup", route), "/lookup?etymology=origo&article=noun-1");
});
