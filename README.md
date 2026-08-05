# Lexicon Workbench

Lexicon Workbench is a responsive bilingual dictionary workspace with local search,
pronunciation playback, history, favorites, notes, and adapter-based data import.
It runs without registration or account state.

## Technology

- React 19, TypeScript, and Vinext for the responsive application.
- Go for the read-only SQLite and media service.
- Zod for external data validation.
- IndexedDB for device-local learning data.

The source service, adapter contract, renderer, and personal-data store are separate
modules. See [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), and
[ADAPTER_GUIDE.md](ADAPTER_GUIDE.md).

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

Start the web application in another terminal:

```bash
npm run dev
```

The web application uses `http://localhost:8787/api/v1` by default. Override paths
and ports through the documented environment variables in
`services/dictionary-api/README.md`.

## Verification

```bash
npm test
npm run lint
go test ./... ./services/dictionary-api/...
```

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
