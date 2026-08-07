# Progressive Web Application

## Scope

Lexicon Workbench is one browser application that can be installed on desktop,
tablet, and phone. Installation changes the launch surface and window chrome; it does
not install a dictionary database or copy server media onto the device.

The PWA platform is isolated under `src/platform/pwa`. The dictionary renderer, HTTP
client, canonical adapter, and IndexedDB learning-data repository have no Service
Worker dependency. The root layout mounts the runtime as a sibling of the dictionary
workspace.

```text
app/layout.tsx
  +-- dictionary routes and feature UI
  +-- PwaRuntime
       +-- production-only registration
       +-- connectivity status
       +-- update lifecycle

app/serwist/[path]/route.ts
  +-- build revision
  +-- explicit precache glob set
  +-- precache allowlist transform
  +-- bundled Service Worker response
```

## Installation

The manifest uses `/` as its stable application identity, start URL, and scope. It
allows any orientation so phone, tablet portrait, tablet landscape, and desktop use
the same responsive layout. Standard and maskable 192 px and 512 px icons are supplied,
along with a 180 px Apple touch icon.

Browsers expose their native install controls when the application is eligible. The
page does not add an install banner or duplicate browser prompts. Production requires
HTTPS; `localhost` is treated as a secure development origin by supporting browsers.

Service Worker registration is disabled during `next dev`. This prevents a development
server from being controlled by stale production output. Use `npm run build` followed
by `npm start` for installation and offline checks.

## Cache Contract

| Resource | Service Worker policy | Bound |
| --- | --- | --- |
| Hashed Next.js JavaScript, CSS, and local webfonts | versioned precache | build allowlist; 3 MiB per file maximum |
| Manifest, offline page, and application icons | versioned precache | explicit URL allowlist |
| Same-origin document navigation | network first | 8 responses, 7 days |
| `/api/v1/search` | network only | never stored in Cache Storage |
| `/api/v1/entries/*` | network only | never stored in Cache Storage |
| `/api/v1/media/*` | network only | never stored in Cache Storage |
| Cross-origin audio and illustrations | pass through | never stored by the Service Worker |
| Runtime SQLite, enhancement sidecars, and pronunciation ZIP | server only | never requested by installation |
| History, favorites, notes, and preferences | existing IndexedDB repository | independent of PWA caches |

The build uses explicit file globs followed by a second URL allowlist. An unexpected
file is removed from the precache manifest and reported during the build. Runtime
classification gives the API rule precedence over navigation handling. Non-GET
requests are not handled by the Service Worker.

The reference production build currently emits 26 precache entries totaling about
1.07 MiB. The build log reports the exact entry count and byte size for every release.
Cache Storage adds browser-dependent metadata overhead, and the bounded navigation
cache may add several small HTML responses. Dictionary entries, enhancement articles, audio, illustrations,
the 54 MiB runtime database, and the 1.06 GiB pronunciation archive are outside this
budget.

Normal browser HTTP caching remains controlled by origin response headers. The table
describes Service Worker Cache Storage and guarantees that PWA installation does not
turn online dictionary or media requests into offline assets.

## Offline Behavior

The offline page is precached during installation. A disconnected navigation first
tries the network and then a recent bounded navigation response; when neither is
available, the branded offline page is returned. Existing history, favorites, notes,
and preferences remain available in IndexedDB.

Search, entry retrieval, enhancement articles, pronunciation, example audio, and illustrations require the
Go API or their configured remote origin. They never return stale Service Worker
copies. An already open dictionary page remains rendered, while a new online-only
request follows the feature's normal unavailable state.

## Updates

Each build supplies one revision to stable precache URLs, while hashed Next.js assets
carry their own content identity. The Service Worker script itself is served with
`no-cache, no-store, must-revalidate` and registration uses `updateViaCache: "none"`.

An update discovered during active use installs and waits. The page shows a compact
system notice with explicit update and dismiss actions. Accepting the update activates
the waiting worker and reloads only the page that requested activation. Dismissing it
leaves the worker waiting; a later clean page launch activates it before the user can
begin editing. Reconnecting to the network never reloads the page automatically.

This lifecycle keeps note entry and other active work stable while ensuring ignored
updates do not remain waiting indefinitely.

## Deployment Headers

The application server emits the required headers, and a reverse proxy must preserve
them:

```text
/serwist/sw.js
  Content-Type: application/javascript
  Cache-Control: no-cache, no-store, must-revalidate
  Service-Worker-Allowed: /
  X-Content-Type-Options: nosniff

/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: public, max-age=0, must-revalidate
```

Do not add a proxy cache rule for `/serwist/`, `/manifest.webmanifest`, or `/api/v1/`.
TLS termination may happen in the included Caddy reference stack or an existing reverse
proxy. No additional PWA container or persistent volume is required.

## Verification

The automated release gate is:

```bash
npm run typecheck
npm run lint
npm test
docker compose --env-file deploy/server/.env.example -f deploy/server/compose.yaml build
```

`npm test` validates the manifest contract, request classifier, precache allowlist,
update decisions, production build, standalone headers, icons, Service Worker body,
and offline page.

Browser release checks cover:

| Form factor | Required checks |
| --- | --- |
| Desktop | install eligibility, standalone launch, search, update notice, online/offline transition |
| Tablet portrait | safe-area spacing, dictionary layout, quick-find dock, offline page |
| Tablet landscape | responsive reflow, full-width controls, standalone rotation |
| Phone | home-screen icon, standalone launch, bottom dock separation, offline fallback |

Cache inspection must show no `/api/v1/`, MP3, ZIP, SQLite, or illustration URL in the
precache. With the browser offline, a new uncached navigation must reach `/offline`, and
an API lookup must fail online-only rather than return a cached dictionary response.

## Rollback

Deploying and rebuilding an earlier application commit creates another build revision.
Browsers receive it through the same waiting-worker lifecycle. Outdated precaches are
removed during activation; the bounded navigation cache remains compatible and expires
normally. Rollback does not alter IndexedDB learning data or server dictionary assets.

If an active Service Worker release is faulty, restore the previous commit, rebuild,
and deploy. Keeping the Service Worker response non-cacheable is essential so clients
can discover the rollback promptly.

## Future Offline Dictionaries

Offline dictionary packages remain a separate feature. Any implementation must be
explicitly initiated by the user and define package version, source identity, checksum,
entry count, byte budget, free-space preflight, cancellation, atomic activation,
eviction, and removal. It must not widen the current application-shell allowlist or
reuse the learning-data IndexedDB schema.
