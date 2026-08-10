from __future__ import annotations

import base64
import json
import sqlite3
import struct
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import build
from corpus import SCOPE_BITS, load_corpus
from evaluation import evaluate
from provider import OpenAIEmbeddingProvider, ProviderError, UsageLedger
from sidecar import write_sidecar


def make_reverse(path: Path) -> None:
    db = sqlite3.connect(path)
    try:
        db.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE documents (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, english_text TEXT NOT NULL, chinese_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL);
        """)
        db.executemany("INSERT INTO metadata VALUES (?, ?)", [("projection_version", "1.2"), ("schema_version", "3")])
        db.executemany("INSERT INTO documents(entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
            ("a", "alpha", "sense", "one", "共同文本", "definitions", "n", "a", "[]", 10),
            ("a", "alpha", "phrase", "two", "共同文本", "idioms", "n", "a", "[]", 9),
            ("b", "beta", "usage", "three", "其他文本", "grammar-usage", "v", "b", "[]", 8),
        ])
        db.commit()
    finally:
        db.close()


class EmbeddingHandler(BaseHTTPRequestHandler):
    request: dict[str, object] = {}
    base64_mode = False
    tokens = 3

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        type(self).request = json.loads(body)
        inputs = type(self).request["input"]
        data = []
        for index, _ in enumerate(inputs):
            vector = [3.0, 4.0]
            embedding: object = vector
            if type(self).base64_mode:
                embedding = base64.b64encode(struct.pack("<ff", *vector)).decode("ascii")
            data.append({"index": index, "embedding": embedding})
        encoded = json.dumps({"data": data, "usage": {"prompt_tokens": type(self).tokens}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_: object) -> None:
        pass


class SemanticBuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.reverse = self.root / "reverse.db"
        self.primary = self.root / "dictionary.db"
        make_reverse(self.reverse)
        self.primary.write_bytes(b"primary")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_corpus_dedup_scope_and_deterministic_sample(self) -> None:
        corpus = load_corpus(self.reverse, ("sense", "phrase", "usage"), 1, "seed")
        self.assertEqual(len(corpus.texts), 1)
        full = load_corpus(self.reverse)
        self.assertEqual(len(full.texts), 2)
        self.assertEqual(full.scope_masks["共同文本"], SCOPE_BITS["sense"] | SCOPE_BITS["phrase"])
        self.assertEqual(load_corpus(self.reverse, sample_size=1, sample_seed="seed").texts, corpus.texts)

    def test_provider_float_and_base64_and_budget(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), EmbeddingHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def close_server() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)
        self.addCleanup(close_server)
        url = f"http://127.0.0.1:{server.server_port}"
        for base64_mode in (False, True):
            EmbeddingHandler.base64_mode = base64_mode
            ledger = UsageLedger(None, 1.0)
            result = OpenAIEmbeddingProvider(url, "secret", "model", 2, "base64" if base64_mode else "float", {"truncate": True}, ledger=ledger).embed(["one", "two"])
            self.assertEqual(result.vectors[0], [0.6, 0.8])
            self.assertEqual(EmbeddingHandler.request["dimensions"], 2)
            self.assertTrue(EmbeddingHandler.request["truncate"])
        EmbeddingHandler.tokens = 3
        with self.assertRaises(ProviderError):
            OpenAIEmbeddingProvider(url, "secret", "model", 2, ledger=UsageLedger(2, 1.0)).embed(["one"])

    def test_checkpoint_resume_and_sidecar_contract(self) -> None:
        corpus = load_corpus(self.reverse)
        output = self.root / "out"
        args = SimpleNamespace(output_dir=output, dimensions=2, rebuild=False, max_weighted_units=None, input_multiplier=1.0, batch_size=1, concurrency=1, base_url="http://unused", api_key_env="NO_KEY", provider_model="m", encoding_format="float", provider_extra={}, timeout_seconds=1.0, max_retries=0, proxy=None)
        fingerprint = build.build_fingerprint(corpus, self.primary, "key", "m", 2, "Q: {query}", {})
        calls: list[str] = []
        class FailingProvider:
            def embed(self, texts: list[str]):
                calls.extend(texts)
                if len(calls) > 1:
                    raise ProviderError("interrupted")
                return SimpleNamespace(vectors=[[1.0, 0.0] for _ in texts], prompt_tokens=1)
        original = build._provider_from_args
        build._provider_from_args = lambda *_: FailingProvider()
        try:
            with self.assertRaises(ProviderError):
                build.build_cached_vectors(args, corpus, fingerprint)
        finally:
            build._provider_from_args = original
        checkpoint = json.loads((output / "checkpoint.json").read_text())
        self.assertEqual(checkpoint["completed"], [True, False])
        resumed: list[str] = []
        class Provider:
            def embed(self, texts: list[str]):
                resumed.extend(texts)
                return SimpleNamespace(vectors=[[0.0, 1.0] for _ in texts], prompt_tokens=1)
        build._provider_from_args = lambda *_: Provider()
        try:
            vectors_path, _ = build.build_cached_vectors(args, corpus, fingerprint)
        finally:
            build._provider_from_args = original
        self.assertEqual(len(resumed), 1)
        vectors = build.read_vectors(vectors_path, len(corpus.texts), 2)
        self.assertEqual(vectors, [[1.0, 0.0], [0.0, 1.0]])
        sidecar = output / "semantic.db"
        metadata = write_sidecar(sidecar, corpus, iter(vectors), 2, self.primary, "key", "Q: {query}", 1)
        self.assertEqual(metadata["projection_version"], "1.0")
        db = sqlite3.connect(sidecar)
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM texts").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM vector_blocks").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='query_template'").fetchone()[0], "Q: {query}")
        finally:
            db.close()

    def test_fingerprint_and_template_validation(self) -> None:
        corpus = load_corpus(self.reverse)
        first = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Q: {query}", {})
        second = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Other: {query}", {})
        self.assertNotEqual(first, second)
        with self.assertRaises(ValueError):
            write_sidecar(self.root / "bad.db", corpus, [[1.0, 0.0], [0.0, 1.0]], 2, self.primary, "key", "{query}{query}")

    def test_quality_compares_float16_and_int8(self) -> None:
        corpus = load_corpus(self.reverse)
        vectors = [[1.0, 0.0], [0.0, 1.0]]
        result = evaluate(corpus, lambda: iter(vectors), lambda _: [[1.0, 0.0]], [{"query": "first", "mustHit": ["alpha"]}], "Q: {query}", 4)
        self.assertEqual(result["float16"]["hitAt1"], 1.0)
        self.assertEqual(result["int8"]["hitAt1"], 1.0)


if __name__ == "__main__":
    unittest.main()
