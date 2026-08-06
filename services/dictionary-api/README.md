# Dictionary API

Read-only local HTTP service for a generated dictionary database and headword
pronunciation archive.

The same binary runs locally or in the server container. Content files are mounted at
runtime and are never copied into the image.

## Import

The importer opens a supported source database read-only and creates a new runtime
database with the project schema. The target must not exist unless `-replace` is
specified.

```sh
go run ./cmd/dictionary-import \
  -source ./data/source.db \
  -target ./data/dictionary.db \
  -source-version bundled-v1 \
  -page-size 8192 \
  -compression-level 7 \
  -dictionary-size 65536
```

The generated database contains only dictionary entries, normalized search terms,
bounded search projections, codec metadata, and checksums. Source application tables
and unrelated metadata are not copied. Runtime schema upgrades require rebuilding the
database from the source; existing runtime databases are never migrated in place.

## Run

```sh
go run ./cmd/dictionary-api \
  -db ./data/dictionary.db \
  -audio-zip ./data/headword-audio.zip \
  -example-audio-base-url https://media.example.test/audio/examples/ \
  -illustration-base-url https://media.example.test/images/ \
  -listen 127.0.0.1:8787 \
  -cors-origins http://localhost:3000
```

Importer environment variables:

```text
DICTIONARY_SOURCE_DB_PATH
DICTIONARY_RUNTIME_DB_PATH
DICTIONARY_SOURCE_VERSION
```

API environment variables:

```text
DICTIONARY_RUNTIME_DB_PATH
DICTIONARY_AUDIO_ZIP_PATH
DICTIONARY_EXAMPLE_AUDIO_BASE_URL
DICTIONARY_ILLUSTRATION_BASE_URL
DICTIONARY_LISTEN
DICTIONARY_CORS_ORIGINS
```

Endpoints:

```text
GET /api/v1/health
GET /api/v1/search?q=word&limit=20
GET /api/v1/entries/{id}
GET /api/v1/media/headword-audio?key=word%23_gb_1
GET /api/v1/media/example-audio?key=example%23_gbs_1
GET /api/v1/media/illustration?key=illustration-key
```

Each search item contains `id`, `headword`, `partsOfSpeech`, and
`translationPreview`. Errors contain a stable code, message, and request id; the
same request id is returned in `X-Request-ID`.

## Storage

The payload table stores independent `zstd-dict-json-v1` level-7 BLOBs in an
8 KiB-page SQLite database. Import
deterministically samples entry bodies in primary-key order, trains one shared
dictionary, and records the dictionary, codec implementation, compression level,
and SHA-256 in metadata. Every payload keeps its original byte length and a 32-byte
SHA-256 digest. The API verifies length, digest, and JSON validity after decoding.

Search uses the `(term, entry_id)` primary key directly for exact and prefix range
queries. When that path has no result, a single ASCII English word of 3-64 characters
can use the imported `(signature, term)` deletion index for a bounded one-edit correction;
the existing `(term, entry_id)` key resolves matching entries without repeating entry ids
in the correction index. Adjacent transpositions remain bounded exact term lookups. Search
reads each matching entry's stored parts-of-speech and Chinese translation preview without
decoding the compressed entry body.

The optional headword-audio archive is indexed once at startup. Duplicate keys are
excluded to avoid ambiguous responses, and individual assets stream without
extraction. Example-audio and illustration routes redirect only to configured HTTP
or HTTPS base URLs after validating each opaque key as one path segment. Leaving a
media source unconfigured does not prevent search and entry lookup from starting.

## Container

From the repository root, prepare `data/dictionary.db` and
`data/headword-audio.zip`, then use the Compose definition in `deploy/server`. It
mounts both files read-only and keeps the API bound to the host loopback interface by
default. Configure an exact HTTPS frontend origin before starting the service. The
complete production procedure is in the root [deployment guide](../../DEPLOYMENT.md).

## Verification

```sh
go test ./...
go test -bench RandomEntryDecode ./internal/server
```
