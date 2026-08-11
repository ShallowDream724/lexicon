"""Memory-bounded quality evaluation for float16 and runtime int8 vectors."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np

from corpus import Corpus
from sidecar import quantize_block


def load_quality(paths: list[Path]) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    queries: set[str] = set()
    for path in paths:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            raise ValueError(f"quality JSON must be an array: {path}")
        for row in value:
            if not isinstance(row, dict) or not isinstance(row.get("query"), str) or not row["query"].strip():
                raise ValueError(f"quality row requires a non-empty query: {path}")
            targets = row.get("mustHit")
            if not isinstance(targets, list) or not targets or not all(isinstance(value, str) and value.strip() for value in targets):
                raise ValueError(f"quality row requires non-empty string mustHit targets: {path}")
            if row["query"] in queries:
                raise ValueError(f"duplicate quality query: {row['query']}")
            queries.add(row["query"])
            cases.append(row)
    return cases


def score_matrices(matrix: np.memmap, queries: np.ndarray, block_size: int = 8192) -> tuple[np.ndarray, np.ndarray]:
    """Compute all float and runtime-int8 query scores in one document pass."""
    query_f32 = np.asarray(queries, dtype=np.float32)
    if query_f32.ndim != 2 or query_f32.shape[1] != matrix.shape[1]:
        raise ValueError("quality query vectors do not match cached vector dimensions")
    float_scores = np.empty((matrix.shape[0], query_f32.shape[0]), dtype=np.float32)
    int8_scores = np.empty((matrix.shape[0], query_f32.shape[0]), dtype=np.int32)
    query_i8 = quantize_block(query_f32).astype(np.int32)
    for start in range(0, len(matrix), block_size):
        end = min(start + block_size, len(matrix))
        document_f32 = np.asarray(matrix[start:end], dtype=np.float32)
        float_scores[start:end] = document_f32 @ query_f32.T
        document_i8 = quantize_block(matrix[start:end]).astype(np.int32)
        int8_scores[start:end] = document_i8 @ query_i8.T
    return float_scores, int8_scores


def rank_targets(corpus: Corpus, scores: np.ndarray, expected: set[str], top_k: int) -> dict[str, int]:
    # Stable sort makes score ties deterministic by text ID, matching sidecar order.
    order = np.argsort(-scores, kind="stable")
    seen: set[str] = set()
    found: dict[str, int] = {}
    position = 0
    for index in order:
        for document in corpus.documents[corpus.texts[int(index)]]:
            if document.entry_id in seen:
                continue
            seen.add(document.entry_id)
            position += 1
            headword = document.headword.casefold()
            if headword in expected and headword not in found:
                found[headword] = position
            if position >= top_k:
                return found
    return found


def summarize(
    ranks: list[dict[str, int]],
    expected: list[set[str]],
    top_k: int,
) -> dict[str, object]:
    count = len(ranks) or 1
    cutoffs = tuple(sorted({cutoff for cutoff in (1, 3, 8, top_k) if cutoff <= top_k}))
    first_ranks = [min(row.values()) if row else None for row in ranks]
    hit_at = {
        str(cutoff): sum(rank is not None and rank <= cutoff for rank in first_ranks) / count
        for cutoff in cutoffs
    }
    labeled_target_recall_at = {
        str(cutoff): sum(
            sum(rank <= cutoff for rank in row.values()) / len(targets)
            for row, targets in zip(ranks, expected, strict=True)
        ) / count
        for cutoff in cutoffs
    }
    return {
        "queries": len(ranks),
        "cutoffs": list(cutoffs),
        "hitAtK": hit_at,
        "labeledTargetRecallAtK": labeled_target_recall_at,
        "meanReciprocalRank": sum(1.0 / rank for rank in first_ranks if rank is not None) / count,
    }


def evaluate(corpus: Corpus, matrix: np.memmap, query_embed: Callable[[list[str]], np.ndarray], cases: list[dict[str, object]], query_template: str, top_k: int) -> dict[str, object]:
    queries = [query_template.replace("{query}", str(item["query"])) for item in cases]
    query_vectors = np.asarray(query_embed(queries), dtype=np.float32)
    float_scores, int8_scores = score_matrices(matrix, query_vectors)
    float_ranks: list[dict[str, int]] = []
    int8_ranks: list[dict[str, int]] = []
    expected_rows: list[set[str]] = []
    rows = []
    for index, item in enumerate(cases):
        expected = {str(value).casefold() for value in item["mustHit"]}
        float_target_ranks = rank_targets(corpus, float_scores[:, index], expected, top_k)
        int8_target_ranks = rank_targets(corpus, int8_scores[:, index], expected, top_k)
        float_ranks.append(float_target_ranks)
        int8_ranks.append(int8_target_ranks)
        expected_rows.append(expected)
        rows.append({
            "query": item["query"],
            "mustHit": item["mustHit"],
            "float16TargetRanks": float_target_ranks,
            "runtimeInt8TargetRanks": int8_target_ranks,
        })
    return {
        "queryTemplate": query_template,
        "float16": summarize(float_ranks, expected_rows, top_k),
        "runtimeInt8": summarize(int8_ranks, expected_rows, top_k),
        "rows": rows,
    }
