# Runtime Storage Format

## Primary Database Layout

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
followed by an atomic rename. Migration rows use the fixed introduction timestamp of
their schema version, so identical full imports produce byte-identical SQLite files.
The service validates runtime schema version, codec,
uncompressed length, SHA-256, and decoded JSON before returning an entry.

The shared dictionary is part of the database format and is stored in the same file.
A missing or mismatched dictionary therefore cannot silently turn the payload table
into an external dependency.

## Chinese Reverse-Search Sidecar

Chinese lookup is a derived, project-owned SQLite sidecar with five structures:

```text
metadata       schema, normalizer, projection, source, count, and primary fingerprint
documents      display evidence, grouping identity, weight, and canonical location
exact_segments deduplicated normalized segments for complete-match lookup
entry_headword_forms deduplicated entry-level surface forms used by evidence highlighting
documents_fts  contentless FTS5 candidate index using detail=none
```

The sidecar is generated from validated `CanonicalEntry` values through the shared
`SearchDocument` projector. The current schema 5 / projection 1.4 build contains 188,851
documents, 347,486 exact segments, and 16,857 headword forms from 40,974 entries in a
72,228,864-byte file.
Repeating the same projection and import produced the byte-identical SHA-256
`6a5288a931c1818fa064e030dc6476b72724717444ee751f52e26fc38e73fab0`.

Headword forms are projected once per canonical entry. Explicit canonical inflections
carry irregular forms such as `think` to `thought`. A build-only lemmatizer supplements them
with forms that actually occur in projected English evidence, such as `twist` to `twisted`,
and only when the owning same-headword entry path supplies a compatible part of speech.
Entry-level alternative spellings are accepted as lexical surfaces. Sense wording,
constructions, derivatives, differently named nested entries, and unobserved guesses are
excluded. The API fetches forms for one result window with a single bounded query, so evidence
rendering never performs per-entry lookups or request-time morphology.

Normalization applies Unicode NFKC, OpenCC traditional-to-simplified conversion, and
collapsed punctuation and whitespace boundaries. One process-wide, race-safe OpenCC
converter is reused by every request; normalized text, runes, segments, and FTS tokens
are derived once per query. The FTS payload contains ASCII-encoded CJK unigrams and
bigrams, avoiding dependence on a platform-specific SQLite tokenizer. Each normalized
query segment uses bigrams when possible and retains an explicit unigram when that
segment contains one character. Mixed ASCII and numeric constraints join the scope
predicate before the candidate limit and are rechecked during bounded refinement. A
query with one Chinese character excludes example-only matches.

Single-segment queries also probe the `exact_segments` primary key, preserving complete
short meanings even when frequent terms fill the FTS window. Scope filters are applied in
both exact and FTS SQL before their candidate limits, so optional usage and example
searches do not displace default definition, phrase, and form candidates. Each semantic
ranking tier retrieves at most 4,096 documents, with no more than three pools for one
expression. Multi-token lookup tries the all-token expression independently per semantic
tier; bounded OR retrieval runs only for a tier without a usable complete-token result.
The selected candidates then receive bounded Go refinement.

Candidate retrieval remains separate from final ranking. Ranking first separates complete
segments, grammatical extensions, continuous boundary matches, and partial matches into hard
tiers. Within complete matches, match quality, protected candidate pool, semantic scope
(sense, then phrase or form, usage, and example), distinct corroborating Chinese evidence, and
bounded score determine order. Within partial matches, textual relevance precedes semantic scope;
query-leading coverage improves suffix and noise cases. Duplicate identical Chinese evidence does
not increase corroboration. Parenthetical-only matches are demoted. Long partial matches require
a contiguous run covering about half the query, and lightweight polarity checking rejects
misleading negated fallbacks. Mixed Chinese and ASCII or numeric queries retain every ASCII or
numeric constraint. Scoring never joins text across punctuation or whitespace boundaries.
Results are grouped with deterministic ties into a stable window of at most 512 entries and at
most eight evidence records per entry.
The HTTP endpoint returns 32 groups by default, accepts pages of at most 256, and exposes
`nextOffset` for progressive 32, 64, 128, 256, and 512 cumulative result counts. Both the
HTTP endpoint and the store reject queries longer than 200 characters.

The sidecar metadata stores the SHA-256 of its exact primary runtime database. The API
checks that fingerprint before accepting the index, so canonical paths and entry content
cannot silently drift. The primary database and reverse-search sidecar must be released
and replaced as one pair; an enabled semantic sidecar is a third member of that
compatibility unit. Omitting the reverse-search sidecar makes Chinese queries return
`503 reverse_search_unavailable` while leaving English exact, prefix, correction, entry, and
enhancement lookup available.

Representative 100-iteration samples with a result limit of 32 measured:

| Query | p50 | p95 |
| --- | ---: | ---: |
| `放弃` | 1.556 ms | 2.508 ms |
| `注入` | 0.581 ms | 1.291 ms |
| `词汇` | 0.988 ms | 1.020 ms |
| `要` | 34.891 ms | 41.999 ms |
| `火山矽肺病` | 1.008 ms | 1.581 ms |
| `受不了` | 1.526 ms | 2.416 ms |
| `完全受某人控制` | 0.999 ms | 1.513 ms |

Run the same bounded benchmark from the repository root:

```bash
npm run reverse-search:benchmark -- \
  -db ../../data/dictionary.db \
  -reverse-search-db ../../data/reverse-search.db \
  -iterations 100 \
  -limit 32
```

Paths after `--` are relative to `services/dictionary-api` because the root command uses
Go's `-C` option.

## Semantic Search Sidecar

Semantic Chinese lookup is derived from the visible `SearchDocument` projection and stored
in a second read-only SQLite sidecar:

```text
metadata       database fingerprints, model contract, projection, counts, and build identity
texts          one normalized scope mask per unique visible Chinese text
documents      source-neutral evidence and canonical locations keyed by text id
vector_blocks  contiguous symmetric-int8 vector blocks
```

The current schema 2 / projection 1.1 build groups 188,851 documents into 178,382 unique text vectors with
1,024 dimensions. It covers 2,139,356 Chinese characters and occupies 252,542,976 bytes.
Its SHA-256 is
`c17d6b478e0ab0dfa5868abf32209b84dab6b1c82abacfac8ae5ccc24fe4273b`.
Metadata pins the primary runtime SHA-256, reverse-search SHA-256, corpus fingerprint,
source projection 1.4, semantic projection 1.1, model key
`qwen3-embedding-4b-1024-v1`, query template, provider options, and every vector-format
parameter. The API rejects an incompatible combination before serving requests.

Document vectors are L2-normalized during import, cached as float16 only in ignored build
state, then quantized to `round(clamp(value * 127, -127, 127))`. The runtime loads the
resulting 174.2 MiB int8 matrix and compact scope masks once. Each uncached query is
normalized and quantized in the same way, scanned by at most four workers, and reduced
through bounded per-worker heaps. Depending on the requested page, 192 to 4,096 text ids
reach SQLite evidence projection. No approximate-nearest-neighbor graph, native extension,
or runtime model is required.

The released model was selected on a deterministic same-corpus comparison. Qwen3 Embedding
4B reached 88.1% Hit@1, 100% Hit@3, and 0.938 MRR on that selection suite, ahead of the
tested Qwen3 8B, text-embedding-3-large, compact Qwen, BGE-M3, and
text-embedding-3-small routes. On the full 67-query suite, float16 retrieval reached 55.2%
Hit@1, 100% Recall@32, and 0.660 MRR. The exact runtime int8 path reached 58.2% Hit@1,
100% Recall@32, and 0.672 MRR.

The production build used 1,677,023 document input tokens and 2,000 quality-evaluation
tokens. With the measured provider's 4x input multiplier, total recorded usage was
6,716,092 weighted units. One quality query averaged 29.85 input tokens including its
instruction, or 119.4 weighted units at the same multiplier. A resumable checkpoint and
pre-request reservations keep rebuilds and provider quota bounded.

Loopback end-to-end probes measured 0.66-1.42 seconds for a first provider-backed query. The
quality-v3 development run measured 125 ms at p50 and 163 ms at p95 for complete warm hybrid
requests over the stable 512-entry fusion window. The semantic-enabled Windows API process
used 385.5 MiB of working-set memory and 421.2 MiB of private memory after real queries;
these figures also include the pronunciation ZIP index and normal Go/SQLite state.

The dense rank is not returned directly. The API protects full-boundary lexical evidence,
then compares each entry's semantic evidence profile lexicographically: the strongest match
wins, another match breaks ties only inside the 0.005 similarity band, and evidence counts are
never summed. Query-vector and page LRUs avoid repeat provider calls; provider errors return
the lexical page.

An optional writable SQLite cache preserves normalized query vectors across process and
container restarts. Its key is HMAC-SHA-256 over the query plus the complete embedding
contract; query plaintext is never stored. Float32 vectors use 4,096 bytes each at 1,024
dimensions. The default 10,000-row TTL/LRU bound occupies roughly 42-50 MiB including SQLite
indexes and page overhead. Cache failures disable only persistence and never the lexical or
semantic request path. See [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) for the build command,
runtime contract, model comparison, cache settings, and configuration.

## Pronunciation Archive

Headword pronunciation remains in its original ZIP container. The measured source
archive is 1,135,490,706 bytes and contains 128,010 usable MP3 assets totaling
1,143,628,003 bytes. It also contains 128,013 macOS metadata entries, which the indexer
ignores. Extraction would save no runtime work and would create a large filesystem
metadata burden. The API therefore reads the central directory once at startup and
streams only the selected member. The archive is mounted read-only and versioned
alongside the runtime databases through `runtime-assets.json`.

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
