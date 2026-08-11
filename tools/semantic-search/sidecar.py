"""Write the immutable SQLite sidecar consumed by the Go semantic runtime."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from corpus import CHINESE_TEXT_NORMALIZER_VERSION, Corpus, RETRIEVAL_TEXT_VERSION, SCOPES, normalize_chinese_text, sha256_file


BUILDER_VERSION = "semantic-builder-v6"
PROJECTION_VERSION = "2.2"
QUANTIZATION = "symmetric-int8-127"
SCHEMA_VERSION = "5"


def quantize_block(vectors: np.ndarray) -> np.ndarray:
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2 or not np.isfinite(array).all():
        raise ValueError("cannot quantize invalid vectors")
    return np.rint(np.clip(array * 127.0, -127.0, 127.0)).astype(np.int8)


def _stored_text_column(source: sqlite3.Connection) -> str:
    columns = {str(row[1]) for row in source.execute("PRAGMA table_info(texts)")}
    if "normalized_chinese_text" in columns:
        return "normalized_chinese_text"
    if "embedding_text" in columns:  # Schema 4 and older sources.
        return "embedding_text"
    if "chinese_text" in columns:
        return "chinese_text"
    raise ValueError("reusable semantic texts table has no supported text column")


def _open_reusable_sidecar(path: Path, dimensions: int, model_key: str, provider_model: str, document_extra: dict[str, Any]) -> tuple[sqlite3.Connection, dict[str, int], int]:
    if not path.is_file():
        raise FileNotFoundError(f"reusable semantic sidecar is missing: {path}")
    source = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        metadata = {str(key): str(value) for key, value in source.execute("SELECT key, value FROM metadata")}
        expected = {
            "model_key": model_key,
            "provider_model": provider_model,
            "dimensions": str(dimensions),
            "normalization": "l2",
            "quantization": QUANTIZATION,
            "document_extra_json": json.dumps(document_extra, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        }
        for key, value in expected.items():
            if metadata.get(key) != value:
                raise ValueError(f"reusable semantic sidecar metadata {key!r} does not match")
        try:
            source_block_size = int(metadata["block_size"])
            vector_count = int(metadata["vector_count"])
        except (KeyError, ValueError) as error:
            raise ValueError("reusable semantic sidecar vector metadata is invalid") from error
        if source_block_size < 1 or vector_count < 0:
            raise ValueError("reusable semantic sidecar vector metadata is invalid")
        text_ids: dict[str, int] = {}
        ambiguous_texts: set[str] = set()
        text_column = _stored_text_column(source)
        source_text_count = 0
        for expected_id, row in enumerate(source.execute(f"SELECT id, {text_column} FROM texts ORDER BY id")):
            text_id, raw_text = int(row[0]), str(row[1])
            text = normalize_chinese_text(raw_text)
            if text_id != expected_id or not text:
                raise ValueError("reusable semantic texts are invalid")
            if text in text_ids:
                ambiguous_texts.add(text)
            else:
                text_ids[text] = text_id
            source_text_count += 1
        for text in ambiguous_texts:
            del text_ids[text]
        if source_text_count != vector_count:
            raise ValueError("reusable semantic sidecar vector count does not match texts")
        expected_block = expected_first = 0
        for block_index, first_vector_id, count, data in source.execute("SELECT block_index, first_vector_id, vector_count, data FROM vector_blocks ORDER BY block_index"):
            expected_count = min(source_block_size, vector_count - expected_first)
            if block_index != expected_block or first_vector_id != expected_first or count != expected_count or len(data) != count * dimensions:
                raise ValueError("reusable semantic vector block is invalid")
            expected_block += 1
            expected_first += count
        if expected_first != vector_count:
            raise ValueError("reusable semantic vector blocks are incomplete")
        return source, text_ids, source_block_size
    except BaseException:
        source.close()
        raise


def reusable_texts(path: Path, dimensions: int, model_key: str, provider_model: str, document_extra: dict[str, Any]) -> frozenset[str]:
    source, text_ids, _ = _open_reusable_sidecar(path, dimensions, model_key, provider_model, document_extra)
    try:
        return frozenset(text_ids)
    finally:
        source.close()


def _reusable_vector(source: sqlite3.Connection, text_id: int, source_block_size: int, dimensions: int, cache: dict[int, bytes]) -> bytes:
    block_index = text_id // source_block_size
    data = cache.get(block_index)
    if data is None:
        row = source.execute("SELECT first_vector_id, vector_count, data FROM vector_blocks WHERE block_index = ?", (block_index,)).fetchone()
        if row is None:
            raise ValueError("reusable semantic vector block is missing")
        first_vector_id, count, data = row
        if first_vector_id != block_index * source_block_size or count < 1 or len(data) != count * dimensions:
            raise ValueError("reusable semantic vector block is invalid")
        data = bytes(data)
        cache[block_index] = data
    offset = (text_id % source_block_size) * dimensions
    return data[offset:offset + dimensions]


def write_sidecar(path: Path, corpus: Corpus, vectors: np.ndarray | None, dimensions: int, primary_db: Path, model_key: str, provider_model: str, query_template: str, document_extra: dict[str, Any], query_extra: dict[str, Any], minimum_score: float, block_size: int = 4096, reuse_vectors_from: Path | None = None) -> dict[str, str]:
    if dimensions < 1 or block_size < 1 or (vectors is None and reuse_vectors_from is None):
        raise ValueError("sidecar vectors or dimensions are invalid")
    if vectors is not None and vectors.shape != (len(corpus.texts), dimensions):
        raise ValueError("sidecar vectors or dimensions are invalid")
    if query_template.count("{query}") != 1 or any(token in query_template.replace("{query}", "") for token in "{}"):
        raise ValueError("query template must contain exactly one {query} placeholder")
    if not np.isfinite(minimum_score) or minimum_score < -1 or minimum_score > 1:
        raise ValueError("minimum semantic score must be finite and between -1 and 1")
    if not primary_db.is_file():
        raise FileNotFoundError(f"primary database is missing: {primary_db}")
    scopes = [scope for scope in SCOPES if any(document.scope == scope for documents in corpus.documents.values() for document in documents)]
    reusable = _open_reusable_sidecar(reuse_vectors_from, dimensions, model_key, provider_model, document_extra) if reuse_vectors_from else None
    reusable_ids = reusable[1] if reusable else {}
    reused_count = sum(text in reusable_ids for text in corpus.texts)
    new_count = len(corpus.texts) - reused_count
    if new_count and vectors is None:
        if reusable is not None:
            reusable[0].close()
        raise ValueError("new semantic texts require vectors")
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "primary_sha256": sha256_file(primary_db),
        "reverse_search_sha256": corpus.reverse_sha256,
        "projection_version": PROJECTION_VERSION,
        "model_key": model_key,
        "provider_model": provider_model,
        "dimensions": str(dimensions),
        "normalization": "l2",
        "quantization": QUANTIZATION,
        "vector_count": str(len(corpus.texts)),
        "reused_vector_count": str(reused_count),
        "new_vector_count": str(new_count),
        "document_count": str(sum(len(documents) for documents in corpus.documents.values())),
        "scope_set": ",".join(scopes),
        "block_size": str(block_size),
        "query_template": query_template,
        "minimum_score": format(float(minimum_score), ".9g"),
        "document_extra_json": json.dumps(document_extra, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        "query_extra_json": json.dumps(query_extra, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        "corpus_fingerprint": corpus.corpus_fingerprint,
        "source_schema_version": corpus.reverse_metadata.get("schema_version", ""),
        "source_projection_version": corpus.reverse_metadata.get("projection_version", ""),
        "source_normalizer_version": corpus.reverse_metadata.get("normalizer_version", ""),
        "builder_version": BUILDER_VERSION,
        "retrieval_text_version": RETRIEVAL_TEXT_VERSION,
        "text_normalizer_version": CHINESE_TEXT_NORMALIZER_VERSION,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        db = sqlite3.connect(temporary)
        try:
            db.execute("PRAGMA page_size = 8192")
            db.executescript("""
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE texts (id INTEGER PRIMARY KEY, normalized_chinese_text TEXT NOT NULL UNIQUE, scope_mask INTEGER NOT NULL);
                CREATE TABLE documents (text_id INTEGER NOT NULL, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('sense', 'phrase', 'form', 'example', 'resource')), semantic_role TEXT NOT NULL CHECK(semantic_role IN ('definition', 'qualifier', 'guidance', 'expression', 'example', 'heading', 'context')), resource_category TEXT NOT NULL CHECK(resource_category IN ('', 'grammar', 'express-yourself', 'vocabulary-building', 'synonyms', 'which-word', 'language-bank', 'collocations', 'homophones', 'british-american', 'more-about', 'wordfinder', 'help', 'origin', 'note', 'other')), english_text TEXT NOT NULL, candidate_text TEXT NOT NULL, definition_text TEXT NOT NULL, chinese_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL);
                CREATE INDEX documents_text_id ON documents(text_id);
                CREATE TABLE vector_blocks (block_index INTEGER PRIMARY KEY, first_vector_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, data BLOB NOT NULL);
            """)
            db.executemany("INSERT INTO metadata(key, value) VALUES (?, ?)", sorted(metadata.items()))
            for text_id, text in enumerate(corpus.texts):
                db.execute("INSERT INTO texts(id, normalized_chinese_text, scope_mask) VALUES (?, ?, ?)", (text_id, text, corpus.scope_masks[text]))
                db.executemany("INSERT INTO documents(text_id, entry_id, headword, scope, semantic_role, resource_category, english_text, candidate_text, definition_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [(text_id, item.entry_id, item.headword, item.scope, item.semantic_role, item.resource_category, item.english_text, item.candidate_text, item.definition_text, item.chinese_text, item.section, item.part, item.owner_id, item.path_json, item.weight) for item in corpus.documents[text]])
            reusable_source = reusable[0] if reusable else None
            source_block_size = reusable[2] if reusable else 0
            source_block_cache: dict[int, bytes] = {}
            for first in range(0, len(corpus.texts), block_size):
                count = min(block_size, len(corpus.texts) - first)
                data = bytearray(quantize_block(vectors[first:first + count]).tobytes(order="C") if vectors is not None else count * dimensions)
                if reusable_source is not None:
                    for offset, text in enumerate(corpus.texts[first:first + count]):
                        source_id = reusable_ids.get(text)
                        if source_id is not None:
                            start = offset * dimensions
                            data[start:start + dimensions] = _reusable_vector(reusable_source, source_id, source_block_size, dimensions, source_block_cache)
                db.execute("INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (?, ?, ?, ?)", (first // block_size, first, count, data))
            db.commit()
            db.execute("VACUUM")
        finally:
            db.close()
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        if reusable is not None:
            reusable[0].close()
    return metadata
