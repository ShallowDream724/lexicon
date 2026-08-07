import assert from "node:assert/strict";
import test from "node:test";

import type {
  EtymologyArticleResponse,
  EtymologyResourceSummary,
} from "../../packages/enhancement-schema/src/index";
import { isArticleResponseForResource } from "../../src/features/dictionary/etymology-response";

const resource = {
  resourceId: "etymology:alpha",
  sourceVersion: "source-v2",
} as EtymologyResourceSummary;

const response = {
  resourceId: "etymology:alpha",
  sourceVersion: "source-v2",
  article: { id: "101" },
} as EtymologyArticleResponse;

test("etymology article responses stay scoped to one resource version and article", () => {
  assert.equal(isArticleResponseForResource(response, resource, "101"), true);
  assert.equal(isArticleResponseForResource({ ...response, sourceVersion: "source-v1" }, resource, "101"), false);
  assert.equal(isArticleResponseForResource({ ...response, resourceId: "etymology:beta" }, resource, "101"), false);
  assert.equal(isArticleResponseForResource(response, resource, "102"), false);
});
