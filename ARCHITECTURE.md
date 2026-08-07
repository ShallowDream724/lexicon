# Lexicon Architecture

## Goals

Lexicon is an anonymous, responsive dictionary application for desktop,
tablet, and phone. It keeps dictionary content read-only, stores each browser's
learning data separately, and accepts additional dictionary formats through
versioned adapters.

The first release optimizes for:

- faithful dictionary-page typography and information density;
- local, low-latency search over a large SQLite source;
- complete rendering of nested senses, examples, usage notes, audio, and images;
- no account, registration, advertising, or separately distributed application package;
- one installable browser application across desktop, tablet, and phone;
- source adapters that can evolve without changing React components;
- explicit contracts and tests at every boundary where source data changes shape.

## System Shape

```text
Read-only import source
        |
        v
One-way importer  ----  project-owned runtime SQLite + media manifest
        |
        +--------------  project-owned enhancement sidecars
        |
        v
Go source service  ----  /api/v1/search, /entries, /enhancements, /media
        |
        v
TypeScript source adapter
        |
        v
CanonicalEntry v1
        |
        +---- React dictionary renderer
        |
        +---- IndexedDB learning data
              history, favorites, notes, preferences

Root application composition
        |
        +---- isolated PWA platform layer
              manifest, registration, updates, offline shell, bounded caches
```

Dependencies point down this diagram. UI modules never import source-table names,
open SQLite files, inspect ZIP archives, or depend on an adapter's private types.

## Repository Boundaries

```text
app/                         application routes and global composition
src/features/dictionary/     dictionary UI and feature state
src/lib/dictionary-client/   cancellable HTTP client and query orchestration
src/lib/storage/             device-local learning-data repository
src/platform/pwa/            install, update, offline, and cache policy
packages/dictionary-schema/  versioned UI-facing domain contract
packages/enhancement-schema/ versioned optional-resource contracts
packages/adapters/           source adapters and registry
services/dictionary-api/     read-only Go/SQLite/media service
tests/contracts/             source-to-domain invariants
tests/rendered-html.test.mjs production-render smoke coverage
scripts/                     repeatable data and development operations
```

## Runtime Responsibilities

### Go Source Service

The importer reads a supported source in read-only mode and creates a fresh runtime
database using project-owned tables, indexes, schema versions, and media manifests.
It copies no application-only tables or runtime metadata. Import is deterministic,
transactional, and one-way; the generated database can be rebuilt from the same
source and adapter version.

The service owns runtime storage work:

- opening only the generated runtime database in read-only mode;
- validating the project schema version at startup;
- bounded, parameterized search with deterministic ranking;
- decompressing one independently stored entry and returning a stable envelope
  around the unmodified entry JSON;
- indexing the pronunciation archive once and streaming individual assets;
- resolving optional example-audio and illustration keys through configured,
  validated media URLs and path templates;
- enforcing request limits, timeouts, cancellation, and structured errors.

Optional enhancement sources use independent read-only sidecars. Each sidecar owns its
source version, search projection, payload codec, and integrity metadata. The primary
entry endpoint returns only lightweight enhancement summaries; complete enhancement
articles load through their own endpoint when a user opens a card. An unavailable
optional sidecar does not prevent the primary dictionary from starting.

Primary search and enhancement association share one server-side term-key boundary.
Dictionary keys remove source display syllable separators; enhancement keys additionally
normalize observed typographic apostrophes. Indexed legacy variants keep existing runtime
databases searchable without table scans. Hyphens, internal whitespace, trademark marks,
and other meaning-bearing punctuation remain untouched because corpus auditing shows
collisions or unsafe semantic merges. Article responses must match resource id, article id,
and source version before entering UI state.

It does not build the UI-facing entry model. This avoids implementing the same
semantic conversion in Go and TypeScript.

### Dictionary Adapter

An adapter validates the source envelope, recursively converts source fields into
`CanonicalEntry`, and retains the original entry under `raw`. Arrays keep source
order. Unknown fields remain available even when the current renderer ignores
them.

Source tokens enter canonical fields through explicit semantic routing. Label
conversion uses an allowlist; form fragments, constructions, rich text, navigation
metadata, and structural containers have dedicated destinations and never fall
through into visible qualifiers. Entry and sense constructions remain separate from
labels, structured derivatives retain their pronunciations and senses, and box
navigation targets remain separate from display blocks. Repeated source transport
groups may be deduplicated structurally, while ordered same-spelling forms within a
group remain intact.

Adapter registration is explicit. A future MDX, StarDict, JSON, or remote source
adds an adapter and fixtures; it does not add source conditionals to components.

### React Application

The React layer renders only canonical types. It owns:

- responsive page composition;
- search suggestions and route state;
- audio playback state;
- sense, example, cross-reference, box, and illustration presentation;
- structured headword patterns, inflections, word families, and derivatives;
- favorites, notes, history, and display preferences through repository methods.

Optional entry resources pass through one registry in
`src/features/dictionary/resource-model.ts`. The registry determines stable ordering,
card size, quick-find placement, and opening behavior. Source-specific checks stay in
resource renderers and clients rather than spreading through the entry view. Featured
resources may use a wider desktop rail card and span the full resource grid on phone or
narrow tablet layouts; native dictionary cards retain their compact size. A featured
card exposes its first article as the card-wide primary action, while article chips are
independent direct actions for a specific article. Etymology cards retain a book-page
aspect ratio on desktop and landscape tablets, then use a bounded full-row format on
phones and portrait tablets. Their title and action occupy fixed layout rows while the
summary consumes the remaining card height; the card's resize observer derives the
available line count without introducing viewport-specific text limits. The watermark
stays anchored to the paper corner and scales from the card block size. Narrow phones
hide the paper heading so the content begins with the headword while retaining the
source mark on the spine. The footer is an unseparated inline action whose chevron
follows its label; its narrow-phone typography is enlarged because the hidden heading
makes the action carry the resource identity. Summary text uses the same semantic
emphasis runs as the article source, so presentation never infers historical-language
spans from words.

Enhancement article routes keep the primary entry id when one exists. Article links
with a stable target id resolve that article first and then route through the returned
term, preserving historical aliases. A term absent from the primary dictionary can
still open an enhancement-only view without synthesizing a canonical entry or personal
learning record.

Search requests are debounced and cancellable. Full entries load only after a
selection. Large entry bodies do not enter the initial hydration payload.
The server derives the initial workspace route from the request URL, so entry deep
links render a stable loading state instead of briefly rendering home content. Later
history navigation uses the same route resolver. Repeated submission of the same
normalized query shares one in-flight transition through search and entry loading.

Modal resources share one reference-counted viewport lock. Opening an illustration,
usage panel, quick-find dialog, note editor, or personal-library drawer prevents the
underlying entry from scrolling while preserving the current page position and
scrollbar width. Quick-find anchor actions run after that lock is released so dialog
cleanup cannot override the requested destination.

Etymology article dialogs use the same restrained gilded book edge at every viewport.
Wide layouts preserve the book-page reading inset after that edge; phone layouts keep
smaller inline padding while reserving equal backdrop space above and below the page so
either exposed area remains a predictable dismissal target.

Phone layouts keep sense numbers as the first alignment level and dependent content
as the second. Nested sense lists remove decorative left padding at the narrow-phone
breakpoint to preserve usable line width. Each bilingual definition uses one inline
formatting context, so English and Chinese share the available line naturally instead
of being separated by viewport-specific rendering rules. Auxiliary resource cards
move ahead of the definition column on narrow layouts without adding a second section
gap. Featured enhancement cards assign their heading, content, and action to explicit
grid rows. The action row keeps its intrinsic height; a resize observer derives the
preview line count from the content row's remaining block space and may omit the
preview when no complete line fits. Source-specific labels never set a minimum line
count.

Sense lead-line flow is derived from canonical structure. Proficiency and usage labels,
parenthetical bilingual qualifiers, and the definition remain in one natural inline
flow. When a grammatical construction is present, it owns the lead line and the
definition begins on the next line. Viewport width never decides this semantic break.
Sense-level synonyms and antonyms follow the translated definition in that same text
flow. Navigational references such as `see also`, `more at`, and `compare` remain
separate blocks so their destination role stays visually clear.

Inline lookup has one environment-derived interaction mode. Viewports up to 1024 px,
coarse pointers, and touch-capable devices resolve a tapped English token; wider
fine-pointer desktops expose lookup only after a text selection. Both modes share the
same token normalization, viewport clamping, and query action.

Part-of-speech switching passes through one projection boundary in
`src/features/dictionary/entry-sections.ts`. Given an entry and active tab, it derives
the visible senses, subentries, idioms, phrasal verbs, forms, illustrations, boxes,
and sidebar navigation as one consistent view. Components do not repeat ownership
rules. This prevents noun-only auxiliary material from leaking into a verb view and
keeps navigation synchronized with rendered sections.

That projection also resolves source overlap without mutating canonical data. A
word-family form and a detailed derivative are coalesced only when normalized spelling
and part of speech both match; the detailed pronunciation and senses win while a family
relation note is retained. A word-family record that repeats the active headword moves
its non-empty note into the headword content instead of appearing as its own derivative.

The mobile part-of-speech control measures its dock rather than assuming a device class.
A single part remains a non-scrollable, evenly inset capsule. Overflowing entries expose
the largest whole number of tabs that fit after reserving the quick-find action and
scroll cues; selecting the right-hand tab aligns it to the next page's leading edge.
The measurement is bounded by both the dock rectangle and the visual viewport. Resize,
visual-viewport, orientation, and tab-size observation expand and contract the tab page
in both directions. Changing entries resets the strip to its first tab, and every
non-overflowing layout resets horizontal scroll so a stale mobile-browser offset cannot
clip the active part.

### Learning Data

Anonymous use means identity is the current browser profile and origin. IndexedDB
stores personal records under `(dictionaryId, entryId)` keys. Content data remains
immutable and is never updated with notes or favorites.
History visit increments read and write inside one transaction, preventing concurrent
entry loads from losing a visit count.

The workspace reads the 100 most recent history records. Compact header and home
previews merge repeated spellings while preserving accumulated visit counts; the home
screen displays at most five recent items and five favorites, with the full collections
available from their library views.

The storage interface includes export and import boundaries so backup or optional
sync can be added later without replacing UI call sites. Clearing browser storage
removes local learning data; the interface must make that limitation visible in
settings and export flows.

### PWA Platform

The PWA layer is mounted beside the dictionary workspace in the root layout. Dictionary
components do not register Service Workers, inspect installation state, or choose cache
strategies. The platform layer owns:

- the web application manifest and install icons;
- deferred production-only Service Worker registration;
- explicit update acceptance and next-launch activation;
- a branded navigation fallback for disconnected launches;
- a pure request classifier and a build-time precache allowlist;
- small status notices that stay outside dictionary layout and modal state.

The Service Worker is an application-shell facility. Hashed JavaScript, CSS, icons, the
manifest, and the offline page are versioned precache entries. Same-origin navigations
use a bounded network-first cache. Every `/api/v1` request uses the network, including
search, entries, audio, and illustrations. Cross-origin media is passed through without
Service Worker caching. Installation never reads or downloads the runtime database or
pronunciation archive.

Learning data remains in the existing IndexedDB repository. The Service Worker neither
opens that database nor duplicates its records in Cache Storage. A future offline
dictionary would require a separate, user-initiated feature with explicit byte, entry,
version, and eviction limits.

An update installed during active use waits and presents a restrained system notice.
Activation occurs after explicit acceptance, or on the next clean page launch when a
waiting worker is already present. Only the page that requested activation reloads;
note editing is never interrupted by an automatic mid-session refresh.

## API Contract

All endpoints use `/api/v1`. Errors have a stable code, message, and request id.

```text
GET /api/v1/health
GET /api/v1/search?q=<query>&limit=<bounded integer>
GET /api/v1/entries/<url-encoded entry id>
GET /api/v1/enhancements/etymology/terms/<url-encoded term>
GET /api/v1/enhancements/etymology/articles/<url-encoded article id>
GET /api/v1/media/headword-audio?key=<url-encoded asset key>
GET /api/v1/media/example-audio?key=<url-encoded asset key>
GET /api/v1/media/illustration?key=<url-encoded asset key>
```

The entry endpoint returns the source envelope consumed by the registered adapter:

```json
{
  "entryId": "source-stable-id",
  "headword": "example",
  "sourceVersion": "bundled-v1",
  "body": {}
}
```

The browser client treats non-2xx responses, invalid runtime schemas, and aborted
requests as distinct outcomes.

## Performance Rules

- Search limits are enforced on both client and server.
- Exact and prefix results are ranked in SQL; the browser never filters the full
  dictionary.
- One-edit spelling correction runs only after an empty exact/prefix result for a
  single ASCII word of 3-64 characters. Imported deletion signatures and bounded
  primary-key probes cover deletion, insertion, substitution, and adjacent
  transposition without substring scans or a browser-side word list.
- Typo lookup caps generated terms, signatures, candidate entry ids, and returned
  results independently. Identical submitted queries are coalesced in the browser.
- Representative queries are checked with `EXPLAIN QUERY PLAN`.
- Entry payloads use independent Zstandard frames with one shared trained
  dictionary. The measured default is an 8 KiB SQLite page, Zstandard level 7, and
  a 64 KiB dictionary; all three are versioned runtime-format parameters.
- Search fields remain uncompressed and use a compact ordered prefix index.
- Payload tables use compact primary-key storage. The database records one codec
  version globally and stores each entry's uncompressed length and 32-byte checksum.
- The media archive is indexed once per service process.
- Entry JSON is parsed once at the adapter boundary.
- Enhancement summaries are stored uncompressed and require no article decoding.
- Enhancement articles use independent Zstandard frames with their own shared trained
  dictionary, bounded decoded size, capacity-limited decoding, and per-article SHA-256
  validation. A corrupt frame cannot grow the decoder output beyond the row's validated
  uncompressed length.
- Renderer keys use stable source ids, never array positions where source ids exist.
- Long entries may virtualize or collapse auxiliary sections only after profiling;
  core senses remain available to find-in-page and assistive technology.
- IndexedDB queries use dictionary and entry compound keys; read-modify-write updates
  use one read/write transaction.

## Compatibility And Versioning

`schemaVersion` changes only for a breaking canonical-model change. Adapters expose
their supported source version and fail with a typed incompatibility error when a
new source shape cannot be interpreted safely.

Additive optional fields do not require a new canonical major version. Renderers
must ignore unknown future optional fields. Raw source payloads are retained so a
new adapter can reprocess existing content without reacquiring it.

## Verification

The minimum release gate is:

1. Go integration tests against a generated SQLite and ZIP fixture.
2. Adapter contract fixtures for normal, nested, boxed, illustrated, and
   audio-bearing entries.
3. A complete source-corpus adapter audit for structural-field leakage, empty forms,
   invalid JSON, and concatenated navigation metadata.
4. TypeScript compilation and production build.
5. Browser workflows for search, entry navigation, playback, favorite, note,
   history, and refresh persistence.
6. Screenshots at desktop, tablet portrait, tablet landscape, and phone viewports,
   with overflow, overlap, sticky navigation, and media-state checks.
7. Manifest, install-icon, Service Worker header, precache-boundary, update-lifecycle,
   and offline-navigation checks against standalone production output.

## Data Delivery

Application source and dictionary assets have separate release lifecycles. The
repository contains checksums, manifests, import tooling, and small test fixtures.
Large generated databases and media archives are published as versioned release
assets or Git LFS objects so ordinary clones remain usable. Original application
databases are import inputs and are never shipped as project artifacts. Runtime
configuration resolves generated asset paths; no absolute workstation path is
compiled into the application.

The measured format and migration rules are recorded in
[STORAGE_FORMAT.md](STORAGE_FORMAT.md).

## Production Deployment

The deployable application is split at the existing HTTP boundary:

```text
Browser
   |
   v
TLS reverse proxy
   +---- /api/v1/* ---- Go API container
   |                         +---- read-only runtime SQLite
   |                         +---- read-only enhancement sidecars
   |                         +---- read-only pronunciation ZIP
   |
   +---- all other paths --- standalone Next.js container
```

The frontend build contains no dictionary payload. Its PWA precache contains only the
small application shell and never includes entry JSON or media. The API container contains no
content assets; Compose bind-mounts them from the host. This keeps Git history small
and allows independent code and content releases. Only the reverse proxy publishes host ports;
application containers remain on the private Compose network. The browser uses a
same-origin `/api/v1` URL, so deployment does not depend on a second public endpoint.
Operational details are in [DEPLOYMENT.md](DEPLOYMENT.md).
