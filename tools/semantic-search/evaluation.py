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


def _scores(matrix: np.memmap, query: np.ndarray, runtime_int8: bool, block_size: int = 8192) -> np.ndarray:
    values = np.empty(matrix.shape[0], dtype=np.int32 if runtime_int8 else np.float32)
    if runtime_int8:
        query_i8 = quantize_block(query.reshape(1, -1))[0].astype(np.int32)
        for start in range(0, len(matrix), block_size):
            block = quantize_block(matrix[start:start + block_size]).astype(np.int32)
            values[start:start + len(block)] = block @ query_i8
    else:
        query_f32 = np.asarray(query, dtype=np.float32)
        for start in range(0, len(matrix), block_size):
            block = np.asarray(matrix[start:start + block_size], dtype=np.float32)
            values[start:start + len(block)] = block @ query_f32
    return values


def rank(corpus: Corpus, matrix: np.memmap, query: np.ndarray, expected: set[str], top_k: int, runtime_int8: bool) -> int | None:
    # Stable sort makes score ties deterministic by text ID, matching sidecar order.
    order = np.argsort(-_scores(matrix, query, runtime_int8), kind="stable")
    seen: set[str] = set()
    position = 0
    for index in order:
        for document in corpus.documents[corpus.texts[int(index)]]:
            if document.entry_id in seen:
                continue
            seen.add(document.entry_id)
            position += 1
            if document.headword.casefold() in expected:
                return position
            if position >= top_k:
                return None
    return None


def summarize(ranks: list[int | None], top_k: int) -> dict[str, float | int]:
    count = len(ranks) or 1
    found = [rank for rank in ranks if rank is not None]
    return {"queries": len(ranks), "hitAt1": sum(rank == 1 for rank in found) / count, "recallAtK": len(found) / count, "meanReciprocalRank": sum(1.0 / rank for rank in found) / count, "topK": top_k}


def evaluate(corpus: Corpus, matrix: np.memmap, query_embed: Callable[[list[str]], np.ndarray], cases: list[dict[str, object]], query_template: str, top_k: int) -> dict[str, object]:
    queries = [query_template.replace("{query}", str(item["query"])) for item in cases]
    query_vectors = np.asarray(query_embed(queries), dtype=np.float32)
    if query_vectors.shape != (len(cases), matrix.shape[1]):
        raise ValueError("quality query vectors do not match cached vector dimensions")
    float_ranks, int8_ranks, rows = [], [], []
    for item, query in zip(cases, query_vectors, strict=True):
        expected = {str(value).casefold() for value in item["mustHit"]}
        float_rank = rank(corpus, matrix, query, expected, top_k, False)
        int8_rank = rank(corpus, matrix, query, expected, top_k, True)
        float_ranks.append(float_rank)
        int8_ranks.append(int8_rank)
        rows.append({"query": item["query"], "mustHit": item["mustHit"], "float16Rank": float_rank, "runtimeInt8Rank": int8_rank})
    return {"queryTemplate": query_template, "float16": summarize(float_ranks, top_k), "runtimeInt8": summarize(int8_ranks, top_k), "rows": rows}
