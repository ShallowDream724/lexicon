# Self-Hosted Deployment

## Reference Topology

The included public reference layout runs entirely on one server:

```text
Browser
   |
   v
TLS reverse proxy on ports 80 and 443
   +-- /api/v1/* ------> Go dictionary API
   +-- all other paths -> standalone Next.js application

Go dictionary API
   +-- primary runtime SQLite, read-only
   +-- Chinese reverse-search SQLite, read-only
   +-- semantic-search SQLite, read-only
   +-- etymology sidecar SQLite, read-only
   +-- pronunciation ZIP, read-only
   +-- bounded query-vector cache, writable
   +-- optional outbound query-embedding provider
```

The browser calls a same-origin `/api/v1` path. The repository's Compose file uses Caddy to
keep application containers on a private network, obtain TLS certificates when a domain
is configured, and expose only HTTP and HTTPS. This is a public reference topology; an
existing reverse proxy can provide the same routing without running the included gateway.
The bundled Caddy gateway is not part of installations already routed through Nginx Proxy
Manager; those deployments attach the web and API services to their existing private Docker
network and keep that site-specific Compose file outside this repository.
History, favorites, and notes remain in the browser's IndexedDB; the server stores no
personal records.

## Capacity

The measured production assets are:

| Asset | Stored size | Runtime treatment |
| --- | ---: | --- |
| Runtime SQLite schema v3 | 53,952,512 bytes | opened read-only |
| Reverse-search sidecar schema v5 | 72,228,864 bytes | opened read-only; scoped exact lookup, bounded FTS, grouped refinement, and batched headword forms |
| Semantic-search sidecar schema v2 | 252,542,976 bytes | 178,382 int8 vectors loaded once; evidence read from SQLite on demand |
| Etymology sidecar schema v3 | 45,400,064 bytes | opened read-only; articles decoded on demand |
| Headword pronunciation ZIP | 1,135,490,706 bytes | indexed once, streamed without extraction |
| Usable headword MP3 assets | 128,010 files / 1,143,628,003 bytes | not extracted |

The source pronunciation archive contains 128,010 usable MP3 assets and 128,013 macOS
metadata entries. The API ignores those metadata entries, indexes the usable MP3 keys,
and avoids creating hundreds of thousands of filesystem entries. Entry payloads already
use independent Zstandard frames with a shared dictionary; recompressing the database
as one archive would lose random access.

A full-archive probe without semantic search measured API readiness in about 1.2 seconds,
a 125 MiB working set, and 156 MiB of private memory. After loading semantic search and
serving real queries, the measured Windows API process used 385.5 MiB of working-set memory
and 421.2 MiB of private memory. The 174 MiB resident int8 matrix accounts for most of the
increase. A sampled 8,377-byte MP3 streamed in 3.6 ms. These numbers exclude the Next.js and
Caddy containers and serve as a sizing reference, not a cross-platform guarantee.

The current PWA application shell is about 1.07 MiB across 26 precache entries. It is a
browser-side budget and does not change server asset capacity. Entry JSON, audio, images,
SQLite, and ZIP files are excluded from the PWA cache.

Reserve 2 GiB of memory so the server can run the stack and rebuild the Next.js image
without pressure. Five GiB of free disk is the practical minimum for assets, images,
and one normal rebuild; ten GiB leaves room for build cache and atomic asset replacement.

## Requirements

- A Linux server with Docker Engine and Docker Compose v2.
- Ports 80 and 443 reachable when automatic HTTPS is used.
- A domain with an A or AAAA record pointing to the server, or plain HTTP by IP for a
  private deployment.
- The five released runtime assets downloaded through the project manifest.

## Prepare Assets

After cloning the repository, download and verify the complete runtime asset set:

```sh
npm ci
npm run data:download
```

The command creates the ignored `data` directory with this layout:

```text
data/
  dictionary.db
  etymology.db
  reverse-search.db
  semantic-search.db
  headword-audio.zip
```

All four runtime databases pass schema and integrity validation before release. The
reverse-search sidecar pins the exact primary database SHA-256; the semantic sidecar pins
both of those database fingerprints and its embedding contract. The audio
archive passes its pinned size and SHA-256 checks and retains its original ZIP body.
Run `npm run data:verify` after transferring the asset set through a mirror or backup. The
included Compose expects all five files. A custom Compose may omit the reverse-search
environment variable and mount when Chinese lookup is not needed. It may independently omit
the semantic, etymology, or audio configuration. Semantic search also stays disabled until
an embedding endpoint and credential are configured; the complete lexical Chinese path,
English search, and entry lookup continue without it.

Make all five files readable by the Docker daemon and keep them immutable during normal
operation. Content assets never enter an image or Git commit.

## Configure

Create the deployment environment file:

```sh
cp deploy/server/.env.example deploy/server/.env
```

For a domain with automatic HTTPS:

```text
SITE_ADDRESS=dict.example.com
DICTIONARY_CORS_ORIGINS=https://dict.example.com
```

For plain HTTP on the server's IP or local network:

```text
SITE_ADDRESS=:80
DICTIONARY_CORS_ORIGINS=http://server-ip
```

`LEXICON_DATA_DIR` is resolved from `deploy/server/compose.yaml`; the default
`../../data` points to the repository's ignored `data` directory. Example-audio and
illustration sources are optional and accept only HTTP or HTTPS URLs. Illustration
URL templates can use `{key}`, `{prefix1}`, `{prefix3}`, and `{prefix5}` path tokens;
a separate thumbnail template avoids loading full images in compact resource cards.

To enable the released semantic index, set the OpenAI-compatible endpoint and credential in
the private environment file. Keep the bundled model and model-key defaults together:

```text
DICTIONARY_SEMANTIC_BASE_URL=https://provider.example/v1
DICTIONARY_SEMANTIC_API_KEY=replace-with-your-key
DICTIONARY_SEMANTIC_MODEL=Qwen/Qwen3-Embedding-4B
DICTIONARY_SEMANTIC_MODEL_KEY=qwen3-embedding-4b-1024-v1
DICTIONARY_SEMANTIC_TIMEOUT=3s
DICTIONARY_SEMANTIC_CACHE=128
DICTIONARY_SEMANTIC_PERSISTENT_CACHE=true
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_KEY=replace-with-at-least-32-private-bytes
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_MAX_ENTRIES=10000
DICTIONARY_SEMANTIC_PERSISTENT_CACHE_TTL=720h
```

The base URL and credential are never included in the image, runtime manifest, or Git
history. Leaving either empty disables only semantic retrieval. A different embedding space
requires rebuilding `semantic-search.db` and assigning a new model key; see
[SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md).

The three-second budget starts when the API dispatches the provider request. A timeout,
rate limit, or malformed response returns the complete local lexical page. The reference
Compose keeps the query-vector cache in its own writable volume while every content asset
remains read-only. The cache stores HMAC keys instead of query text, survives container
restarts, expires entries after 30 days, and evicts least-recently-used rows above 10,000.
That default bound is approximately 42-50 MiB. Generate the private cache key with
`openssl rand -hex 32`; set `DICTIONARY_SEMANTIC_PERSISTENT_CACHE=false` to opt out. A
one-shot init service gives the non-root API user ownership of the cache volume before the
API starts.

## Start

Build and start all three services:

```sh
docker compose \
  --env-file deploy/server/.env \
  -f deploy/server/compose.yaml \
  up -d --build
```

Check container state and the public health route:

```sh
docker compose \
  --env-file deploy/server/.env \
  -f deploy/server/compose.yaml \
  ps
curl https://dict.example.com/api/v1/health
```

When `SITE_ADDRESS=:80`, use the corresponding `http://` server address. The API
validates the primary database and every configured optional asset before it begins
serving traffic. A configured etymology path that has not been populated yet is logged
and disabled. When the reverse-search sidecar is absent, Chinese queries return
`503 reverse_search_unavailable`; a present but invalid sidecar or a primary fingerprint
mismatch stops startup. Semantic search is enabled only when its sidecar, compatible runtime
model settings, endpoint, and credential are all present. A configured but incompatible
semantic sidecar stops startup; request-time provider failures fall back to lexical Chinese
results.

## Existing Reverse Proxy

When TLS and public routing are already handled by another reverse proxy, use a private
Compose outside the public checkout and run only the
web and dictionary API services on its Docker network. Route `/api/v1/` to the API on
port 8787 and every other path to the web application on port 3000. Keep the network,
hostnames, credentials, and media origins in the server's private Compose and environment
files rather than the public repository.

The custom API service must pair every configured runtime path with a read-only mount. In
particular, Chinese reverse search requires both of these lines:

```yaml
services:
  dictionary-api:
    environment:
      DICTIONARY_REVERSE_SEARCH_DB_PATH: /var/lib/lexicon/reverse-search.db
    volumes:
      - ./data/reverse-search.db:/var/lib/lexicon/reverse-search.db:ro
```

Keep the primary database, etymology database, and pronunciation archive environment and
mount pairs alongside it when those capabilities are enabled. Semantic retrieval adds its
own read-only sidecar mount and keeps the provider settings in the private environment:

```yaml
services:
  dictionary-api:
    environment:
      DICTIONARY_SEMANTIC_SEARCH_DB_PATH: /var/lib/lexicon/semantic-search.db
      DICTIONARY_SEMANTIC_BASE_URL: ${DICTIONARY_SEMANTIC_BASE_URL:-}
      DICTIONARY_SEMANTIC_API_KEY: ${DICTIONARY_SEMANTIC_API_KEY:-}
      DICTIONARY_SEMANTIC_MODEL: ${DICTIONARY_SEMANTIC_MODEL:-Qwen/Qwen3-Embedding-4B}
      DICTIONARY_SEMANTIC_MODEL_KEY: ${DICTIONARY_SEMANTIC_MODEL_KEY:-qwen3-embedding-4b-1024-v1}
      DICTIONARY_SEMANTIC_TIMEOUT: ${DICTIONARY_SEMANTIC_TIMEOUT:-3s}
      DICTIONARY_SEMANTIC_PERSISTENT_CACHE: ${DICTIONARY_SEMANTIC_PERSISTENT_CACHE:-true}
      DICTIONARY_SEMANTIC_PERSISTENT_CACHE_PATH: /var/cache/lexicon/semantic-query-vectors.db
      DICTIONARY_SEMANTIC_PERSISTENT_CACHE_KEY: ${DICTIONARY_SEMANTIC_PERSISTENT_CACHE_KEY:-}
    volumes:
      - ./data/semantic-search.db:/var/lib/lexicon/semantic-search.db:ro
      - semantic-query-cache:/var/cache/lexicon
```

For a private Compose, initialize the cache volume for container UID/GID `65532:65532`
before starting the non-root API, or reproduce the bundled `semantic-cache-init` service.
Without a writable cache directory, semantic search still works but persistence is disabled.

The proxy must support streaming responses and preserve query strings, response content
types, `Cache-Control`, and `Service-Worker-Allowed`. Do not enable proxy caching for
`/api/v1/`, `/serwist/`, or `/manifest.webmanifest`.

The public origin must use HTTPS for PWA installation. The web application emits:

```text
/serwist/sw.js          Cache-Control: no-cache, no-store, must-revalidate
/serwist/sw.js          Service-Worker-Allowed: /
/manifest.webmanifest  Cache-Control: public, max-age=0, must-revalidate
```

See [PWA.md](PWA.md) for cache boundaries, update behavior, and the release test matrix.

## Network Security

Expose only ports 80 and 443 through the host firewall. The Compose file publishes no
port for the Next.js or Go containers. Caddy strips its server header and adds basic
content, frame, and referrer protections. Apply per-client request-rate controls at an
upstream firewall or reverse proxy when the service is opened to untrusted traffic.

Never map the `data` directory into Caddy or another static file root. Dictionary and
media requests must pass through the bounded API routes.

## Updates

Code updates preserve both mounted assets and Caddy certificates:

```sh
git pull --ff-only
docker compose \
  --env-file deploy/server/.env \
  -f deploy/server/compose.yaml \
  up -d --build
```

For an existing-reverse-proxy installation whose private Compose is the parent of its
Git checkout, update the production tracking branch inside the checkout and rebuild from
the private deployment directory:

```sh
cd /path/to/deployment/app
git switch server
git pull --ff-only origin server
cd ..
docker compose up -d --build
```

The private Compose owns network membership, proxy integration, asset paths, and media
origins; these deployment-specific values do not belong in the public repository.

Replace runtime assets only with fully imported and audited files of supported schema
versions. `dictionary.db` and `reverse-search.db` are one release unit: stop the API,
replace them together with the compatible `semantic-search.db` through atomic renames, and
restart only after their manifest checks pass.
The etymology database and audio archive can be replaced independently while the API is
stopped so SQLite metadata and the ZIP central directory are reloaded.

Each web rebuild creates a new PWA revision. Clients install it in the background and
activate it after explicit acceptance or on their next clean launch. Rebuilding an older
commit uses the same mechanism for rollback and does not touch browser learning data.

## Repository Boundary

The public Git history contains application code, import tooling, schemas,
documentation, and compact test fixtures. Versioned runtime databases and headword audio
are distributed as Release assets and pinned by `runtime-assets.json`; source databases
and remote media stay outside Git history.
