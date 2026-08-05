# Lexicon Workbench Architecture

## Goals

Lexicon Workbench is an anonymous, responsive dictionary application for desktop,
tablet, and phone. It keeps dictionary content read-only, stores each browser's
learning data separately, and accepts additional dictionary formats through
versioned adapters.

The first release optimizes for:

- faithful dictionary-page typography and information density;
- local, low-latency search over a large SQLite source;
- complete rendering of nested senses, examples, usage notes, audio, and images;
- no account, registration, advertising, or application-download surface;
- source adapters that can evolve without changing React components;
- explicit contracts and tests at every boundary where source data changes shape.

## System Shape

```text
Read-only import source
        |
        v
One-way importer  ----  project-owned runtime SQLite + media manifest
        |
        v
Go source service  ----  /api/v1/search, /entries, /media
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
```

Dependencies point down this diagram. UI modules never import source-table names,
open SQLite files, inspect ZIP archives, or depend on an adapter's private types.

## Repository Boundaries

```text
app/                         application routes and global composition
src/features/dictionary/     dictionary UI and feature state
src/lib/dictionary-client/   cancellable HTTP client and query orchestration
src/lib/storage/             device-local learning-data repository
packages/dictionary-schema/  versioned UI-facing domain contract
packages/adapters/           source adapters and registry
services/dictionary-api/     read-only Go/SQLite/media service
tests/contracts/             source-to-domain invariants
tests/e2e/                   responsive workflows and visual checks
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
- returning a stable envelope around the unmodified entry JSON;
- indexing the pronunciation archive once and streaming individual assets;
- enforcing request limits, timeouts, cancellation, and structured errors.

It does not build the UI-facing entry model. This avoids implementing the same
semantic conversion in Go and TypeScript.

### Dictionary Adapter

An adapter validates the source envelope, recursively converts source fields into
`CanonicalEntry`, and retains the original entry under `raw`. Arrays keep source
order. Unknown fields remain available even when the current renderer ignores
them.

Adapter registration is explicit. A future MDX, StarDict, JSON, or remote source
adds an adapter and fixtures; it does not add source conditionals to components.

### React Application

The React layer renders only canonical types. It owns:

- responsive page composition;
- search suggestions and route state;
- audio playback state;
- sense, example, cross-reference, box, and illustration presentation;
- favorites, notes, history, and display preferences through repository methods.

Search requests are debounced and cancellable. Full entries load only after a
selection. Large entry bodies do not enter the initial hydration payload.

### Learning Data

Anonymous use means identity is the current browser profile and origin. IndexedDB
stores personal records under `(dictionaryId, entryId)` keys. Content data remains
immutable and is never updated with notes or favorites.

The storage interface includes export and import boundaries so backup or optional
sync can be added later without replacing UI call sites. Clearing browser storage
removes local learning data; the interface must make that limitation visible in
settings and export flows.

## API Contract

All endpoints use `/api/v1`. Errors have a stable code, message, and request id.

```text
GET /api/v1/health
GET /api/v1/search?q=<query>&limit=<bounded integer>
GET /api/v1/entries/<url-encoded entry id>
GET /api/v1/media/headword-audio?key=<url-encoded asset key>
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
- Representative queries are checked with `EXPLAIN QUERY PLAN`.
- The media archive is indexed once per service process.
- Entry JSON is parsed once at the adapter boundary.
- Renderer keys use stable source ids, never array positions where source ids exist.
- Long entries may virtualize or collapse auxiliary sections only after profiling;
  core senses remain available to find-in-page and assistive technology.
- IndexedDB queries use dictionary and entry compound keys.

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
3. TypeScript compilation and production build.
4. Browser workflows for search, entry navigation, playback, favorite, note,
   history, and refresh persistence.
5. Screenshots at 1440x1000, 768x1024, and 390x844 with overflow and overlap checks.

## Data Delivery

Application source and dictionary assets have separate release lifecycles. The
repository contains checksums, manifests, import tooling, and small test fixtures.
Large generated databases and media archives are published as versioned release
assets or Git LFS objects so ordinary clones remain usable. Original application
databases are import inputs and are never shipped as project artifacts. Runtime
configuration resolves generated asset paths; no absolute workstation path is
compiled into the application.
