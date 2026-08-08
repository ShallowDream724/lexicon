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

test("round-trips Chinese scope in the canonical URL order and removes it from English URLs", () => {
  const chinese = parseWorkspaceRoute(new URLSearchParams("q=%E4%BC%91%E6%81%AF&scope=example,sense,form,phrase"));
  assert.deepEqual(chinese, {
    kind: "query",
    query: "休息",
    scope: ["sense", "phrase", "form", "example"],
  });
  assert.equal(
    workspaceRouteUrl("/", chinese),
    "/?q=%E4%BC%91%E6%81%AF&scope=sense%2Cphrase%2Cform%2Cexample",
  );

  const english = parseWorkspaceRoute(new URLSearchParams("q=rest&scope=usage,example"));
  assert.deepEqual(english, { kind: "query", query: "rest" });
  assert.equal(workspaceRouteUrl("/", english), "/?q=rest");
});
