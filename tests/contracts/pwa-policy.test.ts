import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../../app/manifest";
import {
  classifyPwaRequest,
  isSafePrecacheUrl,
  PWA_PRECACHE_GLOBS,
  selectSafePrecacheEntries,
} from "../../src/platform/pwa/cache-policy";
import { decideWaitingWorkerAction } from "../../src/platform/pwa/update-policy";

test("manifest supports installable phone, tablet, and desktop layouts", () => {
  const value = manifest();
  assert.equal(value.id, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.start_url, "/");
  assert.equal(value.display, "standalone");
  assert.equal(value.orientation, "any");
  assert.equal(value.theme_color, "#00225f");
  assert.equal(value.background_color, "#ffffff");

  const icons = value.icons ?? [];
  assert.ok(
    icons.some(
      (icon) => icon.sizes === "192x192" && icon.purpose === "any",
    ),
  );
  assert.ok(
    icons.some(
      (icon) => icon.sizes === "512x512" && icon.purpose === "maskable",
    ),
  );
});

test("runtime policy leaves mutations alone and keeps every API route online", () => {
  assert.equal(
    classifyPwaRequest({
      method: "POST",
      mode: "navigate",
      pathname: "/api/v1/search",
      sameOrigin: true,
    }),
    "bypass",
  );

  for (const pathname of [
    "/api/v1",
    "/api/v1/search",
    "/api/v1/entries/example",
    "/api/v1/media/headword-audio",
    "/api/v1/media/example-audio",
    "/api/v1/media/illustration",
  ]) {
    assert.equal(
      classifyPwaRequest({
        method: "GET",
        mode: "cors",
        pathname,
        sameOrigin: true,
      }),
      "network-only",
    );
  }
});

test("runtime policy caches only same-origin navigations", () => {
  assert.equal(
    classifyPwaRequest({
      method: "GET",
      mode: "navigate",
      pathname: "/?entry=example",
      sameOrigin: true,
    }),
    "navigation-network-first",
  );
  assert.equal(
    classifyPwaRequest({
      method: "GET",
      mode: "cors",
      pathname: "/remote/example.mp3",
      sameOrigin: false,
    }),
    "bypass",
  );
});

test("precache allowlist excludes dictionary and media payloads", () => {
  for (const url of [
    ".next/static/chunks/app.js",
    "/_next/static/css/layout.css",
    "public/icons/app-192.png",
    "/icons/maskable-512.png",
    "/manifest.webmanifest",
    "/offline",
  ]) {
    assert.equal(isSafePrecacheUrl(url), true, url);
  }

  for (const url of [
    "/api/v1/search?q=word",
    "/api/v1/entries/word",
    "/api/v1/media/example-audio?key=one",
    "public/dictionary.db",
    "public/headword-audio.zip",
    "https://media.example.test/example.mp3",
    "/illustrations/full/apple.jpg",
    ".next/server/app/page.js",
  ]) {
    assert.equal(isSafePrecacheUrl(url), false, url);
  }

  assert.ok(PWA_PRECACHE_GLOBS.every((pattern) => !pattern.includes("**/*.*")));

  const selected = selectSafePrecacheEntries([
    { url: "/offline", revision: "one" },
    { url: "/api/v1/entries/word", revision: "two" },
    { url: "/media/example.mp3", revision: "three" },
  ]);
  assert.deepEqual(selected.manifest, [{ url: "/offline", revision: "one" }]);
  assert.deepEqual(selected.rejected, [
    "/api/v1/entries/word",
    "/media/example.mp3",
  ]);
});

test("updates wait for consent during use and activate on a later launch", () => {
  assert.equal(decideWaitingWorkerAction("runtime", true), "prompt");
  assert.equal(decideWaitingWorkerAction("startup", true), "activate");
  assert.equal(decideWaitingWorkerAction("runtime", false), "ignore");
  assert.equal(decideWaitingWorkerAction("startup", false), "ignore");
});
