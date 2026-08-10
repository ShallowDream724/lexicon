"""Resumable semantic-sidecar builder.

The only secret accepted by this command is read from an environment variable.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import struct
from pathlib import Path
from typing import Any

from corpus import SCOPES, Corpus, load_corpus, report, sha256_file
from evaluation import evaluate, load_quality
from provider import OpenAIEmbeddingProvider, ProviderError, UsageLedger
from sidecar import write_sidecar


DEFAULT_MODEL_KEY = "qwen3-embedding-4b-1024-v1"
DEFAULT_PROVIDER_MODEL = "Qwen/Qwen3-Embedding-4B"
DEFAULT_QUERY_TEMPLATE = "Instruct: Given a Chinese expression or description, retrieve dictionary meanings and phrases that answer it\nQuery: {query}"


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def parse_extra_json(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("provider extra JSON must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("provider extra JSON must be an object")
    return value


def build_fingerprint(corpus: Corpus, primary_db: Path, model_key: str, provider_model: str, dimensions: int, query_template: str, extra: dict[str, Any]) -> str:
    payload = {
        "format": 1,
        "corpus": corpus.corpus_fingerprint,
        "primary_sha256": sha256_file(primary_db),
        "reverse_sha256": corpus.reverse_sha256,
        "model_key": model_key,
        "provider_model": provider_model,
        "dimensions": dimensions,
        "query_template": query_template,
        "provider_extra": extra,
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _matrix_path(output: Path) -> Path:
    return output / "vectors.f16"


def _checkpoint_path(output: Path) -> Path:
    return output / "checkpoint.json"


def _initialise_matrix(path: Path, rows: int, dimensions: int) -> None:
    with path.open("wb") as target:
        target.truncate(rows * dimensions * 2)


def _write_vectors(path: Path, records: list[tuple[int, list[float]]], dimensions: int) -> None:
    with path.open("r+b") as target:
        for index, vector in records:
            if len(vector) != dimensions:
                raise ValueError("provider vector dimensions changed")
            target.seek(index * dimensions * 2)
            target.write(struct.pack("<" + "e" * dimensions, *vector))
        target.flush()
        os.fsync(target.fileno())


def read_vectors(path: Path, rows: int, dimensions: int) -> list[list[float]]:
    expected = rows * dimensions * 2
    if path.stat().st_size != expected:
        raise ValueError("float16 cache has an invalid size")
    with path.open("rb") as source:
        data = source.read()
    unpacked = struct.unpack("<" + "e" * (rows * dimensions), data)
    return [list(unpacked[index * dimensions:(index + 1) * dimensions]) for index in range(rows)]


def iter_vectors(path: Path, rows: int, dimensions: int):
    with path.open("rb") as source:
        for _ in range(rows):
            block = source.read(dimensions * 2)
            if len(block) != dimensions * 2:
                raise ValueError("float16 cache ended unexpectedly")
            yield list(struct.unpack("<" + "e" * dimensions, block))


def _load_or_create_checkpoint(output: Path, fingerprint: str, count: int, dimensions: int, rebuild: bool) -> dict[str, Any]:
    checkpoint_path, matrix_path = _checkpoint_path(output), _matrix_path(output)
    if rebuild:
        for path in (checkpoint_path, matrix_path):
            path.unlink(missing_ok=True)
    if checkpoint_path.exists() or matrix_path.exists():
        if not checkpoint_path.exists() or not matrix_path.exists():
            raise ValueError("semantic cache is incomplete; use --rebuild")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("fingerprint") != fingerprint:
            raise ValueError("semantic cache fingerprint does not match the requested build")
        if checkpoint.get("dimensions") != dimensions or not isinstance(checkpoint.get("completed"), list) or len(checkpoint["completed"]) != count:
            raise ValueError("semantic cache checkpoint is invalid")
        if matrix_path.stat().st_size != count * dimensions * 2:
            raise ValueError("semantic cache matrix is invalid")
        return checkpoint
    output.mkdir(parents=True, exist_ok=True)
    _initialise_matrix(matrix_path, count, dimensions)
    checkpoint = {"format": 1, "fingerprint": fingerprint, "dimensions": dimensions, "completed": [False] * count, "usage": {"promptTokens": 0, "requests": 0, "preflightPromptTokens": 0}}
    write_json_atomic(checkpoint_path, checkpoint)
    return checkpoint


def _provider_from_args(args: argparse.Namespace, ledger: UsageLedger) -> OpenAIEmbeddingProvider:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise ValueError(f"embedding API key is required through environment variable {args.api_key_env}")
    if not args.base_url:
        raise ValueError("--base-url is required when vectors or query evaluation need embedding")
    return OpenAIEmbeddingProvider(args.base_url, api_key, args.provider_model, args.dimensions, args.encoding_format, args.provider_extra, args.timeout_seconds, args.max_retries, args.proxy, ledger)


def _preflight(corpus: Corpus, provider: OpenAIEmbeddingProvider, batch_size: int, weighted_limit: float | None, multiplier: float) -> tuple[list[list[float]], dict[str, Any]]:
    probe = list(corpus.texts[:min(batch_size, len(corpus.texts))])
    result = provider.embed(probe)
    estimated_tokens = round(result.prompt_tokens * len(corpus.texts) / len(probe))
    estimated_weighted = estimated_tokens * multiplier
    estimate = {"preflightTexts": len(probe), "preflightPromptTokens": result.prompt_tokens, "estimatedBuildPromptTokens": estimated_tokens, "estimatedBuildWeightedUnits": estimated_weighted, "maximumWeightedUnits": weighted_limit}
    if weighted_limit is not None and estimated_weighted > weighted_limit:
        raise ValueError("preflight estimate exceeds the configured budget")
    return result.vectors, estimate


def build_cached_vectors(args: argparse.Namespace, corpus: Corpus, fingerprint: str) -> tuple[Path, dict[str, Any]]:
    checkpoint = _load_or_create_checkpoint(args.output_dir, fingerprint, len(corpus.texts), args.dimensions, args.rebuild)
    pending = [index for index, done in enumerate(checkpoint["completed"]) if not done]
    if not pending:
        return _matrix_path(args.output_dir), checkpoint["usage"]
    previous_usage = checkpoint["usage"]
    ledger = UsageLedger(args.max_weighted_units, args.input_multiplier, int(previous_usage["promptTokens"]), int(previous_usage["requests"]))
    provider = _provider_from_args(args, ledger)
    if not any(checkpoint["completed"]):
        probe, estimate = _preflight(corpus, provider, args.batch_size, args.max_weighted_units, args.input_multiplier)
        write_json_atomic(args.output_dir / "preflight.json", estimate)
        _write_vectors(_matrix_path(args.output_dir), list(enumerate(probe)), args.dimensions)
        for index in range(len(probe)):
            checkpoint["completed"][index] = True
        checkpoint["usage"]["preflightPromptTokens"] = estimate["preflightPromptTokens"]
        checkpoint["usage"]["promptTokens"] += estimate["preflightPromptTokens"]
        checkpoint["usage"]["requests"] += 1
        write_json_atomic(_checkpoint_path(args.output_dir), checkpoint)
        pending = [index for index, done in enumerate(checkpoint["completed"]) if not done]
    batches = [(indices, [corpus.texts[index] for index in indices]) for indices in (pending[offset:offset + args.batch_size] for offset in range(0, len(pending), args.batch_size))]
    def embed_batch(item: tuple[list[int], list[str]]) -> tuple[list[int], list[list[float]], int]:
        indices, texts = item
        response = provider.embed(texts)
        return indices, response.vectors, response.prompt_tokens
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = [executor.submit(embed_batch, batch) for batch in batches]
        for future in concurrent.futures.as_completed(futures):
            indices, vectors, tokens = future.result()
            _write_vectors(_matrix_path(args.output_dir), list(zip(indices, vectors, strict=True)), args.dimensions)
            for index in indices:
                checkpoint["completed"][index] = True
            checkpoint["usage"]["promptTokens"] += tokens
            checkpoint["usage"]["requests"] += 1
            write_json_atomic(_checkpoint_path(args.output_dir), checkpoint)
    return _matrix_path(args.output_dir), checkpoint["usage"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a runtime-compatible semantic-search sidecar from visible Chinese reverse-search documents.")
    parser.add_argument("--reverse-db", type=Path, default=Path("data/reverse-search.db"))
    parser.add_argument("--primary-db", type=Path, default=Path("data/dictionary.db"))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sidecar", type=Path, help="Output SQLite sidecar; defaults to OUTPUT-DIR/semantic-search.db")
    parser.add_argument("--base-url")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--provider-model", default=DEFAULT_PROVIDER_MODEL)
    parser.add_argument("--model-key", default=DEFAULT_MODEL_KEY)
    parser.add_argument("--dimensions", type=int, default=1024)
    parser.add_argument("--query-template", default=DEFAULT_QUERY_TEMPLATE)
    parser.add_argument("--provider-extra-json", default="{}")
    parser.add_argument("--encoding-format", choices=("float", "base64"), default="float")
    parser.add_argument("--scope", action="append", choices=SCOPES, help="Repeat to restrict scopes; default is all scopes.")
    parser.add_argument("--sample-size", type=int, default=0)
    parser.add_argument("--sample-seed", default="lexicon-semantic-v1")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=60.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--proxy")
    parser.add_argument("--input-multiplier", type=float, default=1.0)
    parser.add_argument("--max-weighted-units", type=float)
    parser.add_argument("--block-size", type=int, default=4096)
    parser.add_argument("--quality-file", type=Path)
    parser.add_argument("--top-k", type=int, default=32)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.dimensions < 1 or args.batch_size < 1 or args.concurrency < 1 or args.block_size < 1 or args.top_k < 1 or args.timeout_seconds <= 0 or args.max_retries < 0 or args.input_multiplier <= 0:
        raise SystemExit("numeric arguments must be positive (retry count may be zero)")
    if args.max_weighted_units is not None and args.max_weighted_units <= 0:
        raise SystemExit("maximum weighted units must be positive")
    if args.query_template.count("{query}") != 1 or any(character in args.query_template.replace("{query}", "") for character in "{}"):
        raise SystemExit("query template must contain exactly one {query} placeholder")
    try:
        args.provider_extra = parse_extra_json(args.provider_extra_json)
        corpus = load_corpus(args.reverse_db, args.scope or SCOPES, args.sample_size, args.sample_seed)
        if not corpus.texts:
            raise ValueError("selected corpus is empty")
        summary = report(corpus)
        write_json_atomic(args.output_dir / "corpus-report.json", summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if args.dry_run:
            return
        if not args.primary_db.is_file():
            raise ValueError(f"primary database is missing: {args.primary_db}")
        fingerprint = build_fingerprint(corpus, args.primary_db, args.model_key, args.provider_model, args.dimensions, args.query_template, args.provider_extra)
        vectors_path, usage = build_cached_vectors(args, corpus, fingerprint)
        sidecar = args.sidecar or args.output_dir / "semantic-search.db"
        metadata = write_sidecar(sidecar, corpus, iter_vectors(vectors_path, len(corpus.texts), args.dimensions), args.dimensions, args.primary_db, args.model_key, args.query_template, args.block_size)
        write_json_atomic(args.output_dir / "build-report.json", {"usage": usage, "sidecar": str(sidecar), "metadata": metadata})
        if args.quality_file:
            ledger = UsageLedger(args.max_weighted_units, args.input_multiplier)
            provider = _provider_from_args(args, ledger)
            quality = evaluate(corpus, lambda: iter_vectors(vectors_path, len(corpus.texts), args.dimensions), lambda texts: provider.embed(texts).vectors, load_quality(args.quality_file), args.query_template, args.top_k)
            write_json_atomic(args.output_dir / "quality.json", quality)
            print(json.dumps(quality["float16"], ensure_ascii=False, indent=2))
            print(json.dumps(quality["int8"], ensure_ascii=False, indent=2))
    except (ValueError, FileNotFoundError, ProviderError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
