"""Resumable, budgeted builder for the semantic-search runtime sidecar."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import time
from pathlib import Path
from typing import Any

import numpy as np

from corpus import SCOPES, Corpus, load_corpus, report, sha256_file
from evaluation import evaluate, load_quality
from provider import OpenAIEmbeddingProvider, ProviderError, UsageLedger, validate_extra
from sidecar import BUILDER_VERSION, reusable_texts, write_sidecar


DEFAULT_MODEL_KEY = "qwen3-embedding-4b-1024-v1"
DEFAULT_PROVIDER_MODEL = "Qwen/Qwen3-Embedding-4B"
DEFAULT_QUERY_TEMPLATE = "Instruct: Given a Chinese expression or description, retrieve dictionary meanings and phrases that answer it\nQuery: {query}"


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for attempt in range(8):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.025 * (2**attempt))


def parse_extra_json(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("provider extra JSON must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("provider extra JSON must be an object")
    return validate_extra(value)


def build_fingerprint(corpus: Corpus, primary_db: Path, model_key: str, provider_model: str, dimensions: int, query_template: str, document_extra: dict[str, Any], query_extra: dict[str, Any]) -> str:
    payload = {"builder": BUILDER_VERSION, "corpus": corpus.corpus_fingerprint, "primary_sha256": sha256_file(primary_db), "reverse_sha256": corpus.reverse_sha256, "model_key": model_key, "provider_model": provider_model, "dimensions": dimensions, "query_template": query_template, "document_extra": document_extra, "query_extra": query_extra}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _matrix_path(output: Path) -> Path:
    return output / "vectors.f16"


def _checkpoint_path(output: Path) -> Path:
    return output / "checkpoint.json"


def open_matrix(path: Path, rows: int, dimensions: int, mode: str = "r") -> np.memmap:
    expected = rows * dimensions * np.dtype("<f2").itemsize
    if not path.is_file() or path.stat().st_size != expected:
        raise ValueError("float16 cache has an invalid size")
    return np.memmap(path, dtype="<f2", mode=mode, shape=(rows, dimensions))


def _initialise_matrix(path: Path, rows: int, dimensions: int) -> None:
    matrix = np.memmap(path, dtype="<f2", mode="w+", shape=(rows, dimensions))
    matrix.flush()
    del matrix


def _write_vectors(path: Path, indices: list[int], vectors: np.ndarray, rows: int, dimensions: int) -> None:
    values = np.asarray(vectors, dtype=np.float32)
    if values.shape != (len(indices), dimensions) or not np.isfinite(values).all():
        raise ValueError("provider vector dimensions or values changed")
    matrix = open_matrix(path, rows, dimensions, "r+")
    matrix[np.asarray(indices, dtype=np.intp)] = values
    matrix.flush()
    del matrix
    with path.open("r+b") as target:
        os.fsync(target.fileno())


def read_vectors(path: Path, rows: int, dimensions: int) -> list[list[float]]:
    matrix = open_matrix(path, rows, dimensions)
    result = matrix.astype(np.float32).tolist()
    del matrix
    return result


def _load_or_create_checkpoint(output: Path, fingerprint: str, count: int, dimensions: int, rebuild: bool, initially_completed: set[int] | None = None) -> dict[str, Any]:
    checkpoint_path, matrix_path = _checkpoint_path(output), _matrix_path(output)
    if rebuild:
        for path in (checkpoint_path, matrix_path):
            path.unlink(missing_ok=True)
    if checkpoint_path.exists() or matrix_path.exists():
        if not checkpoint_path.exists() or not matrix_path.exists():
            raise ValueError("semantic cache is incomplete; use --rebuild")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("fingerprint") != fingerprint or checkpoint.get("dimensions") != dimensions or not isinstance(checkpoint.get("completed"), list) or len(checkpoint["completed"]) != count:
            raise ValueError("semantic cache fingerprint or checkpoint does not match the requested build")
        matrix = open_matrix(matrix_path, count, dimensions)
        del matrix
        return checkpoint
    output.mkdir(parents=True, exist_ok=True)
    _initialise_matrix(matrix_path, count, dimensions)
    completed = [index in (initially_completed or set()) for index in range(count)]
    checkpoint = {"format": 2, "fingerprint": fingerprint, "dimensions": dimensions, "completed": completed, "usage": {"promptTokens": 0, "requests": 0, "unmetered": False}, "preflight": None}
    write_json_atomic(checkpoint_path, checkpoint)
    return checkpoint


def _provider_from_args(args: argparse.Namespace, ledger: UsageLedger, extra: dict[str, Any]) -> OpenAIEmbeddingProvider:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise ValueError(f"embedding API key is required through environment variable {args.api_key_env}")
    if not args.base_url:
        raise ValueError("--base-url is required when vectors or query evaluation need embedding")
    return OpenAIEmbeddingProvider(args.base_url, api_key, args.provider_model, args.dimensions, args.encoding_format, extra, args.timeout_seconds, args.max_retries, args.proxy, ledger, args.allow_unmetered)


def _checkpoint_usage(checkpoint: dict[str, Any], result: Any) -> None:
    checkpoint["usage"]["promptTokens"] += result.prompt_tokens
    checkpoint["usage"]["requests"] += result.requests
    checkpoint["usage"]["unmetered"] = checkpoint["usage"]["unmetered"] or result.unmetered


def _preflight_plan(corpus: Corpus, pending: list[int], probe_count: int, result: Any, concurrency: int, batch_size: int, safety_factor: float, ledger: UsageLedger, limit: float | None, multiplier: float) -> dict[str, int | float | None]:
    per_text = max(1, math.ceil(result.prompt_tokens / probe_count))
    document_estimate = per_text * len(pending)
    max_batch_reservation = math.ceil(per_text * min(batch_size, len(pending)) * safety_factor)
    margin = concurrency * max_batch_reservation
    confirmed = int(ledger.snapshot()["promptTokens"])
    projected = confirmed + document_estimate + margin
    plan = {"preflightTexts": probe_count, "preflightPromptTokens": result.prompt_tokens, "tokensPerText": per_text, "documentEstimatedPromptTokens": document_estimate, "inFlightReservePromptTokens": margin, "projectedPromptTokens": projected, "projectedWeightedUnits": projected * multiplier, "maximumWeightedUnits": limit}
    return plan


def _batches(pending: list[int], corpus: Corpus, batch_size: int):
    for start in range(0, len(pending), batch_size):
        indices = pending[start:start + batch_size]
        yield indices, [corpus.texts[index] for index in indices]


def build_cached_vectors(args: argparse.Namespace, corpus: Corpus, fingerprint: str, reused_indices: set[int] | None = None) -> tuple[np.memmap, dict[str, Any], UsageLedger]:
    checkpoint = _load_or_create_checkpoint(args.output_dir, fingerprint, len(corpus.texts), args.dimensions, args.rebuild, reused_indices)
    if reused_indices:
        changed = False
        for index in reused_indices:
            if not checkpoint["completed"][index]:
                checkpoint["completed"][index] = True
                changed = True
        if changed:
            checkpoint["preflight"] = None
            write_json_atomic(_checkpoint_path(args.output_dir), checkpoint)
    usage = checkpoint["usage"]
    ledger = UsageLedger(args.max_weighted_units, args.input_multiplier, int(usage["promptTokens"]), int(usage["requests"]), bool(usage.get("unmetered")))
    pending = [index for index, done in enumerate(checkpoint["completed"]) if not done]
    if not pending:
        return open_matrix(_matrix_path(args.output_dir), len(corpus.texts), args.dimensions), usage, ledger
    provider = _provider_from_args(args, ledger, args.document_extra)
    plan = checkpoint.get("preflight")
    if plan is None:
        probe_indices = pending[:min(args.batch_size, len(pending))]
        probe_texts = [corpus.texts[index] for index in probe_indices]
        probe = provider.embed(probe_texts)
        _write_vectors(_matrix_path(args.output_dir), probe_indices, probe.vectors, len(corpus.texts), args.dimensions)
        for index in probe_indices:
            checkpoint["completed"][index] = True
        _checkpoint_usage(checkpoint, probe)
        pending = [index for index, done in enumerate(checkpoint["completed"]) if not done]
        plan = _preflight_plan(corpus, pending, len(probe_indices), probe, args.concurrency, args.batch_size, args.budget_safety_factor, ledger, args.max_weighted_units, args.input_multiplier)
        checkpoint["preflight"] = plan
        write_json_atomic(args.output_dir / "preflight.json", plan)
        write_json_atomic(_checkpoint_path(args.output_dir), checkpoint)
    if args.max_weighted_units is not None and float(plan["projectedWeightedUnits"]) > args.max_weighted_units:
        raise ValueError("preflight estimate plus concurrent in-flight reserve exceeds the configured budget")
    if bool(usage.get("unmetered")) and args.max_weighted_units is not None:
        raise ValueError("unmetered provider responses cannot be used with --max-weighted-units")
    def reservation(texts: list[str]) -> int:
        return conservative_reservation_tokens(texts, args.budget_safety_factor)
    iterator = iter(_batches(pending, corpus, args.batch_size))
    completed_count = len(corpus.texts) - len(pending)
    progress_origin = completed_count
    next_progress = ((completed_count // 10_000) + 1) * 10_000
    progress_started = time.monotonic()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency)
    in_flight: dict[concurrent.futures.Future[Any], tuple[list[int], list[str]]] = {}
    try:
        def fill_window() -> None:
            while len(in_flight) < args.concurrency:
                try:
                    indices, texts = next(iterator)
                except StopIteration:
                    return
                in_flight[executor.submit(provider.embed, texts, reservation(texts))] = (indices, texts)
        fill_window()
        while in_flight:
            done, _ = concurrent.futures.wait(in_flight, return_when=concurrent.futures.FIRST_COMPLETED)
            successes: list[tuple[list[int], Any]] = []
            failure: BaseException | None = None
            for future in done:
                indices, _ = in_flight.pop(future)
                try:
                    successes.append((indices, future.result()))
                except BaseException as error:
                    failure = error
            for indices, result in successes:
                _write_vectors(_matrix_path(args.output_dir), indices, result.vectors, len(corpus.texts), args.dimensions)
                for index in indices:
                    checkpoint["completed"][index] = True
                _checkpoint_usage(checkpoint, result)
                write_json_atomic(_checkpoint_path(args.output_dir), checkpoint)
                completed_count += len(indices)
                if completed_count >= next_progress or completed_count == len(corpus.texts):
                    elapsed = max(time.monotonic() - progress_started, 0.001)
                    print(
                        json.dumps(
                            {
                                "completed": completed_count,
                                "total": len(corpus.texts),
                                "textsPerSecond": round((completed_count - progress_origin) / elapsed, 1),
                                "promptTokens": checkpoint["usage"]["promptTokens"],
                            }
                        ),
                        flush=True,
                    )
                    while next_progress <= completed_count:
                        next_progress += 10_000
            if failure is not None:
                for future in in_flight:
                    future.cancel()
                raise failure
            fill_window()
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
    return open_matrix(_matrix_path(args.output_dir), len(corpus.texts), args.dimensions), usage, ledger


def _cost_report(document_usage: dict[str, Any], ledger: UsageLedger, multiplier: float) -> dict[str, Any]:
    total = ledger.snapshot()
    quality_tokens = int(total["promptTokens"]) - int(document_usage["promptTokens"])
    quality_requests = int(total["requests"]) - int(document_usage["requests"])
    return {"documents": {**document_usage, "weightedUnits": int(document_usage["promptTokens"]) * multiplier}, "quality": {"promptTokens": quality_tokens, "requests": quality_requests, "weightedUnits": quality_tokens * multiplier, "unmetered": bool(total["unmetered"]) and not bool(document_usage.get("unmetered"))}, "total": total, "budgetPolicy": "preflight-estimate-with-pre-request-reservations"}


def conservative_reservation_tokens(inputs: list[str], safety_factor: float) -> int:
    """Use UTF-8 byte length as a tokenizer-independent upper bound per input."""
    if not inputs or safety_factor < 1:
        raise ValueError("quality inputs and safety factor are invalid")
    return math.ceil(sum(len(value.encode("utf-8")) for value in inputs) * safety_factor)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a runtime-compatible semantic-search sidecar from visible Chinese reverse-search documents.")
    parser.add_argument("--reverse-db", type=Path, default=Path("data/reverse-search.db"))
    parser.add_argument("--primary-db", type=Path, default=Path("data/dictionary.db"))
    parser.add_argument("--output-dir", type=Path, default=Path("work/semantic-search"))
    parser.add_argument("--sidecar", type=Path, default=Path("data/semantic-search.db"))
    parser.add_argument("--reuse-vectors-from", type=Path)
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL"))
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--provider-model", default=DEFAULT_PROVIDER_MODEL)
    parser.add_argument("--model-key", default=DEFAULT_MODEL_KEY)
    parser.add_argument("--dimensions", type=int, default=1024)
    parser.add_argument("--query-template", default=DEFAULT_QUERY_TEMPLATE)
    parser.add_argument("--document-extra-json", default="{}")
    parser.add_argument("--query-extra-json", default="{}")
    parser.add_argument("--encoding-format", choices=("float", "base64"), default="float")
    parser.add_argument("--allow-unmetered", action="store_true")
    parser.add_argument("--scope", action="append", choices=SCOPES)
    parser.add_argument("--sample-size", type=int, default=0)
    parser.add_argument("--sample-seed", default="lexicon-semantic-v1")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=60.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--proxy")
    parser.add_argument("--input-multiplier", type=float, default=1.0)
    parser.add_argument("--max-weighted-units", type=float)
    parser.add_argument("--budget-safety-factor", type=float, default=1.15)
    parser.add_argument("--block-size", type=int, default=4096)
    parser.add_argument("--quality-file", type=Path, action="append")
    parser.add_argument("--top-k", type=int, default=32)
    parser.add_argument("--minimum-score", type=float, help="Calibrated model-specific absolute cosine-score rejection threshold.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if min(args.dimensions, args.batch_size, args.concurrency, args.block_size, args.top_k) < 1 or args.timeout_seconds <= 0 or args.max_retries < 0 or args.input_multiplier <= 0 or args.budget_safety_factor < 1:
        raise SystemExit("numeric arguments are invalid")
    if args.max_weighted_units is not None and args.max_weighted_units <= 0:
        raise SystemExit("maximum weighted units must be positive")
    if args.allow_unmetered and args.max_weighted_units is not None:
        raise SystemExit("--allow-unmetered cannot be combined with --max-weighted-units")
    if args.query_template.count("{query}") != 1 or any(character in args.query_template.replace("{query}", "") for character in "{}"):
        raise SystemExit("query template must contain exactly one {query} placeholder")
    try:
        args.document_extra, args.query_extra = parse_extra_json(args.document_extra_json), parse_extra_json(args.query_extra_json)
        corpus = load_corpus(args.reverse_db, args.scope or SCOPES, args.sample_size, args.sample_seed)
        if not corpus.texts:
            raise ValueError("selected corpus is empty")
        write_json_atomic(args.output_dir / "corpus-report.json", report(corpus)); print(json.dumps(report(corpus), ensure_ascii=False, indent=2))
        if not args.primary_db.is_file():
            raise ValueError(f"primary database is missing: {args.primary_db}")
        if args.minimum_score is None or not math.isfinite(args.minimum_score) or args.minimum_score < -1 or args.minimum_score > 1:
            raise ValueError("--minimum-score must be a finite value from -1 through 1; choose it from calibrated review data")
        fingerprint = build_fingerprint(corpus, args.primary_db, args.model_key, args.provider_model, args.dimensions, args.query_template, args.document_extra, args.query_extra)
        reused_indices: set[int] = set()
        if args.reuse_vectors_from:
            if args.quality_file:
                raise ValueError("quality evaluation requires float vectors and cannot be combined with --reuse-vectors-from")
            source_texts = reusable_texts(args.reuse_vectors_from, args.dimensions, args.model_key, args.provider_model, args.document_extra)
            reused_indices = {index for index, text in enumerate(corpus.texts) if text in source_texts}
        reuse_report = {
            "reusedVectors": len(reused_indices),
            "newVectors": len(corpus.texts) - len(reused_indices),
            "source": str(args.reuse_vectors_from) if args.reuse_vectors_from else None,
            "matchKey": "normalizedChineseText",
            "minimumScore": args.minimum_score,
        }
        write_json_atomic(args.output_dir / "reuse-plan.json", reuse_report)
        print(json.dumps(reuse_report, ensure_ascii=False, indent=2))
        if args.dry_run:
            return
        if args.reuse_vectors_from:
            matrix, document_usage, ledger = build_cached_vectors(args, corpus, fingerprint, reused_indices)
        else:
            matrix, document_usage, ledger = build_cached_vectors(args, corpus, fingerprint)
        sidecar = args.sidecar or args.output_dir / "semantic-search.db"
        metadata = write_sidecar(sidecar, corpus, matrix, args.dimensions, args.primary_db, args.model_key, args.provider_model, args.query_template, args.document_extra, args.query_extra, args.minimum_score, args.block_size, args.reuse_vectors_from)
        quality = None
        if args.quality_file:
            provider = _provider_from_args(args, ledger, args.query_extra)
            def embed_quality(texts: list[str]) -> np.ndarray:
                reserve = conservative_reservation_tokens(texts, args.budget_safety_factor)
                snapshot = ledger.snapshot()
                if args.max_weighted_units is not None and (float(snapshot["promptTokens"]) + float(snapshot["reservedPromptTokens"]) + reserve) * args.input_multiplier > args.max_weighted_units:
                    raise ValueError("quality request reservation exceeds the configured budget")
                return provider.embed(texts, reserve).vectors
            quality = evaluate(corpus, matrix, embed_quality, load_quality(args.quality_file), args.query_template, args.top_k)
            write_json_atomic(args.output_dir / "quality.json", quality)
            print(json.dumps(quality["float16"], ensure_ascii=False, indent=2)); print(json.dumps(quality["runtimeInt8"], ensure_ascii=False, indent=2))
        write_json_atomic(args.output_dir / "cost-report.json", _cost_report(document_usage, ledger, args.input_multiplier))
        write_json_atomic(args.output_dir / "build-report.json", {"sidecar": str(sidecar), "metadata": metadata, "quality": quality is not None})
    except (ValueError, FileNotFoundError, ProviderError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
