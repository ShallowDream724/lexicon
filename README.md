<div align="center">
  <img src="public/icons/app-192.png" width="88" height="88" alt="Lexicon icon">
  <h1>Lexicon</h1>
  <p><strong>A fast, installable bilingual dictionary for desktop, tablet, and phone.</strong></p>
  <p>Dense reference content, optional etymology, and personal learning tools in one carefully responsive reading surface.</p>

  <p>
    <a href="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml"><img src="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-123768" alt="MIT license"></a>
    <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-111827" alt="Next.js 16"></a>
    <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.24-2f7f8f" alt="Go 1.24"></a>
  </p>

  <p><strong>40,974 entries · 51,716 etymology articles · 256,026 pronunciations · 220,328 typo signatures</strong></p>
</div>

<img src="docs/readme/hero-desktop.webp" width="100%" alt="Lexicon desktop entry view with indexed navigation, pronunciation, examples, and etymology">

## One reading surface, shaped for the device

Lexicon keeps the same dictionary model across every viewport while adapting the
way people navigate it:

- **Desktop:** a persistent entry outline, wide reading column, and compact resource rail.
- **Tablet:** portrait and landscape compositions that preserve hierarchy without wasting width.
- **Phone:** touch lookup, a measured part-of-speech dock, and full-width supplementary resources.
- **Installable PWA:** a small application shell with explicit updates and an offline launch page;
  dictionary payloads and media are never downloaded as part of installation.

<img src="docs/readme/responsive-devices.webp" width="100%" alt="Lexicon tablet and phone layouts in separate fitted device frames">

The interface renders nested senses, constructions, examples, bilingual labels, pronunciation,
illustrations, usage panels, idioms, phrasal verbs, derivatives, cross-references, and optional
enhancements from one canonical entry contract. History, favorites, and notes remain local to the
current browser profile, with no account or registration flow.

## Etymology, without leaving the entry

Etymology is implemented as an independent enhancement sidecar. Matching entries receive a bounded
summary card; opening it loads only the selected article. Terms that exist only in the enhancement
source remain searchable without manufacturing an empty primary-dictionary record.

<img src="docs/readme/etymology-reader.webp" width="100%" alt="Expanded desktop etymology reader with article navigation and linked historical forms">

<p align="center">
  <img src="docs/readme/etymology-mobile.webp" width="360" alt="Expanded etymology reader filling a phone viewport">
</p>

Article links resolve through stable article identifiers, then return to the canonical term. The
reader preserves semantic emphasis and historical-language runs while keeping the underlying entry
in place.

## Measured scale

The reference runtime is designed around indexed lookup and independently compressed records rather
than shipping a large JSON corpus to the browser.

| Runtime surface | Measured scale | Runtime treatment |
| --- | ---: | --- |
| Primary dictionary | 40,974 entries | 51.45 MiB read-only SQLite runtime |
| Etymology enhancement | 46,773 terms / 51,716 articles | 43.30 MiB independent sidecar |
| Headword pronunciation | 256,026 MP3 members | 1.06 GiB ZIP, indexed and streamed without extraction |
| Typo correction index | 220,328 deletion signatures | bounded indexed probes; no substring scan |
| Installable application shell | 26 precache entries / about 1.07 MiB | UI assets only; no entry JSON, SQLite, ZIP, or media |

On the documented reference probe, exact and prefix HTTP search measured **7.9 ms p95** and bounded
one-edit correction measured **10.3 ms p95**. These are reproducible benchmark results, not
cross-hardware latency guarantees. See [STORAGE_FORMAT.md](STORAGE_FORMAT.md) for the full storage
matrix, query plans, codec parameters, and measurement method.

## Architecture

```text
read-only import source
        |
        v
one-way importer  ----  project-owned runtime SQLite
        |                         + optional enhancement sidecars
        v
Go search and media API
        v
TypeScript source adapter  ----  CanonicalEntry v1
        v
responsive React renderer  ----  browser-local IndexedDB learning data
        |
        +-----------------------  isolated PWA platform layer
```

The Go service owns indexed search, bounded typo recovery, storage validation, decompression, and
media streaming. Source adapters own validation and conversion into the canonical UI model. React
components never inspect source-table names or open storage files. Optional resource types register
their ordering, card size, quick-find placement, and opening behavior through one presentation
registry.

This separation keeps new import formats and supplementary datasets out of the core renderer. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [DATA_MODEL.md](DATA_MODEL.md) for the contracts and ownership
rules.

## Technology

- React 19, TypeScript, and Next.js 16 standalone output.
- Go 1.24 for the read-only SQLite and media service.
- Serwist for the isolated Service Worker and bounded application-shell cache.
- Zod at external data boundaries and IndexedDB for device-local learning records.
- Independent Zstandard frames with shared dictionaries for random-access entry payloads.

## Quick start

Requirements: Node.js 22.13 or newer, Go 1.24 or newer, and a generated runtime database at
`data/dictionary.db`. The etymology sidecar and pronunciation archive are optional during local
development.

```bash
npm ci
```

Start the API and web application in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev
```

The web application opens at `http://localhost:3000` and calls the API at
`http://localhost:8787/api/v1` by default. Use `.env.local` when the API is served from another
origin. Development mode does not register a Service Worker, so stale application caches cannot
mask source changes.

Optional runtime assets can be supplied explicitly:

```bash
npm run dev:api -- \
  -db ../../data/dictionary.db \
  -etymology-db ../../data/etymology.db \
  -audio-zip ../../data/headword-audio.zip
```

## Import and extend

Importers are deterministic, transactional, and one-way: source databases stay read-only while the
application receives project-owned schemas and indexes.

```bash
npm run dictionary:import -- \
  -source ../../data/source.db \
  -target ../../data/dictionary.db \
  -source-version source-2026-01

npm run etymology:import -- \
  -source ../../data/etymology-source.db \
  -target ../../data/etymology.db \
  -source-version etymology-2026-01
```

A new JSON, MDX, StarDict, or remote source belongs behind an adapter and fixtures rather than source
conditionals in UI components. [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) documents the extension path.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` runs frontend contract tests, every Go package test, a production build, and standalone
response tests for the application, manifest, icons, offline page, and Service Worker. The release
matrix also covers desktop, tablet portrait, tablet landscape, and phone behavior.

## Documentation

| Document | Scope |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module ownership, request flow, performance rules, and compatibility |
| [DATA_MODEL.md](DATA_MODEL.md) | Canonical dictionary and enhancement contracts |
| [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) | Adding and validating source formats |
| [STORAGE_FORMAT.md](STORAGE_FORMAT.md) | Compression, indexing, benchmarks, and migration rules |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Self-hosted topology, assets, proxying, updates, and rollback |
| [PWA.md](PWA.md) | Installation, cache boundaries, updates, and offline behavior |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow and release checks |

## Deployment

The application ships as separate standalone web and Go API containers. Generated databases and the
packed pronunciation archive are mounted read-only, so code releases never rewrite content assets.
The deployment can use the included reverse-proxy reference or join an existing proxy network; see
[DEPLOYMENT.md](DEPLOYMENT.md) for the branch-specific topology and commands.

## Data and licensing

The application source is available under the [MIT License](LICENSE). Source databases, generated
runtimes, media, application packages, and captured payloads have separate provenance and are not
covered automatically by the software license. Deploy and redistribute only data for which the
intended use is permitted.
