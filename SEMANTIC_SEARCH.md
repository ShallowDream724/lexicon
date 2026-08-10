# Semantic Chinese Search

## Purpose

Lexicon's semantic index extends Chinese reverse lookup from literal matching to intent
matching. A query such as `能吸收水汽、保持干燥的颗粒状硅胶` can retrieve `silica gel`
even when the query is not a stored translation verbatim.

The feature has one deliberately narrow responsibility: retrieve visible dictionary
meanings and phrases from a Chinese expression or description. English spelling,
prefix lookup, typo correction, and one-character Chinese lookup remain local lexical
operations. Suggestions shown while typing also remain lexical.

Only canonical Chinese text already projected by `packages/dictionary-search` is embedded.
The current corpus covers `sense`, `phrase`, `form`, `usage`, and `example` scopes; the
bundled source currently emits no independent form documents. Opaque adapter data,
headwords, raw source payloads, and etymology articles do not enter this index. This keeps
results navigable and lets a new adapter receive semantic coverage by mapping content to
the existing canonical model.

## Runtime Flow

```text
Explicit Chinese query with at least two Han characters
        |
        +---- bounded lexical reverse search (local SQLite)
        |
        +---- one OpenAI-compatible query embedding request
                  |
                  v
             int8 dense scan (resident vectors)
                  |
                  v
             semantic candidate projection
        |
        v
Exact-match protection + reciprocal-rank fusion + stable pagination
        |
        v
Search evidence with canonical entry locations
```

The browser opts into `mode=hybrid` only after an explicit submit. The 180 ms suggestion
request never includes that mode, so typing does not spend embedding quota. Queries with
fewer than two Han characters, English queries, and queries longer than 200 characters do
not call the embedding provider.

The API keeps separate bounded LRU caches for normalized query vectors and complete
semantic pages. Scope changes and continuation pages reuse the vector. Concurrent identical
queries share one provider request. If the provider times out or returns an invalid response,
the request falls back to the complete lexical result page.

## Bundled Contract

The released sidecar is built with:

| Field | Value |
| --- | --- |
| Provider model | `Qwen/Qwen3-Embedding-4B` |
| Stable model key | `qwen3-embedding-4b-1024-v1` |
| Dimensions | 1,024 |
| Query template | `Instruct: Given a Chinese expression or description, retrieve dictionary meanings and phrases that answer it\nQuery: {query}` |
| Normalization | L2 |
| Runtime quantization | symmetric int8, scale 127 |
| Unique vectors | 178,382 |
| Search documents | 188,851 |
| Chinese characters | 2,139,356 |
| Sidecar size | 251,174,912 bytes |
| SHA-256 | `4bb445efbc8ddce2eaf02a386b6531e514544a5c7f65beb1bbe31cfec0d3ad40` |

The sidecar metadata pins the exact primary database SHA-256, reverse-search sidecar
SHA-256, projection versions, model key, dimensions, query template, provider options,
scope set, and corpus fingerprint. The API rejects a mismatched combination at startup.
Model names are provider routing values; the model key is the stable compatibility identity
shared by document and query vectors.

## Model Selection

Candidates were compared on the same deterministic dictionary sample and intent suite.
The table reports retrieval quality before lexical fusion, so it measures the embedding
model rather than existing exact-match rules.

| Model | Hit@1 | Hit@3 | MRR | Estimated full-corpus weighted input |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 Embedding 4B | 88.1% | 100% | 0.938 | 6.50M |
| text-embedding-3-large | 86.6% | 100% | 0.928 | 26.05M |
| Qwen3 Embedding 8B | 86.6% | 98.5% | 0.924 | 13.00M |
| cf/qwen-embedding-0.6b | 80.6% | 98.5% | 0.893 | 1.74M |
| cf/bge-m3 | 80.6% | 92.5% | 0.866 | 1.74M |
| text-embedding-3-small | 71.6% | 91.0% | 0.804 | 13.03M |

Qwen3 Embedding 4B produced the strongest measured ranking while remaining well inside the
build budget. The 8B model and text-embedding-3-large cost more on the tested provider and
did not improve the sample. Smaller models remain valid choices for a custom build where
quota matters more than the bundled quality baseline.

The full 67-query corpus evaluation compared the float16 build cache with the exact runtime
int8 scoring path:

| Representation | Hit@1 | Recall@32 | MRR |
| --- | ---: | ---: | ---: |
| Float16 | 55.2% | 100% | 0.660 |
| Runtime int8 | 58.2% | 100% | 0.672 |

Int8 introduced no measured quality loss and reduces resident vector memory to about
174 MiB. The released SQLite file also stores evidence and metadata; it is not all loaded
into memory.

The same 67 intents were also sent through the final HTTP hybrid path. Against the original
conservative headword allowlists, the fused results reached 49.3% Hit@1, 67.2% Hit@3,
95.5% Recall@32, and 0.615 MRR. Manual review found that all three nominal misses returned
valid alternatives absent from those finite allowlists: `can`/`enough` for `受不了`,
`go`/`nicety`/`puzzle` for a detail worth examining, and `temper`/`compulsive` for losing
self-control in an argument. The suite remains conservative instead of rewriting labels to
inflate the score.

## Build The Sidecar

The builder supports every OpenAI-compatible embeddings endpoint that returns one vector
per input. Configure the endpoint and credential in the current process, then run the
recommended full build:

```bash
export OPENAI_BASE_URL=https://provider.example/v1
export OPENAI_API_KEY=replace-with-your-key
npm run semantic-search:build
```

The command writes resumable float16 build state under `work/semantic-search`, evaluates
the two quality suites, and atomically replaces `data/semantic-search.db` only after the
complete sidecar is valid. A matching checkpoint resumes without paying for completed
texts. A changed corpus, model, dimensions, template, or provider options changes the build
fingerprint and requires a separate output directory or an explicit `--rebuild`.

Quota systems that price input through a multiplier can enforce a pre-request budget:

```bash
npm run semantic-search:build -- \
  --input-multiplier 4 \
  --max-weighted-units 50000000
```

The builder runs a small preflight, records confirmed provider usage, reserves a
tokenizer-independent upper bound before every request, and stops before dispatch when the
configured weighted limit would be exceeded.

Use the raw entry point for another model or provider contract:

```bash
npm run semantic-search:build:custom -- \
  --output-dir work/semantic-search/custom-model \
  --sidecar data/semantic-search.db \
  --base-url https://provider.example/v1 \
  --provider-model provider/model-name \
  --model-key project-owned-compatible-key-v1 \
  --dimensions 1024 \
  --document-extra-json '{"input_type":"document"}' \
  --query-extra-json '{"input_type":"query"}' \
  --quality-file tools/semantic-search/quality/default.json \
  --quality-file tools/semantic-search/quality/extended.json
```

`model`, `input`, `encoding_format`, and `dimensions` cannot be overridden through extra
JSON. A provider-specific document/query distinction is stored in the sidecar and replayed
at runtime, preventing the query contract from drifting after publication.

## Runtime Configuration

The bundled sidecar is optional. Without a compatible endpoint and credential, Chinese
search continues through the lexical reverse-search sidecar.

```text
DICTIONARY_SEMANTIC_SEARCH_DB_PATH=/path/to/semantic-search.db
DICTIONARY_SEMANTIC_BASE_URL=https://provider.example/v1
DICTIONARY_SEMANTIC_API_KEY=replace-with-your-key
DICTIONARY_SEMANTIC_MODEL=Qwen/Qwen3-Embedding-4B
DICTIONARY_SEMANTIC_MODEL_KEY=qwen3-embedding-4b-1024-v1
DICTIONARY_SEMANTIC_TIMEOUT=5s
DICTIONARY_SEMANTIC_CACHE=128
```

Changing only the runtime model name is valid when two provider routes return the same
embedding space. Changing the embedding space, dimensions, query template, or task options
requires rebuilding the sidecar with a new model key.

## Measured Usage

The released full build used 1,677,023 document input tokens across 1,394 requests and
2,000 evaluation input tokens in one request. At the tested provider's 4x input multiplier,
that is 6,716,092 weighted units in total.

Across the 67-query quality suite, one query averaged 29.85 input tokens including the
instruction, or about 119.4 weighted units at 4x. Real loopback requests observed roughly
0.66-1.42 seconds for an uncached provider call. Repeated queries and pagination reuse the
cached vector; observed complete warm hybrid requests took roughly 20-75 ms without another
provider charge. After real queries, the measured Windows API process used 385.5 MiB of
working-set memory and 421.2 MiB of private memory, including the pronunciation index and
semantic matrix.

Provider latency and quota units are deployment-specific. Keep credentials in environment
configuration, apply public request-rate controls at the reverse proxy, and choose a cache
capacity appropriate for the expected query diversity.

## Versioning

The semantic sidecar is derived from both `dictionary.db` and `reverse-search.db`; publish
and replace all three databases as one compatible unit. A content update rebuilds the
canonical reverse projection first, then the semantic sidecar. The released file remains
outside Git and container images and is pinned through `runtime-assets.json`.

A future semantic feature should add a separate projection and model key when its retrieval
unit changes. English concept search, example-to-example similarity, study recommendations,
and translated etymology are distinct products of the canonical data; combining them into
the Chinese reverse-search vector space would weaken versioning and relevance.
