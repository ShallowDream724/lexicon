"""Evaluate float16 cache and int8 sidecar vectors against quality JSON."""

from __future__ import annotations

import json
import heapq
import math
import struct
from pathlib import Path
from typing import Callable, Iterable

from corpus import Corpus
from sidecar import quantize


def load_quality(path: Path) -> list[dict[str, object]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("quality JSON must be an array")
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get("query"), str) or not isinstance(row.get("mustHit"), list):
            raise ValueError("quality row requires query and mustHit")
    return value


def dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def rank(corpus: Corpus, vectors: Iterable[list[float]], query: list[float], expected: set[str], top_k: int) -> int | None:
    scores = heapq.nlargest(top_k * 16, ((dot(vector, query), index) for index, vector in enumerate(vectors)))
    seen: set[str] = set()
    position = 0
    for _, index in scores:
        for document in corpus.documents[corpus.texts[index]]:
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


def evaluate(corpus: Corpus, vectors: Callable[[], Iterable[list[float]]], query_embed: Callable[[list[str]], list[list[float]]], cases: list[dict[str, object]], query_template: str, top_k: int) -> dict[str, object]:
    queries = [query_template.replace("{query}", str(item["query"])) for item in cases]
    query_vectors = query_embed(queries)
    float_ranks, int8_ranks, rows = [], [], []
    for item, query in zip(cases, query_vectors, strict=True):
        expected = {str(value).casefold() for value in item["mustHit"]}
        float_rank = rank(corpus, vectors(), query, expected, top_k)
        int8_rank = rank(corpus, ([value / 127.0 for value in struct.unpack("b" * len(vector), quantize(vector))] for vector in vectors()), query, expected, top_k)
        float_ranks.append(float_rank)
        int8_ranks.append(int8_rank)
        rows.append({"query": item["query"], "mustHit": item["mustHit"], "float16Rank": float_rank, "int8Rank": int8_rank})
    return {"queryTemplate": query_template, "float16": summarize(float_ranks, top_k), "int8": summarize(int8_ranks, top_k), "rows": rows}
