"""Load the canonical visible Chinese reverse-search corpus."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SCOPES = ("sense", "phrase", "form", "example", "resource")
SCOPE_BITS = {scope: 1 << index for index, scope in enumerate(SCOPES)}
SEMANTIC_ROLES = ("definition", "qualifier", "guidance", "expression", "example", "heading", "context")
RESOURCE_CATEGORIES = ("", "grammar", "express-yourself", "vocabulary-building", "synonyms", "which-word", "language-bank", "collocations", "homophones", "british-american", "more-about", "wordfinder", "help", "origin", "note", "other")
CHINESE_TEXT_NORMALIZER_VERSION = "nfkc-whitespace-v1"
RETRIEVAL_TEXT_VERSION = "normalized-chinese-v2"


@dataclass(frozen=True)
class Document:
    entry_id: str
    headword: str
    scope: str
    english_text: str
    candidate_text: str
    definition_text: str
    chinese_text: str
    semantic_role: str
    resource_category: str
    section: str
    part: str
    owner_id: str
    path_json: str
    weight: int

    def __post_init__(self) -> None:
        if self.scope not in SCOPES:
            raise ValueError(f"unsupported document scope: {self.scope!r}")
        if self.semantic_role not in SEMANTIC_ROLES:
            raise ValueError(f"unsupported document semantic role: {self.semantic_role!r}")
        if self.resource_category not in RESOURCE_CATEGORIES:
            raise ValueError(f"unsupported document resource category: {self.resource_category!r}")
        if (self.scope == "resource") != bool(self.resource_category):
            raise ValueError("resource documents require resource category and other documents must omit it")


@dataclass(frozen=True)
class Corpus:
    texts: tuple[str, ...]
    documents: dict[str, tuple[Document, ...]]
    scope_masks: dict[str, int]
    reverse_metadata: dict[str, str]
    reverse_sha256: str
    corpus_fingerprint: str
    full_text_count: int
    selected_characters: int


def retrieval_text(document: Document) -> str:
    """Return the stable text embedded for one visible search document."""
    return normalize_chinese_text(document.chinese_text)


def normalize_chinese_text(value: str) -> str:
    """Keep the vector key stable across harmless Unicode and spacing changes."""
    return " ".join(unicodedata.normalize("NFKC", value).split())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def deterministic_sample(texts: Iterable[str], count: int, seed: str) -> tuple[str, ...]:
    ordered = tuple(sorted(texts))
    if count <= 0 or count >= len(ordered):
        return ordered
    ranked = sorted(
        ordered,
        key=lambda text: hashlib.sha256((seed + "\0" + text).encode("utf-8")).digest(),
    )
    return tuple(sorted(ranked[:count]))


def load_corpus(reverse_db: Path, scopes: Iterable[str] = SCOPES, sample_size: int = 0, sample_seed: str = "lexicon-semantic-v1") -> Corpus:
    selected_scopes = tuple(scopes)
    unknown = set(selected_scopes).difference(SCOPE_BITS)
    if not selected_scopes or unknown:
        raise ValueError("scopes must be a non-empty subset of supported semantic scopes")
    if sample_size < 0:
        raise ValueError("sample size cannot be negative")
    if not reverse_db.is_file():
        raise FileNotFoundError(f"reverse-search database is missing: {reverse_db}")
    placeholders = ",".join("?" for _ in selected_scopes)
    query = f"""
        SELECT entry_id, headword, scope, english_text, candidate_text, definition_text,
               chinese_text, semantic_role, resource_category, section, part,
               owner_id, path_json, weight
        FROM documents
        WHERE scope IN ({placeholders}) AND trim(chinese_text) <> ''
        ORDER BY chinese_text, scope, weight DESC, entry_id, id
    """
    grouped: dict[str, list[Document]] = {}
    masks: dict[str, int] = {}
    uri = reverse_db.resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        metadata = {str(key): str(value) for key, value in db.execute("SELECT key, value FROM metadata")}
        for row in db.execute(query, selected_scopes):
            document = Document(*(str(value) for value in row[:-1]), int(row[-1]))
            text = retrieval_text(document)
            if not text:
                continue
            grouped.setdefault(text, []).append(document)
            masks[text] = masks.get(text, 0) | SCOPE_BITS[document.scope]
    finally:
        db.close()
    all_texts = tuple(sorted(grouped))
    texts = deterministic_sample(all_texts, sample_size, sample_seed)
    documents = {text: tuple(grouped[text]) for text in texts}
    selected_masks = {text: masks[text] for text in texts}
    fingerprint_payload = {
        "texts": texts,
        "scopes": selected_scopes,
        "reverse_sha256": sha256_file(reverse_db),
        "projection_version": metadata.get("projection_version"),
        "retrieval_text_version": RETRIEVAL_TEXT_VERSION,
        "sample_seed": sample_seed,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return Corpus(
        texts=texts,
        documents=documents,
        scope_masks=selected_masks,
        reverse_metadata=metadata,
        reverse_sha256=fingerprint_payload["reverse_sha256"],
        corpus_fingerprint=fingerprint,
        full_text_count=len(all_texts),
        selected_characters=sum(len(text) for text in texts),
    )


def report(corpus: Corpus) -> dict[str, object]:
    return {
        "uniqueTexts": len(corpus.texts),
        "fullUniqueTexts": corpus.full_text_count,
        "documents": sum(len(value) for value in corpus.documents.values()),
        "characters": corpus.selected_characters,
        "retrievalTextVersion": RETRIEVAL_TEXT_VERSION,
        "scopeMasks": {scope: sum(bool(mask & bit) for mask in corpus.scope_masks.values()) for scope, bit in SCOPE_BITS.items()},
        "corpusFingerprint": corpus.corpus_fingerprint,
        "reverseSearchSha256": corpus.reverse_sha256,
        "projectionVersion": corpus.reverse_metadata.get("projection_version"),
    }
