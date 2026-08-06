# Lexicon Workbench

Lexicon Workbench is a responsive bilingual dictionary workspace with local search,
pronunciation playback, history, favorites, notes, and adapter-based data import.
It runs without registration or account state.
Exact and prefix search can fall back to a bounded one-edit spelling suggestion for a
single English word without loading or scanning the dictionary in the browser.

## Technology

- React 19, TypeScript, and Next.js standalone output for the responsive application.
- Go for the read-only SQLite and media service.
- Zod for external data validation.
- IndexedDB for device-local learning data.

The source service, adapter contract, renderer, and personal-data store are separate
modules. See [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), and
[ADAPTER_GUIDE.md](ADAPTER_GUIDE.md). Runtime compression decisions and measured
tradeoffs are in [STORAGE_FORMAT.md](STORAGE_FORMAT.md).
Production topology and server setup are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Requirements

- Node.js 22.13 or newer.
- Go 1.24 or newer.
- A generated Lexicon Workbench runtime database.
- An optional pronunciation archive.

## Local Development

Install dependencies:

```bash
npm install
```

Start the dictionary service in one terminal:

```bash
npm run dev:api
```

The default command opens the repository's `data/dictionary.db` and starts even when
no media source is configured. The npm script supplies that database path explicitly;
override it with a later `-db` flag. Optional media flags can also be added after
`--`; paths are relative to `services/dictionary-api`:

```bash
npm run dev:api -- \
  -db ../../data/another-runtime.db \
  -audio-zip ../../data/headword-audio.zip \
  -example-audio-base-url https://media.example.test/audio/examples/ \
  -illustration-base-url https://media.example.test/images/
```

Start the web application in another terminal:

```bash
npm run dev
```

The web application uses `http://localhost:8787/api/v1` by default. The Go commands
also accept the environment variables documented in
`services/dictionary-api/README.md`; command-line flags take precedence.

Copy `.env.example` to `.env.local` when the API is available at another origin.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` runs adapter contracts, all Go tests, a production build, and the rendered
HTML smoke test.

## Data Operations

Import a supported source into the project-owned runtime schema:

```bash
npm run dictionary:import -- \
  -source ../../data/source.db \
  -target ../../data/dictionary.db \
  -source-version bundled-v1
```

Run the reproducible storage matrix with `npm run dictionary:benchmark -- ...`.
Command arguments use paths relative to `services/dictionary-api`; the complete
parameter reference is in [STORAGE_FORMAT.md](STORAGE_FORMAT.md).

Audit every source entry against the adapter's semantic invariants:

```bash
npm run dictionary:audit -- \
  --source outputs/source/ciku.db \
  --source-version bundled-v1
```

The audit reports source tag, canonical label, and canonical form counts and exits
non-zero when source structure leaks into visible fields or an entry cannot be
adapted.

## Dictionary Assets

Large generated databases and media archives are versioned separately from ordinary
source files. A one-way importer reads supported source files and writes a fresh
project-owned schema; original application databases are never shipped directly.
Each data release includes a manifest, byte size, SHA-256 checksum, runtime schema
version, and compatible adapter version. Configure local asset paths rather than
committing workstation-specific paths.

The application repository's software license does not automatically apply to
imported dictionary content. Each data package carries its own provenance and usage
terms.

## Deployment

The supported public topology runs Caddy, the standalone Next.js application, and the
Go API together on one server. The server mounts the generated database and
pronunciation ZIP as read-only files, so code updates never rewrite content assets.
The ZIP remains packed: the API indexes it once and streams individual MP3 members
without extracting 256,026 files. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact
layout and commands.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Source databases, generated runtimes, media,
application packages, and extracted reference material are intentionally excluded
from the software repository.
