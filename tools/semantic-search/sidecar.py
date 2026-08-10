"""Write the immutable SQLite sidecar consumed by the Go semantic runtime."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from corpus import Corpus, SCOPES, sha256_file


BUILDER_VERSION = "semantic-builder-v2"
PROJECTION_VERSION = "1.0"
QUANTIZATION = "symmetric-int8-127"
SCHEMA_VERSION = "1"


def quantize_block(vectors: np.ndarray) -> np.ndarray:
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2 or not np.isfinite(array).all():
        raise ValueError("cannot quantize invalid vectors")
    return np.rint(np.clip(array * 127.0, -127.0, 127.0)).astype(np.int8)


def write_sidecar(path: Path, corpus: Corpus, vectors: np.ndarray, dimensions: int, primary_db: Path, model_key: str, provider_model: str, query_template: str, document_extra: dict[str, Any], query_extra: dict[str, Any], block_size: int = 4096) -> dict[str, str]:
    if dimensions < 1 or block_size < 1 or vectors.shape != (len(corpus.texts), dimensions):
        raise ValueError("sidecar vectors or dimensions are invalid")
    if query_template.count("{query}") != 1 or any(token in query_template.replace("{query}", "") for token in "{}"):
        raise ValueError("query template must contain exactly one {query} placeholder")
    if not primary_db.is_file():
        raise FileNotFoundError(f"primary database is missing: {primary_db}")
    scopes = [scope for scope in SCOPES if any(document.scope == scope for documents in corpus.documents.values() for document in documents)]
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
        "document_count": str(sum(len(documents) for documents in corpus.documents.values())),
        "scope_set": ",".join(scopes),
        "block_size": str(block_size),
        "query_template": query_template,
        "document_extra_json": json.dumps(document_extra, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        "query_extra_json": json.dumps(query_extra, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        "corpus_fingerprint": corpus.corpus_fingerprint,
        "source_schema_version": corpus.reverse_metadata.get("schema_version", ""),
        "source_projection_version": corpus.reverse_metadata.get("projection_version", ""),
        "source_normalizer_version": corpus.reverse_metadata.get("normalizer_version", ""),
        "builder_version": BUILDER_VERSION,
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
                CREATE TABLE texts (id INTEGER PRIMARY KEY, chinese_text TEXT NOT NULL UNIQUE, scope_mask INTEGER NOT NULL);
                CREATE TABLE documents (text_id INTEGER NOT NULL, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, english_text TEXT NOT NULL, chinese_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL);
                CREATE INDEX documents_text_id ON documents(text_id);
                CREATE TABLE vector_blocks (block_index INTEGER PRIMARY KEY, first_vector_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, data BLOB NOT NULL);
            """)
            db.executemany("INSERT INTO metadata(key, value) VALUES (?, ?)", sorted(metadata.items()))
            for text_id, text in enumerate(corpus.texts):
                db.execute("INSERT INTO texts(id, chinese_text, scope_mask) VALUES (?, ?, ?)", (text_id, text, corpus.scope_masks[text]))
                db.executemany("INSERT INTO documents(text_id, entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [(text_id, item.entry_id, item.headword, item.scope, item.english_text, item.chinese_text, item.section, item.part, item.owner_id, item.path_json, item.weight) for item in corpus.documents[text]])
            for first in range(0, len(corpus.texts), block_size):
                block = quantize_block(vectors[first:first + block_size])
                db.execute("INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (?, ?, ?, ?)", (first // block_size, first, len(block), block.tobytes(order="C")))
            db.commit()
            db.execute("VACUUM")
        finally:
            db.close()
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return metadata
