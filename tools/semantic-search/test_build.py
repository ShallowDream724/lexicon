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

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import build
from corpus import SCOPE_BITS, load_corpus
from evaluation import evaluate, load_quality
from provider import OpenAIEmbeddingProvider, ProviderError, UsageLedger
from sidecar import quantize_block, write_sidecar


def make_reverse(path: Path) -> None:
    db = sqlite3.connect(path)
    try:
        db.executescript("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE documents (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, english_text TEXT NOT NULL, chinese_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL);")
        db.executemany("INSERT INTO metadata VALUES (?, ?)", [("projection_version", "1.2"), ("schema_version", "3"), ("normalizer_version", "nfkc")])
        rows = [("a", "alpha", "sense", "one", "共同文本", "definitions", "n", "a", "[]", 10), ("a", "alpha", "phrase", "two", "共同文本", "idioms", "n", "a", "[]", 9), ("b", "beta", "usage", "three", "其他文本", "grammar-usage", "v", "b", "[]", 8), ("c", "gamma", "example", "four", "第三文本", "definitions", "n", "c", "[]", 7), ("d", "delta", "sense", "five", "第四文本", "definitions", "n", "d", "[]", 6), ("e", "epsilon", "form", "six", "第五文本", "derived-forms", "n", "e", "[]", 5)]
        db.executemany("INSERT INTO documents(entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        db.commit()
    finally:
        db.close()


class EmbeddingHandler(BaseHTTPRequestHandler):
    request: dict[str, object] = {}
    base64_mode = False
    tokens: int | None = 3

    def do_POST(self) -> None:  # noqa: N802
        type(self).request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        data = []
        for index, _ in enumerate(type(self).request["input"]):
            value: object = [3.0, 4.0]
            if type(self).base64_mode:
                value = base64.b64encode(struct.pack("<ff", 3.0, 4.0)).decode("ascii")
            data.append({"index": index, "embedding": value})
        response: dict[str, object] = {"data": data}
        if type(self).tokens is not None:
            response["usage"] = {"prompt_tokens": type(self).tokens}
        encoded = json.dumps(response).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)

    def log_message(self, *_: object) -> None:
        pass


class SemanticBuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.reverse = self.root / "reverse.db"; self.primary = self.root / "dictionary.db"
        make_reverse(self.reverse); self.primary.write_bytes(b"primary")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def args(self, output: Path, concurrency: int = 2) -> SimpleNamespace:
        return SimpleNamespace(output_dir=output, dimensions=2, rebuild=False, max_weighted_units=None, input_multiplier=1.0, budget_safety_factor=1.15, batch_size=1, concurrency=concurrency, base_url="http://unused", api_key_env="NO_KEY", provider_model="m", encoding_format="float", document_extra={}, query_extra={}, timeout_seconds=1.0, max_retries=0, proxy=None, allow_unmetered=False)

    def test_corpus_dedup_scope_and_deterministic_sample(self) -> None:
        corpus = load_corpus(self.reverse, ("sense", "phrase", "usage"), 1, "seed")
        full = load_corpus(self.reverse)
        self.assertEqual(len(corpus.texts), 1); self.assertEqual(len(full.texts), 5)
        self.assertEqual(full.scope_masks["共同文本"], SCOPE_BITS["sense"] | SCOPE_BITS["phrase"])
        self.assertEqual(load_corpus(self.reverse, sample_size=1, sample_seed="seed").texts, corpus.texts)

    def test_provider_usage_endpoint_and_extra_policy(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), EmbeddingHandler); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=1)))
        url = f"http://127.0.0.1:{server.server_port}"
        for base64_mode in (False, True):
            EmbeddingHandler.base64_mode = base64_mode; EmbeddingHandler.tokens = 3
            result = OpenAIEmbeddingProvider(url, "secret", "model", 2, "base64" if base64_mode else "float", {"truncate": True}, ledger=UsageLedger(None, 1.0)).embed(["one"])
            self.assertTrue(np.allclose(result.vectors[0], [0.6, 0.8])); self.assertTrue(EmbeddingHandler.request["truncate"])
        with self.assertRaises(ValueError): OpenAIEmbeddingProvider("ftp://invalid", "secret", "model", 2)
        with self.assertRaises(ValueError): OpenAIEmbeddingProvider(url, "secret", "model", 2, extra={"input": "bad"})
        EmbeddingHandler.tokens = 0
        with self.assertRaises(ProviderError): OpenAIEmbeddingProvider(url, "secret", "model", 2).embed(["one"])
        self.assertTrue(OpenAIEmbeddingProvider(url, "secret", "model", 2, allow_unmetered=True).embed(["one"]).unmetered)

    def test_sliding_window_resume_and_sidecar_contract(self) -> None:
        corpus, output = load_corpus(self.reverse), self.root / "out"; args = self.args(output, concurrency=2)
        fingerprint = build.build_fingerprint(corpus, self.primary, "key", "m", 2, "Q: {query}", {}, {"input_type": "query"})
        calls: list[str] = []
        class FailingProvider:
            def embed(self, texts: list[str], _: int | None = None):
                calls.extend(texts)
                if len(calls) >= 3: raise ProviderError("interrupted")
                return SimpleNamespace(vectors=np.tile(np.array([[1.0, 0.0]], dtype=np.float32), (len(texts), 1)), prompt_tokens=1, requests=1, unmetered=False)
        original = build._provider_from_args; build._provider_from_args = lambda *_: FailingProvider()
        try:
            with self.assertRaises(ProviderError): build.build_cached_vectors(args, corpus, fingerprint)
        finally:
            build._provider_from_args = original
        self.assertLessEqual(len(calls), 3)  # preflight plus at most two in-flight batches
        checkpoint = json.loads((output / "checkpoint.json").read_text()); self.assertTrue(checkpoint["completed"][0])
        resumed: list[str] = []
        class Provider:
            def embed(self, texts: list[str], _: int | None = None):
                resumed.extend(texts); return SimpleNamespace(vectors=np.tile(np.array([[0.0, 1.0]], dtype=np.float32), (len(texts), 1)), prompt_tokens=1, requests=1, unmetered=False)
        build._provider_from_args = lambda *_: Provider()
        try:
            matrix, _, _ = build.build_cached_vectors(args, corpus, fingerprint)
        finally:
            build._provider_from_args = original
        self.assertLess(len(resumed), len(corpus.texts)); self.assertTrue(np.allclose(matrix[0], [1.0, 0.0]))
        sidecar = output / "semantic.db"; metadata = write_sidecar(sidecar, corpus, matrix, 2, self.primary, "key", "provider", "Q: {query}", {"input_type": "query"}, 1)
        self.assertEqual(metadata["projection_version"], "1.0"); self.assertEqual(metadata["query_extra_json"], '{"input_type":"query"}')
        db = sqlite3.connect(sidecar)
        try:
            self.assertEqual(db.execute("PRAGMA page_size").fetchone()[0], 8192); self.assertEqual(db.execute("SELECT COUNT(*) FROM vector_blocks").fetchone()[0], len(corpus.texts)); self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 6)
        finally: db.close()

    def test_runtime_int8_evaluation_and_fingerprint(self) -> None:
        corpus, matrix_path = load_corpus(self.reverse), self.root / "vectors.f16"; build._initialise_matrix(matrix_path, 5, 2)
        matrix = build.open_matrix(matrix_path, 5, 2, "r+"); matrix[:] = np.asarray([[1, 0], [0, 1], [0.7, 0.7], [-1, 0], [0, -1]], dtype=np.float16); matrix.flush()
        result = evaluate(corpus, matrix, lambda _: np.asarray([[1, 0]], dtype=np.float32), [{"query": "first", "mustHit": ["engrossing", "alpha"]}], "Q: {query}", 4)
        self.assertEqual(result["float16"]["hitAt1"], 1.0); self.assertEqual(result["runtimeInt8"]["hitAt1"], 1.0)
        self.assertEqual(quantize_block(np.asarray([[0.5, -0.5]], dtype=np.float32)).tolist(), [[64, -64]])
        first = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Q: {query}", {}, {})
        second = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Q: {query}", {"input_type": "document"}, {})
        self.assertNotEqual(first, second)

    def test_quality_files_preserve_order_and_reject_duplicates(self) -> None:
        first, second = self.root / "one.json", self.root / "two.json"
        first.write_text('[{"query":"first","mustHit":["alpha"]}]', encoding="utf-8")
        second.write_text('[{"query":"second","mustHit":["beta"]}]', encoding="utf-8")
        self.assertEqual([row["query"] for row in load_quality([first, second])], ["first", "second"])
        second.write_text('[{"query":"first","mustHit":["beta"]}]', encoding="utf-8")
        with self.assertRaises(ValueError):
            load_quality([first, second])


if __name__ == "__main__": unittest.main()
