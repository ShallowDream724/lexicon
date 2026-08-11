# Semantic Chinese Search

## Purpose

Semantic search supplements Chinese reverse lookup for explicit Chinese expressions and
short descriptions whose wording does not occur verbatim in the dictionary. It retrieves
visible, locatable dictionary evidence; it does not replace lexical lookup.

Suggestions while typing remain lexical. English spelling, whole-word and inflected-form
lookup, phrase lookup, grammar-pattern lookup, prefix lookup, typo correction, and
single-character Chinese lookup are lexical operations. English input never calls the
embedding provider and is not treated as free-form semantic search.

For an English query, complete whole-word, inflected-form, phrase, and grammar-pattern
matches are preserved as complete units. Only when no complete match exists does the
lexical resolver use the longest matching phrase plus uncovered content words, with at
most one edit correction. This keeps established dictionary expressions intact.

Only visible Chinese text projected by `packages/dictionary-search` is embedded. Storage
scopes are `sense`, `phrase`, `form`, `example`, and `resource`. Guidance and qualifiers
inherit their owner's scope; complete grammar, synonym, collocation, and language-bank
cards use `resource`. Opaque adapter data, English text, headwords, source payloads, and
etymology articles are excluded. Etymology therefore does not participate in semantic
search.

The interface exposes four filters:

| Filter | Storage scopes |
| --- | --- |
| 词义 | `sense`, `form` |
| 短语 | `phrase` |
| 例句 | `example` |
| 扩展资料 | `resource` |

The default selection is 词义 and 短语.

## Runtime Flow

An explicit Chinese submission with at least two Han characters may request `mode=hybrid`.
The request combines bounded lexical reverse search with one compatible query embedding,
an in-memory int8 vector scan, candidate projection, lexical protection, evidence ranking,
and stable pagination. Suggestion requests never set `mode=hybrid`.

The API starts its three-second budget when it invokes the external embedding provider.
Parsing and local lexical retrieval do not consume that budget. Provider timeout, invalid
provider output, disabled configuration, or capacity exhaustion returns the complete lexical
result without failing the search. The interface may state, without treating it as an error,
that this request used local results.

Normalized query vectors and complete semantic pages use bounded in-memory caches. Scope
changes, pagination, and repeated queries reuse the same query vector. An optional SQLite
cache persists vectors across restarts, storing an HMAC-SHA-256 key and the vector rather
than query text. Its namespace includes the model key, dimensions, query template, and
provider options. At 10,000 queries, the persistent cache uses approximately 12-16 MiB.
Mounting its configured path outside the container preserves it across container rebuilds.

## Bundled Contract

| Field | Value |
| --- | --- |
| Provider model | `Qwen/Qwen3-Embedding-4B` |
| Stable model key | `qwen3-embedding-4b-1024-v1` |
| Dimensions | 1,024 |
| Query template | `Instruct: Given a Chinese expression or description, retrieve dictionary meanings and phrases that answer it\nQuery: {query}` |
| Normalization | L2 |
| Runtime quantization | symmetric int8, scale 127 |
| Unique vectors | 181,883 |
| Search documents | 197,340 |
| Sidecar schema / projection | `5` / `2.2` |
| Sidecar size | 259,973,120 bytes |
| SHA-256 | `f76c97820fc44485696a19a2829bb6be4f0d298b9fc3524dabef5b26b2915033` |
| Minimum cosine score | `0.590489181` |
| Resident int8 matrix | approximately 177.6 MiB |

The matching reverse-search sidecar is schema `9` / projection `2.2`, with
197,340 documents, 361,278 exact segments, 16,861 headword forms, 55,975 headword
terms, and 117,214 English terms. Its scope counts are: `sense` 84,821, `phrase`
12,423, `form` 5, `example` 92,016, and `resource` 8,075. Its size is 102,408,192
bytes and its SHA-256 is
`9677b91a2d2f4fc6dc825a989ea2e157a77f2e19646aeb1b3a60a8e2dcd39630`.

Semantic metadata pins the primary-database and reverse-sidecar SHA-256 values, projection
versions, model key, dimensions, query template, provider options, scope set, and corpus
fingerprint. The API rejects an incompatible combination at startup. Model names are provider
routing values; the model key identifies the compatible embedding space.

## Build The Sidecar

The builder accepts OpenAI-compatible embeddings endpoints that return one vector per input.
Configure credentials in the process environment and run:

```bash
npm run semantic-search:build
```

The command writes resumable float16 build state under `work/semantic-search`, validates the
complete sidecar, and atomically replaces `data/semantic-search.db`. A matching checkpoint
resumes unfinished work. Changed corpus content, model, dimensions, template, or provider
options changes the build fingerprint and requires a separate output directory or
`--rebuild`.

`--reuse-vectors-from` validates the document embedding contract and reuses vectors by exact
normalized embedding text. Added, removed, and reordered documents reuse the intersection;
only genuinely new texts require provider requests. Model key, dimensions, normalization,
quantization, or document provider-option changes make vectors incompatible.

## Runtime Configuration

```text
DICTIONARY_SEMANTIC_SEARCH_DB_PATH=/path/to/semantic-search.db
DICTIONARY_SEMANTIC_BASE_URL=https://provider.example/v1
DICTIONARY_SEMANTIC_API_KEY=replace-with-your-key
DICTIONARY_SEMANTIC_MODEL=Qwen/Qwen3-Embedding-4B
DICTIONARY_SEMANTIC_MODEL_KEY=qwen3-embedding-4b-1024-v1
DICTIONARY_SEMANTIC_TIMEOUT=3s
DICTIONARY_SEMANTIC_CACHE=128
DICTIONARY_SEMANTIC_PERSISTENT_CACHE=true
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_PATH=/var/cache/lexicon/semantic-query-vectors.db
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_KEY=replace-with-at-least-32-private-bytes
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_MAX_ENTRIES=10000
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_TTL=720h
```

The bundled sidecar is optional. Without a compatible endpoint and credential, Chinese search
continues through the lexical reverse-search sidecar. Changing the embedding space,
dimensions, query template, or task options requires a rebuilt sidecar and model key.

## Versioning

`dictionary.db`, `reverse-search.db`, and `semantic-search.db` are a single compatible
release unit. The assets remain outside Git and container images, and their release filenames,
sizes, and SHA-256 values are pinned in `runtime-assets.json`.

Evaluation design, current quality gates, and historical results are documented in
[QUALITY_EVALUATION.md](QUALITY_EVALUATION.md).
