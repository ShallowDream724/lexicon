"""Calibrate and evaluate a runtime-compatible semantic absolute-score threshold.

The tool reads the immutable schema-5 sidecar directly. It never calls a search
API: query embeddings are scored against the packed int8 blocks exactly as the
Go runtime does (normalise, round away from zero, clamp to [-127, 127], dot/16129).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from provider import OpenAIEmbeddingProvider, UsageLedger


SCHEMA_VERSION = "5"
QUANTIZATION = "symmetric-int8-127"
DEFAULT_SCOPES = ("sense", "phrase", "form")
VALID_SCOPES = frozenset(("sense", "phrase", "form", "example", "resource"))
VALID_SPLITS = frozenset(("development", "holdout"))
VALID_LABELS = frozenset(("answerable", "reject"))
SCORE_DENOMINATOR = 127 * 127


def normalized_query(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFKC", value).casefold()
        if not character.isspace() and not unicodedata.category(character).startswith(("P", "S"))
    )


def normalized_headword(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).replace("·", "").replace("ˈ", "").replace("ˌ", "")
    return " ".join(normalized.split()).casefold()


def go_quantize_query(vector: np.ndarray, dimensions: int) -> np.ndarray:
    """Match Go's normalizeAndQuantize, including half-way rounding semantics."""
    values = np.asarray(vector, dtype=np.float32)
    if values.ndim != 1 or values.size != dimensions or not np.isfinite(values).all():
        raise ValueError("query embedding dimensions or values are invalid")
    norm = math.sqrt(sum(float(value) * float(value) for value in values))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("query embedding must not be zero")
    scaled = values.astype(np.float64) / norm * 127.0
    rounded = np.where(scaled >= 0, np.floor(scaled + 0.5), np.ceil(scaled - 0.5))
    return np.clip(rounded, -127, 127).astype(np.int8)


@dataclass(frozen=True)
class Sidecar:
    path: Path
    dimensions: int
    block_size: int
    vector_count: int
    model_key: str
    provider_model: str
    query_template: str
    query_extra: dict[str, Any]
    selected_heads: dict[int, tuple[str, ...]]
    target_heads: frozenset[str]


def _metadata(connection: sqlite3.Connection) -> dict[str, str]:
    return {str(key): str(value) for key, value in connection.execute("SELECT key, value FROM metadata")}


def _positive_int(value: str | None, name: str) -> int:
    try:
        result = int(value or "")
    except ValueError as error:
        raise ValueError(f"sidecar metadata {name} is invalid") from error
    if result < 1:
        raise ValueError(f"sidecar metadata {name} is invalid")
    return result


def load_sidecar(path: Path, scopes: Iterable[str]) -> Sidecar:
    selected_scopes = tuple(scopes)
    if not selected_scopes or not set(selected_scopes).issubset(VALID_SCOPES):
        raise ValueError("scopes must be a non-empty subset of supported sidecar scopes")
    if not path.is_file():
        raise FileNotFoundError(f"semantic sidecar is missing: {path}")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        metadata = _metadata(connection)
        if metadata.get("schema_version") != SCHEMA_VERSION or metadata.get("quantization") != QUANTIZATION:
            raise ValueError("sidecar must use schema 5 symmetric-int8-127 vectors")
        dimensions = _positive_int(metadata.get("dimensions"), "dimensions")
        block_size = _positive_int(metadata.get("block_size"), "block_size")
        vector_count = _positive_int(metadata.get("vector_count"), "vector_count")
        model_key, provider_model, query_template = metadata.get("model_key", ""), metadata.get("provider_model", ""), metadata.get("query_template", "")
        if not model_key or not provider_model or query_template.count("{query}") != 1 or any(char in query_template.replace("{query}", "") for char in "{}"):
            raise ValueError("sidecar query metadata is invalid")
        try:
            query_extra = json.loads(metadata.get("query_extra_json", "{}"))
        except json.JSONDecodeError as error:
            raise ValueError("sidecar query_extra_json is invalid") from error
        if not isinstance(query_extra, dict):
            raise ValueError("sidecar query_extra_json must be an object")
        text_ids = [int(row[0]) for row in connection.execute("SELECT id FROM texts ORDER BY id")]
        if text_ids != list(range(vector_count)):
            raise ValueError("sidecar text ids do not match vector_count")
        selected: dict[int, set[str]] = {}
        all_heads: set[str] = set()
        for text_id, headword, scope in connection.execute("SELECT text_id, headword, scope FROM documents"):
            head = normalized_headword(str(headword))
            all_heads.add(head)
            if str(scope) in selected_scopes:
                selected.setdefault(int(text_id), set()).add(head)
        if not selected:
            raise ValueError("selected sidecar scopes contain no documents")
        expected_first = expected_block = 0
        for block_index, first, count, data in connection.execute("SELECT block_index, first_vector_id, vector_count, data FROM vector_blocks ORDER BY block_index"):
            expected_count = min(block_size, vector_count - expected_first)
            if int(block_index) != expected_block or int(first) != expected_first or int(count) != expected_count or len(data) != expected_count * dimensions:
                raise ValueError("sidecar vector blocks are invalid or incomplete")
            expected_block += 1
            expected_first += expected_count
        if expected_first != vector_count:
            raise ValueError("sidecar vector blocks are invalid or incomplete")
        return Sidecar(path, dimensions, block_size, vector_count, model_key, provider_model, query_template, query_extra, {key: tuple(sorted(value)) for key, value in selected.items()}, frozenset(all_heads))
    finally:
        connection.close()


def load_cases(paths: list[Path], expected_split: str | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    ids: set[str] = set()
    queries: set[str] = set()
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"dataset JSON is invalid: {path}") from error
        if not isinstance(value, list):
            raise ValueError(f"dataset root must be an array: {path}")
        for index, row in enumerate(value):
            source = f"{path}[{index}]"
            if not isinstance(row, dict):
                raise ValueError(f"{source}: case must be an object")
            required = ("id", "split", "label", "query", "category")
            if any(field not in row for field in required):
                raise ValueError(f"{source}: requires id, split, label, query, category")
            if not isinstance(row["id"], str) or not row["id"] or row["id"] in ids:
                raise ValueError(f"{source}: id must be unique and non-empty")
            if row["split"] not in VALID_SPLITS or (expected_split and row["split"] != expected_split):
                raise ValueError(f"{source}: split is invalid for this mode")
            if row["label"] not in VALID_LABELS or not isinstance(row["query"], str) or not row["query"].strip() or not isinstance(row["category"], str) or not row["category"].strip():
                raise ValueError(f"{source}: label, query, or category is invalid")
            signature = normalized_query(row["query"])
            if signature in queries:
                raise ValueError(f"{source}: query is not unique after normalization")
            targets = row.get("targets")
            if row["label"] == "answerable":
                if not isinstance(targets, list) or not targets or not all(isinstance(item, str) and item.strip() for item in targets):
                    raise ValueError(f"{source}: answerable cases require non-empty string targets")
                row = {**row, "targets": list(dict.fromkeys(normalized_headword(item) for item in targets))}
            elif targets is not None:
                raise ValueError(f"{source}: reject cases must omit targets")
            ids.add(row["id"])
            queries.add(signature)
            rows.append(row)
    if not rows:
        raise ValueError("at least one dataset case is required")
    return rows


def validate_targets(cases: list[dict[str, Any]], sidecar: Sidecar) -> None:
    selected = {head for heads in sidecar.selected_heads.values() for head in heads}
    for case in cases:
        for target in case.get("targets", []):
            if target not in sidecar.target_heads:
                raise ValueError(f"{case['id']}: target headword does not exist in sidecar: {target}")
            if target not in selected:
                raise ValueError(f"{case['id']}: target headword is absent from selected scopes: {target}")


def validate_disjoint(cases: list[dict[str, Any]], paths: list[Path]) -> None:
    own = {normalized_query(case["query"]) for case in cases}
    for path in paths:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            raise ValueError(f"disjoint dataset root must be an array: {path}")
        for index, row in enumerate(value):
            if not isinstance(row, dict) or not isinstance(row.get("query"), str):
                raise ValueError(f"{path}[{index}]: disjoint dataset case requires query")
            if normalized_query(row["query"]) in own:
                raise ValueError(f"query overlaps disjoint dataset: {path}[{index}]")


def _is_better_head(candidate: tuple[int, int], current: tuple[int, int]) -> bool:
    return candidate[0] > current[0] or (candidate[0] == current[0] and candidate[1] < current[1])


def _record_head_score(heads: dict[str, tuple[int, int]], headword: str, dot: int, text_id: int) -> None:
    candidate = (dot, text_id)
    current = heads.get(headword)
    if current is not None:
        if _is_better_head(candidate, current):
            heads[headword] = candidate
        return
    heads[headword] = candidate


def score_queries(sidecar: Sidecar, query_vectors: np.ndarray, target_sets: list[set[str] | None], top_headwords: int) -> list[dict[str, Any]]:
    """Score every query during one sidecar block pass without retaining text scores."""
    vectors = np.asarray(query_vectors, dtype=np.float32)
    if vectors.shape != (len(target_sets), sidecar.dimensions) or top_headwords < 1:
        raise ValueError("query embedding count, dimensions, or headword limit are invalid")
    quantized = np.column_stack([go_quantize_query(vector, sidecar.dimensions) for vector in vectors]).astype(np.int32)
    maximum = np.full(len(target_sets), np.iinfo(np.int32).min, dtype=np.int32)
    head_scores: list[dict[str, tuple[int, int]]] = [{} for _ in target_sets]
    connection = sqlite3.connect(sidecar.path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        for first, count, data in connection.execute("SELECT first_vector_id, vector_count, data FROM vector_blocks ORDER BY block_index"):
            block = np.frombuffer(data, dtype=np.int8).reshape(int(count), sidecar.dimensions).astype(np.int32)
            active_offsets = [offset for offset in range(int(count)) if int(first) + offset in sidecar.selected_heads]
            if not active_offsets:
                continue
            dots = block[active_offsets] @ quantized
            maximum = np.maximum(maximum, dots.max(axis=0))
            for row_index, offset in enumerate(active_offsets):
                text_id = int(first) + offset
                heads = sidecar.selected_heads.get(text_id)
                for head in heads:
                    for query_index in range(len(target_sets)):
                        _record_head_score(head_scores[query_index], head, int(dots[row_index, query_index]), text_id)
    finally:
        connection.close()
    results: list[dict[str, Any]] = []
    for query_index, targets in enumerate(target_sets):
        report: dict[str, Any] = {"maximum": int(maximum[query_index]) / SCORE_DENOMINATOR}
        ranked = sorted(head_scores[query_index].items(), key=lambda item: (-item[1][0], item[1][1], item[0]))
        report["topHeadwords"] = [{"headword": head, "score": dot / SCORE_DENOMINATOR, "textId": text_id} for head, (dot, text_id) in ranked[:top_headwords]]
        if targets is not None:
            ranks = {head: index for index, (head, _) in enumerate(ranked, start=1)}
            report["targetScores"] = {target: head_scores[query_index][target][0] / SCORE_DENOMINATOR for target in targets}
            report["targetRanks"] = {target: ranks[target] for target in targets}
            report["bestTargetRank"] = min(report["targetRanks"].values())
        results.append(report)
    return results


def score_query(sidecar: Sidecar, query_vector: np.ndarray, top_headwords: int) -> tuple[float, list[dict[str, Any]], dict[int, float]]:
    """Single-query compatibility wrapper; text-level scores are intentionally not retained."""
    result = score_queries(sidecar, np.asarray([query_vector]), [None], top_headwords)[0]
    return float(result["maximum"]), list(result["topHeadwords"]), {}


def evaluate_cases(sidecar: Sidecar, cases: list[dict[str, Any]], vectors: np.ndarray, top_headwords: int) -> list[dict[str, Any]]:
    if vectors.shape != (len(cases), sidecar.dimensions):
        raise ValueError("query embedding count or dimensions are invalid")
    scored = score_queries(sidecar, vectors, [set(case["targets"]) if case["label"] == "answerable" else None for case in cases], top_headwords)
    rows: list[dict[str, Any]] = []
    for case, result in zip(cases, scored, strict=True):
        report: dict[str, Any] = {"id": case["id"], "split": case["split"], "label": case["label"], "category": case["category"], "query": case["query"]}
        if case["label"] == "answerable":
            target_scores = result["targetScores"]
            report.update({"targets": case["targets"], "targetScores": target_scores, "targetRanks": result["targetRanks"], "bestTargetRank": result["bestTargetRank"], "topHeadwords": result["topHeadwords"], "score": max(target_scores.values())})
        else:
            report.update({"score": result["maximum"], "topHeadwords": result["topHeadwords"]})
        rows.append(report)
    return rows


def answerable_quality(rows: list[dict[str, Any]]) -> dict[str, Any]:
    answerable = [row for row in rows if row["label"] == "answerable"]
    ranks = [int(row["bestTargetRank"]) for row in answerable]
    count = len(ranks)
    return {"answerableQueries": count, "hitAt1": sum(rank <= 1 for rank in ranks) / count if count else None, "hitAt3": sum(rank <= 3 for rank in ranks) / count if count else None, "meanReciprocalRank": sum(1 / rank for rank in ranks) / count if count else None}


def summarize(rows: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    positives = [row for row in rows if row["label"] == "answerable"]
    rejects = [row for row in rows if row["label"] == "reject"]
    retained = sum(row["score"] >= threshold for row in positives)
    rejected = sum(row["score"] < threshold for row in rejects)
    return {"threshold": threshold, "answerable": {"count": len(positives), "retained": retained, "retentionRate": retained / len(positives) if positives else None}, "reject": {"count": len(rejects), "rejected": rejected, "rejectionRate": rejected / len(rejects) if rejects else None}}


def calibrate(rows: list[dict[str, Any]], minimum_retention: float = 0.95) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    if not 0 < minimum_retention <= 1:
        raise ValueError("minimum retention must be from 0 exclusive through 1")
    scores = sorted({float(row["score"]) for row in rows})
    candidates = sorted(set(scores + [math.nextafter(score, math.inf) for score in scores]))
    reports = [summarize(rows, threshold) for threshold in candidates]
    feasible = [item for item in reports if item["answerable"]["retentionRate"] >= minimum_retention]
    if not feasible:
        raise ValueError("no threshold satisfies minimum answerable retention")
    selected = max(feasible, key=lambda item: (item["reject"]["rejectionRate"], item["answerable"]["retentionRate"], item["threshold"]))
    pareto = [item for item in reports if not any(other["answerable"]["retentionRate"] >= item["answerable"]["retentionRate"] and other["reject"]["rejectionRate"] >= item["reject"]["rejectionRate"] and (other["answerable"]["retentionRate"], other["reject"]["rejectionRate"]) != (item["answerable"]["retentionRate"], item["reject"]["rejectionRate"]) for other in reports)]
    return selected, pareto, reports


def embed_cases(sidecar: Sidecar, cases: list[dict[str, Any]], args: argparse.Namespace) -> tuple[np.ndarray, dict[str, Any]]:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise ValueError(f"embedding API key is required through environment variable {args.api_key_env}")
    if not args.base_url:
        raise ValueError("--base-url is required for query embedding")
    ledger = UsageLedger(None, args.input_multiplier)
    provider = OpenAIEmbeddingProvider(args.base_url, api_key, sidecar.provider_model, sidecar.dimensions, args.encoding_format, sidecar.query_extra, args.timeout_seconds, args.max_retries, args.proxy, ledger, args.allow_unmetered)
    vectors: list[np.ndarray] = []
    for start in range(0, len(cases), args.batch_size):
        inputs = [sidecar.query_template.replace("{query}", case["query"]) for case in cases[start:start + args.batch_size]]
        vectors.append(provider.embed(inputs).vectors)
    return np.vstack(vectors), ledger.snapshot()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate data or calibrate/evaluate a schema-5 semantic absolute-score threshold without using a Search API.", epilog="Examples:\n  python tools/semantic-search/calibrate_threshold.py --mode validate --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-development.json --dataset tools/semantic-search/quality-v5/threshold-holdout.json\n  python tools/semantic-search/calibrate_threshold.py --mode development --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-development.json --base-url https://embedding.example/v1\n  python tools/semantic-search/calibrate_threshold.py --mode evaluate --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-holdout.json --threshold 0.42 --base-url https://embedding.example/v1", formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=("validate", "development", "evaluate"), required=True)
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, action="append", required=True)
    parser.add_argument("--disjoint-from", type=Path, action="append", default=[])
    parser.add_argument("--scope", choices=sorted(VALID_SCOPES), action="append")
    parser.add_argument("--threshold", type=float)
    parser.add_argument("--minimum-retention", type=float, default=0.95)
    parser.add_argument("--top-headwords", type=int, default=5)
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL"))
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--encoding-format", choices=("float", "base64"), default="float")
    parser.add_argument("--allow-unmetered", action="store_true")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--input-multiplier", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=60.0)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--proxy")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.batch_size < 1 or args.top_headwords < 1 or args.timeout_seconds <= 0 or args.max_retries < 0 or args.input_multiplier <= 0:
        raise SystemExit("numeric arguments are invalid")
    if args.mode == "evaluate" and (args.threshold is None or not math.isfinite(args.threshold) or args.threshold < -1 or args.threshold > 1):
        raise SystemExit("evaluate mode requires --threshold from -1 through 1")
    if args.mode != "evaluate" and args.threshold is not None:
        raise SystemExit(f"{args.mode} mode does not accept --threshold")
    try:
        sidecar = load_sidecar(args.sidecar, args.scope or DEFAULT_SCOPES)
        expected_split = "development" if args.mode == "development" else "holdout" if args.mode == "evaluate" else None
        cases = load_cases(args.dataset, expected_split)
        validate_targets(cases, sidecar)
        validate_disjoint(cases, args.disjoint_from)
        if args.mode == "validate":
            split_counts = {split: sum(case["split"] == split for case in cases) for split in sorted(VALID_SPLITS)}
            label_counts = {label: sum(case["label"] == label for case in cases) for label in sorted(VALID_LABELS)}
            result = {
                "mode": "validate",
                "sidecar": {
                    "path": str(args.sidecar),
                    "schemaVersion": SCHEMA_VERSION,
                    "modelKey": sidecar.model_key,
                    "dimensions": sidecar.dimensions,
                    "vectors": sidecar.vector_count,
                    "scopes": list(args.scope or DEFAULT_SCOPES),
                },
                "datasets": [str(path) for path in args.dataset],
                "cases": len(cases),
                "splits": split_counts,
                "labels": label_counts,
                "providerRequests": 0,
            }
            rendered = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(rendered + "\n", encoding="utf-8")
            print(rendered)
            return
        vectors, usage = embed_cases(sidecar, cases, args)
        rows = evaluate_cases(sidecar, cases, vectors, args.top_headwords)
        result: dict[str, Any] = {"mode": args.mode, "sidecar": {"path": str(args.sidecar), "schemaVersion": SCHEMA_VERSION, "modelKey": sidecar.model_key, "thresholdCompatibility": {"modelKey": sidecar.model_key}, "dimensions": sidecar.dimensions, "providerModel": sidecar.provider_model, "queryTemplate": sidecar.query_template, "scopes": list(args.scope or DEFAULT_SCOPES)}, "providerUsage": usage, "quality": answerable_quality(rows), "rows": rows}
        if args.mode == "development":
            selected, pareto, candidates = calibrate(rows, args.minimum_retention)
            result.update({"minimumRetention": args.minimum_retention, "selected": selected, "pareto": pareto, "candidateThresholds": candidates})
        else:
            result["summary"] = {**summarize(rows, args.threshold), "quality": answerable_quality(rows)}
        rendered = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
