"""Write the immutable SQLite sidecar consumed by the Go semantic runtime."""

from __future__ import annotations

import math
import os
import sqlite3
import struct
import tempfile
from pathlib import Path
from typing import Iterable

from corpus import Corpus, sha256_file


SCHEMA_VERSION = "1"
QUANTIZATION = "symmetric-int8-127"
PROJECTION_VERSION = "1.0"


def quantize(vector: Iterable[float]) -> bytes:
    values = []
    for value in vector:
        if not math.isfinite(value):
            raise ValueError("cannot quantize non-finite vector")
        values.append(max(-127, min(127, int(round(value * 127.0)))))
    return struct.pack("b" * len(values), *values)


def write_sidecar(path: Path, corpus: Corpus, vectors: Iterable[list[float]], dimensions: int, primary_db: Path, model_key: str, query_template: str, block_size: int = 4096) -> dict[str, str]:
    if dimensions < 1 or block_size < 1:
        raise ValueError("sidecar vectors or dimensions are invalid")
    if query_template.count("{query}") != 1 or any(token in query_template.replace("{query}", "") for token in "{}"):
        raise ValueError("query template must contain exactly one {query} placeholder")
    if not primary_db.is_file():
        raise FileNotFoundError(f"primary database is missing: {primary_db}")
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "primary_sha256": sha256_file(primary_db),
        "reverse_search_sha256": corpus.reverse_sha256,
        "projection_version": PROJECTION_VERSION,
        "model_key": model_key,
        "dimensions": str(dimensions),
        "normalization": "l2",
        "quantization": QUANTIZATION,
        "vector_count": str(len(corpus.texts)),
        "block_size": str(block_size),
        "query_template": query_template,
        "corpus_fingerprint": corpus.corpus_fingerprint,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        db = sqlite3.connect(temporary)
        try:
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
                db.executemany(
                    "INSERT INTO documents(text_id, entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [(text_id, item.entry_id, item.headword, item.scope, item.english_text, item.chinese_text, item.section, item.part, item.owner_id, item.path_json, item.weight) for item in corpus.documents[text]],
                )
            vector_iterator = iter(vectors)
            for first in range(0, len(corpus.texts), block_size):
                count = min(block_size, len(corpus.texts) - first)
                chunk = []
                for _ in range(count):
                    try:
                        chunk.append(next(vector_iterator))
                    except StopIteration as error:
                        raise ValueError("sidecar vector count is too small") from error
                blob = b"".join(quantize(vector) for vector in chunk)
                if len(blob) != len(chunk) * dimensions:
                    raise ValueError("sidecar vector dimension changed")
                db.execute("INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (?, ?, ?, ?)", (first // block_size, first, len(chunk), blob))
            try:
                next(vector_iterator)
            except StopIteration:
                pass
            else:
                raise ValueError("sidecar vector count is too large")
            db.execute("PRAGMA optimize")
            db.commit()
        finally:
            db.close()
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return metadata
