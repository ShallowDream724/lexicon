# Dictionary API

Read-only local HTTP service for a generated dictionary database, its derived Chinese
reverse-search sidecar, optional enhancement sidecars, and a headword pronunciation archive.

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

Build the optional etymology sidecar separately:

```sh
go run ./cmd/etymology-import \
  -source ./data/etymology-source.db \
  -target ./data/etymology.db \
  -source-version etymonline-2024.12.10
```

This importer projects source HTML into ordered semantic blocks, keeps internal links
structured, retains valid unindexed articles under their own headword, and writes
independently compressed article payloads. It never serves or copies the source tables.

Build the reverse-search sidecar from the generated primary database and the registered
canonical adapter:

```sh
npm run reverse-search:build
```

The root script streams source-neutral `SearchDocument` records to the Go importer. The
sidecar records the exact primary database SHA-256 and is rejected at API startup if the
two files do not match. Rebuilding a primary database therefore requires rebuilding and
publishing its reverse-search sidecar.

## Run

```sh
go run ./cmd/dictionary-api \
  -db ./data/dictionary.db \
  -etymology-db ./data/etymology.db \
  -reverse-search-db ./data/reverse-search.db \
  -audio-zip ./data/headword-audio.zip \
  -example-audio-base-url https://media.example.test/audio/examples/ \
  -illustration-url-template 'https://media.example.test/images/{key}.png' \
  -illustration-thumbnail-url-template 'https://media.example.test/thumbs/{key}.webp?width=240' \
  -listen 127.0.0.1:8787 \
  -cors-origins http://localhost:3000
```

Importer environment variables:

```text
DICTIONARY_SOURCE_DB_PATH
DICTIONARY_RUNTIME_DB_PATH
DICTIONARY_SOURCE_VERSION
DICTIONARY_ETYMOLOGY_SOURCE_DB_PATH
DICTIONARY_ETYMOLOGY_SOURCE_VERSION
```

API environment variables:

```text
DICTIONARY_RUNTIME_DB_PATH
DICTIONARY_ETYMOLOGY_DB_PATH
DICTIONARY_REVERSE_SEARCH_DB_PATH
DICTIONARY_AUDIO_ZIP_PATH
DICTIONARY_EXAMPLE_AUDIO_BASE_URL
DICTIONARY_ILLUSTRATION_BASE_URL
DICTIONARY_ILLUSTRATION_URL_TEMPLATE
DICTIONARY_ILLUSTRATION_THUMBNAIL_URL_TEMPLATE
DICTIONARY_LISTEN
DICTIONARY_CORS_ORIGINS
```

Endpoints:

```text
GET /api/v1/health
GET /api/v1/search?q=word&limit=20
GET /api/v1/search?q=中文&limit=32&offset=0&scope=sense,phrase,form
GET /api/v1/entries/{id}
GET /api/v1/enhancements/etymology/terms/{term}
GET /api/v1/enhancements/etymology/articles/{id}
GET /api/v1/media/headword-audio?key=word%23_gb_1
GET /api/v1/media/example-audio?key=example%23_gbs_1
GET /api/v1/media/illustration?key=illustration-key&variant=thumbnail
```

Each search item contains `kind`, `id`, `headword`, `partsOfSpeech`, and
`translationPreview`. Chinese reverse-search items also contain up to three `matches`
with semantic scope, English and Chinese evidence text, and a canonical location used by
the browser for part-of-speech switching and exact navigation. Primary dictionary items use `kind: "dictionary"`; terms found
only in an enabled enhancement use their resource kind. Chinese responses include
`nextOffset` while more results remain in the stable 512-group window; they default to 32
groups and accept a page size of at most 256. English responses retain their 20-result
default and 50-result maximum. Errors contain a stable code,
message, and request id; the same request id is returned in `X-Request-ID`.

Chinese `scope` accepts a non-empty comma-separated subset of
`sense,phrase,form,usage,example`; omission defaults to `sense,phrase,form`. Scope is applied
inside both exact and FTS SQL before the bounded candidate limit. Unknown, repeated query
parameters, empty values, and whitespace-bearing lists return `400 invalid_scope`; English
search rejects the parameter.

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
or HTTPS base URLs or URL templates after validating each opaque key as one path
segment. Templates support `{key}`, `{prefix1}`, `{prefix3}`, and `{prefix5}` in the
URL path. Thumbnail requests fall back to the full illustration source when no
thumbnail template is configured. Leaving a media source unconfigured does not
prevent search and entry lookup from starting.

The etymology sidecar is also optional. Entry lookup reads uncompressed article labels
and previews only. Complete articles are decompressed and integrity-checked after an
article request. Search merges enhancement-only terms after primary dictionary results
and removes terms already represented by the primary dictionary. Association keys remove
display syllable separators and normalize observed typographic apostrophes while retaining
hyphens, internal spaces, trademark marks, and other potentially meaningful punctuation.
Existing runtime dictionaries remain compatible through a bounded set of exact indexed
apostrophe variants.

The optional reverse-search sidecar stores visible bilingual projections separately from
compressed entry payloads. A deduplicated exact-segment B-tree protects complete short
meanings from FTS displacement. The contentless FTS5 index gives each selected semantic
ranking tier an independent 4,096-document limit, with at most three pools. Multi-token
lookup tries the bounded all-token expression first and runs bounded OR retrieval only for
a semantic tier with no usable complete-token result. Go refinement respects Chinese segment
boundaries and mixed ASCII constraints, applies deterministic semantic ranking, and returns
at most 512 entry groups with three evidence records per entry. Query length is capped at
200 characters in the HTTP handler and the store. The sidecar metadata validates schema,
projection, normalizer, document and segment counts, and primary database fingerprint before use.

Schema 3 stores `documents`, `exact_segments`, and the contentless FTS index without the
unused entry-order secondary index. Projection 1.2 indexes structured rich-text segments
once, preserves distinct semantic owners, and separates bilingual token streams. A shared
OpenCC converter normalizes traditional queries and indexed Chinese while the request path
derives all query views from one normalized value.

## Container

From the repository root, prepare `data/dictionary.db`, `data/etymology.db`,
`data/reverse-search.db`, and `data/headword-audio.zip`, then use the Compose definition
in `deploy/server`. It
mounts all files read-only, listens only on the private container network, and publishes
no API host port. Configure an exact HTTPS frontend origin before starting the service. The
complete production procedure is in the root [deployment guide](../../DEPLOYMENT.md).

## Verification

From `services/dictionary-api`:

```sh
go test ./...
go test -bench RandomEntryDecode ./internal/server
```

From the repository root:

```sh
npm run reverse-search:benchmark -- -db ../../data/dictionary.db -reverse-search-db ../../data/reverse-search.db
```
