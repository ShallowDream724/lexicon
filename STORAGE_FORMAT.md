# Runtime Storage Format

## Layout

The generated SQLite database owns five compact structures:

```text
schema_migrations     runtime schema compatibility
dictionary_metadata  source, codec, dictionary, and build parameters
entries              search projections plus independently compressed JSON
entry_terms           ordered normalized terms for exact and prefix lookup
term_deletes          one-character deletion signatures for bounded typo lookup
```

`entries`, `entry_terms`, and `term_deletes` use `WITHOUT ROWID`. Search reads only
`headword`, `parts_of_speech`, and `translation_preview`; it never decompresses entry
bodies.
The ordered `(term, entry_id)` primary key supports an indexed bounded range query
without a duplicate secondary index or FTS table. `term_deletes` is ordered by
`(signature, term)`, so a correction probes exact signature ranges and then joins the
existing `(term, entry_id)` key instead of duplicating entry ids or scanning dictionary
text.

Term keys are independent of displayed headwords. Primary keys remove source syllable
separators while preserving punctuation that can change meaning. Enhancement association
also normalizes the finite set of observed typographic apostrophes. The service probes at
most three exact indexed variants for compatibility with runtime databases generated
before apostrophe normalization; it never applies a normalization function across table
rows at request time.

Exact and prefix lookup always runs first. An empty result may use correction only for
one lowercase ASCII word of 3-64 characters. At request time the service generates at
most 127 exact-term candidates and 65 deletion signatures, retains at most 128 entry
ids, and still applies the public result limit. This covers one deletion, insertion,
substitution, or adjacent transposition with bounded index work. Phrases, punctuation,
short words, and longer input skip correction.

Runtime schema version 3 introduces this normalized correction index. Version 2
databases remain usable as benchmark inputs, but the service requires a fresh version
3 database generated from the source.

Each payload is the original UTF-8 JSON byte sequence compressed as an independent
Zstandard frame using one shared trained dictionary. The row stores the original
length and a 32-byte SHA-256 digest. This retains unknown fields, object key order,
whitespace, escapes, and numeric spelling while preserving one-entry random access.

## Production Defaults

New runtime databases use:

```text
SQLite page size       8,192 bytes
Zstandard level        7
trained dictionary    65,536 bytes
```

These values are explicit build-format parameters. The importer records compression
level, requested dictionary capacity, serialized dictionary bytes, implementation
version, and dictionary SHA-256 in `dictionary_metadata`. Changing a parameter creates
a new runtime database; installed databases are not rewritten in place.

## Full-Corpus Measurements

The benchmark used all 40,974 entry bodies, totaling 320,842,023 source bytes. Each
candidate was generated in primary-key order, vacuumed, then sampled with the same
deterministic random query sequence.

| Page | Level | Dictionary | Database | Import | Query p95 | Query + decode p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 KiB | 3 | 64 KiB | 58.54 MiB | 29.09 s | 257.7 us | 283.5 us |
| 4 KiB | 7 | 64 KiB | 51.73 MiB | 31.41 s | 198.9 us | 220.5 us |
| 8 KiB | 3 | 64 KiB | 52.57 MiB | 26.61 s | 170.1 us | 193.1 us |
| **8 KiB** | **7** | **64 KiB** | **46.85 MiB** | **26.23 s** | **165.6 us** | **189.2 us** |
| 16 KiB | 3 | 64 KiB | 49.95 MiB | 26.75 s | 204.8 us | 224.5 us |
| 16 KiB | 7 | 64 KiB | 44.16 MiB | 29.56 s | 209.0 us | 230.4 us |

The 8 KiB / level 7 / 64 KiB candidate is the default because it is close to the
smallest database while producing the best measured p95 lookup latency. A
16 KiB / level 7 build is available for space-prioritized distribution, saving
2.69 MiB with a higher measured query tail.

On the same 40,974-entry corpus, the version 3 correction index contains 220,328
unique `(signature, term)` rows and occupies 4.60 MiB. The complete default database
is 51.45 MiB. A 100-request loopback HTTP sample measured exact search at 7.9 ms p95
and one-edit correction at 10.3 ms p95; both query plans use only the corresponding
primary keys.

A 128 KiB dictionary did not provide a stable advantage: at 4 KiB / level 7 it
produced 51.16 MiB with 302.4 us query p95. Levels 15 and 19 reached 50.21 MiB at
4 KiB, while import time rose to roughly 4.5-5 minutes. Their marginal reduction
does not justify the approximately ninefold build time for the default artifact.

Windows timer resolution can report zero for individual short decode samples, so
selection uses p95 query and combined query-plus-decode measurements rather than
the isolated decode p50.

## Format Screening

Early full-corpus screening established the storage boundary:

| Encoding | Compressed payload bytes |
| --- | ---: |
| Independent zstd level 3 | 50,424,606 |
| Independent zstd level 7 | 45,809,258 |
| zstd level 3 with a 64 KiB trained dictionary | 28,784,301 |
| gzip level 6 | 46,849,178 |
| MessagePack then zstd level 3 | 51,513,952 |
| CBOR then zstd level 3 | 50,248,497 |

MessagePack and CBOR add a decode layer, compress no better than source JSON, and
lose exact source-byte preservation. One-megabyte compressed chunks reduce payload
bytes further but force unrelated-entry decompression, a second offset index, block
caching, and block-wide rewrites. Neither tradeoff fits low-latency random lookup.

## Integrity And Compatibility

Dictionary training samples entries deterministically in primary-key order. Import
verifies valid source JSON before compression and writes through a temporary database
followed by an atomic rename. The service validates runtime schema version, codec,
uncompressed length, SHA-256, and decoded JSON before returning an entry.

The shared dictionary is part of the database format and is stored in the same file.
A missing or mismatched dictionary therefore cannot silently turn the payload table
into an external dependency.

## Pronunciation Archive

Headword pronunciation remains in its original ZIP container. The measured archive is
1,135,490,706 bytes and contains 256,026 MP3 members totaling 1,177,468,953 bytes when
extracted. Extraction would save no runtime work, increase storage by about 42 MiB,
and create a large filesystem metadata burden. The API therefore reads the central
directory once at startup and streams only the selected member. The archive is mounted
read-only and versioned independently from the runtime database.

With the complete archive and the 51.45 MiB runtime database, a local Windows probe
reached the health endpoint in about 1.2 seconds. The Go process used approximately
125 MiB of working-set memory and 156 MiB of private memory after indexing. A sampled
8,377-byte MP3 response completed in 3.6 ms. Measurements include the Go API only.

## Enhancement Sidecars

Supplementary datasets use separate project-owned SQLite files so they can be added,
replaced, or removed without rebuilding the primary dictionary. The etymology sidecar
contains:

```text
etymology_schema_migrations  sidecar compatibility
etymology_metadata           source and codec settings
etymology_terms              normalized exact/prefix projection
etymology_articles           summary fields plus compressed article payload
etymology_term_deletes       bounded one-edit correction signatures
```

Article labels and 512-character previews remain uncompressed. Semantic emphasis uses
five bytes per marked range: little-endian 16-bit start and end offsets followed by a
validated bit mask. The API reconstructs preview runs from those ranges, so opening an
entry card retains source emphasis without duplicating preview text or decoding a
complete article. Each complete structured article is an independent Zstandard frame
with a shared trained dictionary, an explicit decoded-size limit of 16 MiB, and a
32-byte SHA-256 digest. The decoder receives a destination capped at the validated row
length, so a malformed frame cannot force an unbounded output allocation before the
length check. Small fixture corpora that cannot support meaningful dictionary training
use ordinary independent Zstandard frames; a training failure on a production-sized
corpus aborts the import.

The current full import contains 46,773 searchable terms, 51,716 articles, and 317,082
unique deletion signatures in a 45,400,064-byte SQLite file using 8 KiB pages, level 7,
and a 65,677-byte serialized trained dictionary. Semantic preview ranges occupy 934,495
bytes across the complete corpus. One valid source article omitted from
the source index is retained under its own headword instead of being silently dropped.

The sidecar is an optional runtime dependency and a required deployment asset only when
the corresponding enhancement is enabled. It remains outside the application image,
Git history, Service Worker cache, and primary runtime database.

## Reproducing The Matrix

The benchmark command accepts either an original source database or an existing
runtime database as its corpus source. Run it from the repository root and pass
explicit output and candidate parameters:

```bash
npm run dictionary:benchmark -- \
  -runtime-source ../../data/dictionary.db \
  -output ../../work/storage-benchmark \
  -page-sizes 4096,8192,16384 \
  -levels 3,7 \
  -dictionary-sizes 65536 \
  -query-samples 1000
```

Paths after `--` are relative to `services/dictionary-api` because the root script
uses Go's `-C` option. Each run writes machine-readable JSON and CSV results.
