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
One-way importers  ----  project-owned runtime SQLite + enhancement sidecars
        |
        +--------------  media manifest and pronunciation archive
        |
        v
Go source service  <----  immutable reverse-search + semantic sidecars
        ^
        +--------------  optional OpenAI-compatible query embedding
        |
        +--------------  /api/v1/search, /entries, /enhancements, /media
        |
        v
TypeScript source adapter
        |
        v
CanonicalEntry v1
        |
        +---- React dictionary renderer
        |
        +---- offline SearchDocument projection ----> immutable lexical + semantic sidecars
        |
        +---- IndexedDB learning data: query history, visits, favorites, notes, preferences

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
packages/dictionary-search/  source-neutral search documents and locations
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
- bounded, parameterized search with deterministic exact, word-before-phrase,
  canonical-length, and lexical ranking;
- validating the reverse-search sidecar against the primary database fingerprint;
- exact-segment and bounded FTS candidate retrieval, followed by deterministic grouped
  Chinese-result ranking;
- validating the semantic sidecar against both database fingerprints and its model contract;
- bounded resident int8 retrieval, four-request/64-flight embedding admission, bounded memory
  and persistent query-vector caching, and deterministic lexical-semantic fusion for explicitly
  submitted Chinese intent queries;
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

Chinese reverse search uses a separate derived sidecar rather than adding request-time
scans to the primary database. It stores only source-neutral search documents projected
from validated canonical entries. Metadata pins the canonical projection version,
normalizer version, source version, document count, and SHA-256 of the exact primary
runtime database. A missing sidecar returns `503 reverse_search_unavailable` for Chinese
queries. A configured but incompatible sidecar fails startup so evidence locations cannot
drift from entry data.

Semantic Chinese search derives a second immutable sidecar from that same canonical
reverse-search projection. It stores one vector per unique visible Chinese text plus the
source-neutral evidence needed to recover entry locations. Metadata pins the primary and
reverse-search SHA-256 values, semantic projection version, corpus fingerprint, model key,
dimensions, query template, provider task options, scope set, and quantization. The API
loads int8 vectors into a bounded resident array and keeps evidence in read-only SQLite.
Replacing the primary or reverse-search database therefore also requires a compatible
semantic rebuild.

Only the query text needed to produce one vector crosses the optional OpenAI-compatible
provider boundary. Document vectors are built once and distributed as a release asset. The provider model name is a
deployment routing value; the project-owned model key identifies a compatible embedding
space. Missing provider configuration disables semantic retrieval while preserving the
complete lexical Chinese path. Provider failures during a request degrade to that lexical
page rather than failing dictionary search.

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
labels, structured derivatives retain their pronunciations, senses, and attached
variants, definition-level pronunciation stays in ordered content segments beside its
term, and box navigation targets remain separate from display blocks. A form's ordered
presentation keeps introducers, semantic labels, its target, and pronunciation in
source order; renderers never reconstruct that order from source tokens. Repeated
source transport groups may be deduplicated structurally, while ordered same-spelling
forms within a group remain intact.

Adapter registration is explicit. A future MDX, StarDict, JSON, or remote source
adds an adapter and fixtures; it does not add source conditionals to components.

### Reverse-Search Projection

`packages/dictionary-search` is the single projection boundary between canonical content
and Chinese lookup. It recursively traverses root entries, subentries, senses, examples,
phrases, usage segments, forms, and grammar or usage boxes. Each bilingual projection is
a `SearchDocument` with a semantic scope, English and Chinese text, a stable entry id,
and a source-neutral location consisting of section, part of speech, owner id, and
canonical object path.

The same traversal builds the browser's object-to-location index. Search evidence and
rendered anchors therefore cannot acquire separate path conventions. Content from a new
adapter enters reverse search automatically as soon as it maps to existing canonical
fields. A genuinely new canonical semantic type adds one projection branch, one rendered
anchor, and one contract fixture at this boundary; individual adapters, result pages,
and navigation components remain unchanged. Preserved `raw` data is deliberately not
indexed because it may contain transport fields or content the UI cannot display.

The projection also resolves bounded headword surface forms for result evidence. Canonical
`inflectedForms` are authoritative for irregular morphology. A build-only English lemmatizer
supplements them only with surface forms observed in that entry's projected evidence, using
the evidence's known part of speech. Only lexical entry variants and same-headword entry paths
participate. Sense-level alternative wording, constructions, derivatives, differently named
subentries, unobserved guesses, and evidence without a known part of speech remain outside the
form relation. The reverse sidecar stores that relation once, and the API enriches an entire
result window through one batch query. React receives explicit forms and contains no
irregular-word table or morphology rules; build-only morphology code is absent from the web
bundle and request path.

The build script streams projected documents into the Go importer. The importer validates
ordering and bounds, creates a deduplicated exact-segment B-tree beside the contentless FTS
projection, builds a new SQLite file transactionally, and atomically replaces an existing
sidecar only when explicitly requested. Supplementary resources keep their own versioned
search providers and merge with primary results at the API boundary.

Structured canonical text is split by its language tokens. Simplified, traditional, and
standard Chinese tags enter the Chinese projection; known English tags enter the English
projection; unlabelled formatting tokens fall back to script-aware splitting. Rich box
paragraphs and cells emit their ordered segments instead of also indexing an aggregate
compatibility value. Repeated paths to the same source box retain the deepest rendered
owner, while equal text under distinct semantic owners remains independently searchable.

### React Application

The React layer renders only canonical types. It owns:

- responsive page composition;
- search suggestions and route state;
- audio playback state;
- sense, example, cross-reference, box, and illustration presentation;
- structured headword patterns, inflections, word families, and derivatives;
- favorites, notes, history, and display preferences through repository methods.

The search header uses three responsive compositions. Wide layouts keep the horizontal
brand lockup. Tablet and constrained desktop widths collapse it to the brand mark and place
the mark and search form in one centered two-column group; portrait tablets use a dedicated
three-quarter-width search bound while landscape tablets retain the wider track. Phone layouts restore the full
lockup above a compact form. The home form is bounded on phones, then its control geometry
and width grow continuously toward the wide layout instead of jumping at a device breakpoint.
Home-only variables own its topbar, brand-to-form gap, recent-query row, and content insets;
inner-page tablet sizing never participates in the home flex composition. Header height is
derived from the intrinsic search stack and bounded continuous insets. The lower inset contracts
by the same amount as the home search control, so compact controls do not leave surplus blue
space while ultra-wide layouts cannot turn flex surplus into empty blue space. The form reserves
the recent-query row before the first query so that history availability does not move the brand.
The recent-query label remains fixed while its complete records occupy one independently
scrollable line with no visible scrollbar. Its reserved interaction height contains coarse-pointer
targets without clipping when the viewport height changes. Intrinsic content remains free to
expand under text zoom. Brand scale and vertical spacing follow continuous width curves so
crossing a device breakpoint does not create a visual jump.

The entry reading shell uses fixed top insets for phone, portrait-tablet, and wider
compositions, while headword separation grows continuously without an intermediate-width
jump. Its portrait-tablet composition applies separate compact scales to the headword,
metadata, pronunciation, and part marker; phone and landscape baselines remain independent.

Optional entry resources pass through one registry in
`src/features/dictionary/resource-model.ts`. The registry determines stable ordering,
card size, quick-find placement, and opening behavior. Source-specific checks stay in
resource renderers and clients rather than spreading through the entry view. Resource-card
widths come from one rail-level size contract: featured cards share one bounded width on
desktop and portrait tablets, while phones explicitly promote them to a full row; native
dictionary cards retain their compact size. Portrait tablets lay these stable widths into a
wrapping row: a card moves intact to the next row only when the remaining inline space is too
small, while additional content grows the card vertically without changing its wrap size. A
featured card exposes its first article as the card-wide primary action, while article chips are
independent direct actions for a specific article. Etymology cards retain a book-page
aspect ratio on desktop and landscape tablets, use the shared bounded horizontal format
on portrait tablets, and expand to the full row only on phones. Their title and action
occupy fixed layout rows while the
summary consumes the remaining card height; the card's resize observer derives the
available line count without introducing viewport-specific text limits. The watermark
stays anchored to the paper corner and scales from the card block size. Narrow phones
hide the paper heading so the content begins with the headword while retaining the
source mark on the spine. The footer is an unseparated inline action whose chevron
follows its label; its narrow-phone typography is enlarged because the hidden heading
makes the action carry the resource identity. Summary text uses the same semantic
emphasis runs as the article source, so presentation never infers historical-language
spans from words. Card typography is owned by its fixed geometry and does not inherit the
reading-size preference; the expanded article keeps its independent adjustable scale.

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

English exact, prefix, correction, and etymology search keep their existing orchestration.
A query containing Han characters uses the reverse-search sidecar and always remains on a
grouped results page, even when one entry matches. Each evidence row carries its canonical
location. Selecting it loads the entry, switches to the matching part of speech, opens a
registered resource when needed, scrolls to the most specific rendered path, and marks that
target with one transient three-second highlight after scrolling settles. Repeated selections
replace the previous pending or active highlight through the same location service. Owner and
section checks prevent repeated source ids from opening an unrelated resource; older or
coarser locations fall back to their owner and then their section.

Chinese suggestions remain a debounced lexical request. An explicit submission containing
at least two Han characters and no more than 200 Unicode characters opts into hybrid mode.
The server retrieves the complete bounded lexical and dense windows, protects full-boundary
Chinese evidence, and compares each entry's strongest semantic evidence before using
same-band corroborating evidence. It never sums evidence counts, so several weaker matches
cannot outrank one clearly stronger match. Query-vector and page caches are server-owned;
browser scope changes and continuation requests keep the hybrid mode but never hold vectors
in client state. An optional bounded SQLite cache stores only keyed query hashes and vectors
across restarts; its namespace includes the complete embedding contract.

Chinese results default to definitions, phrases, and forms. Users may include usage notes
or examples through one canonical scope control. Scope is part of the request identity,
URL, cancellation boundary, and every continuation page. The API applies it before its
candidate limit, so changing scope searches the complete eligible projection instead of
filtering an already truncated browser result. Each semantic ranking tier owns an independent,
fixed candidate budget. Complete-token matches suppress partial fallback only within their
own tier, so enabling examples cannot evict or disable term and phrase candidates. All tiers
then share the existing deterministic scorer, grouping, and pagination boundary. A scope
change keeps the controls and current result list mounted while the replacement request is
pending, updates the checked state immediately, and announces progress through a non-visual
live region. New submitted queries retain the full loading transition.

Result-page navigation keeps a bounded three-query in-memory session cache keyed by the
canonical query and scope. Each session retains the loaded result window and scroll offset,
so history navigation from an entry restores both without serializing result bodies into the
URL, browser history, or persistent storage. Pending continuation requests are normalized to
a retryable idle state before capture, and older sessions are evicted by least recent use.
The result page owns its centered reading column and discrete phone, tablet, and desktop
type scales; it never inherits the entry sidebar gutter or viewport-proportional typography.
Its phone baseline stays close to the entry body so moving between an entry and its related
results does not require changing the shared preference. The result list uses the same
border-to-item inset for its first and subsequent groups, and larger result shells keep a
compact top inset below the header transition.
One three-level reading-size preference is mounted in the shared header and applied at the
workspace root. Entry pages retain their type hierarchy while the phone reading region applies
a uniform two-pixel reduction to its own baseline; supplementary resource cards and etymology
remain outside that adjustment. Result pages retain separate responsive baselines. Small and
large levels apply a bounded pixel delta to reading text, cards, and result evidence without
scaling layout geometry or search controls; long-form etymology uses a restrained independent
delta. Result labels use a bounded phone track and wrap long part-of-speech qualifiers inside
that track; larger layouts size the track from its content. A larger level therefore cannot
push the label into its evidence text. Dialog portals mirror the same
preference variables because their DOM nodes live outside the workspace root.

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
same token normalization, viewport clamping, and query action. One workspace-level listener
serves every explicitly marked reading surface, including entry content and portalled resource
or etymology dialogs. The action is portalled back into the active surface, while buttons,
links, form controls, and editable content remain outside lookup handling. New reading cards
join this behavior through the same surface contract instead of mounting another listener.

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
A non-overflowing capsule ends after the aggregate rendered width of its labels instead of
estimating every label from the first one. Overflowing entries expose
the largest whole number of tabs that fit after reserving the quick-find action and
scroll cues; selecting the right-hand tab aligns it to the next page's leading edge.
Available directions receive a low-frequency, reduced-motion-aware outward nudge on their
white chevrons; hidden directions expose no cue. Both cue elements start their animation
at the same mount phase, while scroll availability controls only visibility. A newly
available direction therefore joins the existing synchronized beat instead of starting
an independent animation clock.
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

Entry visits and submitted queries use separate stores and retention policies. The workspace
reads the 100 most recent records from each. Compact visit previews in the home screen
merge repeated spellings while preserving accumulated visit counts; the home
screen displays at most five recent items and five favorites, with the full collections
available from their library views.

Every explicit non-empty query is recorded after normalization for identity while retaining
its complete cleaned display text. Suggestions, URL hydration, browser history navigation,
scope changes, retries, and continuation pages do not create records. The header shows the
five newest queries and refills from the retained 100 after deletion. Fine-pointer devices
reveal an independent delete target on hover or keyboard focus; touch pointers use a
movement-cancellable long press, independent of viewport width. Query-history mutations
use optimistic deletion plus a latest-revision reconciliation guard, so rapid submissions
and deletions cannot restore a stale browser-storage snapshot.

History, favorites, and notes share one selection model in the personal-library drawer.
Bulk deletion, un-favoriting, and note deletion use one transaction per store and require a
modal confirmation. The confirmation owns Escape while open and remains locked during its
pending operation, preventing the underlying drawer from closing mid-transaction.

Display preferences use the same IndexedDB repository and backup boundary as other learning
data. Reading size is stored as `small`, `default`, or `large`; the workspace applies an
optimistic change immediately and serializes writes so rapid slider changes preserve the last
selected level.

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
`GET /api/v1/health` reports `capabilities.chineseReverseSearch`,
`capabilities.semanticSearch`, `capabilities.etymology`, and
`capabilities.headwordAudio` so callers can distinguish
enabled optional resources from unavailable ones.

```text
GET /api/v1/health
GET /api/v1/search?q=<query>&limit=<bounded integer>&offset=<Chinese results only>&scope=<Chinese scopes>&mode=<lexical|hybrid>
GET /api/v1/entries/<url-encoded entry id>
GET /api/v1/enhancements/etymology/terms/<url-encoded term>
GET /api/v1/enhancements/etymology/articles/<url-encoded article id>
GET /api/v1/media/headword-audio?key=<url-encoded asset key>
GET /api/v1/media/example-audio?key=<url-encoded asset key>
GET /api/v1/media/illustration?key=<url-encoded asset key>
```

Chinese search items additionally include up to eight bounded evidence records. Each
record contains `scope`, `englishText`, `chineseText`, and a validated `location`. English
search items retain their existing compact response shape. Chinese requests accept an
optional `offset`; their default page contains 32 groups, a page contains at most 256, and
`nextOffset` is returned only while more of the stable 512-group result window remains.
Their optional comma-separated `scope` uses the stable order
`sense,phrase,form,usage,example`; omission defaults to `sense,phrase,form`. Empty,
repeated, whitespace-bearing, or unknown values are rejected, and English requests reject
the parameter. `mode=hybrid` is accepted only as an explicit opt-in; ineligible queries use
the lexical path, and an unavailable semantic provider does not remove lexical results.

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

- Search result limits are enforced on both client and server.
- Search queries are limited to 200 Unicode characters in the client, HTTP handler, and
  reverse-search store; `query_too_long` remains distinct from a service failure.
- A one-segment reverse query probes the exact-segment B-tree so a complete short meaning
  cannot be displaced by common FTS terms. Each selected semantic ranking tier retrieves at
  most 4,096 documents, with at most three independently bounded pools. Multi-token lookup
  tries the all-token expression per semantic tier and uses bounded OR retrieval only for a
  tier with no usable complete-token result. Scope plus ASCII and numeric constraints are
  applied before each SQL candidate limit; Go refinement respects normalized Chinese segment
  boundaries, uses deterministic tie-breaks, and returns at most 512 entry groups with eight
  evidence records per entry.
- Chinese result pages begin at 32 groups and expand cumulatively to 64, 128, 256, then
  512. Each request transfers only the next page, and route changes cancel in-flight pages.
- Scope predicates run in exact and FTS SQL before their candidate limits. Candidate retrieval
  remains separate from final ranking. Complete matches rank match quality, protected candidate
  pool, semantic scope (sense, then phrase or form, usage, and example), distinct corroborating
  Chinese evidence, and bounded score. Partial matches rank textual relevance before semantic
  scope; query-leading coverage improves suffix and noise cases. Identical Chinese evidence does
  not increase corroboration.
- Traditional-to-simplified conversion uses one process-wide, race-safe converter. A query
  is normalized once before its CJK sequences, runes, and FTS tokens are derived.
- Semantic document vectors use L2-normalized symmetric int8 storage. Startup validates a
  512 MiB resident-vector ceiling; the bundled 178,382 by 1,024 matrix occupies about
  174 MiB. One uncached query scans it with at most four workers and keeps at most 4,096
  text candidates before evidence projection.
- Semantic queries require at least two Han characters. Typing suggestions, English lookup,
  one-character Chinese lookup, invalid input, and oversized input never call the provider.
  Identical concurrent queries share one call; bounded vector and page LRUs avoid another
  call for repeated queries, scope changes, and pagination. An optional SQLite cache preserves
  normalized vectors across restarts under HMAC keys, TTL, and a fixed LRU capacity without
  storing query text.
- The embedding request has a deployment-configured timeout, validates the model key and
  dimensions against sidecar metadata, caps response bytes, rejects malformed or non-finite
  vectors, and degrades to lexical retrieval on request-time failure.
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
4. Deterministic reverse-search projection/import checks, primary fingerprint validation,
   representative relevance cases, and bounded latency benchmarks.
5. Semantic builder resume, budget, metadata, quantization, runtime scan, cache, fusion,
   provider-failure, and representative intent-quality checks.
6. TypeScript compilation and production build.
7. Browser workflows for search, entry navigation, playback, favorite, note,
   history, and refresh persistence.
8. Screenshots at desktop, tablet portrait, tablet landscape, and phone viewports,
   with overflow, overlap, sticky navigation, and media-state checks.
9. Manifest, install-icon, Service Worker header, precache-boundary, update-lifecycle,
   and offline-navigation checks against standalone production output.

## Data Delivery

Application source and dictionary assets have separate release lifecycles. The
repository contains checksums, manifests, import tooling, and small test fixtures.
Large generated databases, derived search sidecars, and media archives are published as versioned release
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
   |                         +---- read-only reverse-search + semantic sidecars
   |                         +---- read-only enhancement sidecars
   |                         +---- read-only pronunciation ZIP
   |                         +---- optional outbound query-embedding provider
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
