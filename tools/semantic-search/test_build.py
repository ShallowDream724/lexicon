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
from corpus import Document, RETRIEVAL_TEXT_VERSION, SCOPE_BITS, load_corpus
from evaluation import evaluate, load_quality, score_matrices, summarize
from provider import OpenAIEmbeddingProvider, ProviderError, UsageLedger
from sidecar import quantize_block, reusable_texts, write_sidecar


def make_reverse(path: Path) -> None:
    db = sqlite3.connect(path)
    try:
        db.executescript("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE documents (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, english_text TEXT NOT NULL, candidate_text TEXT NOT NULL, definition_text TEXT NOT NULL, chinese_text TEXT NOT NULL, semantic_role TEXT NOT NULL, resource_category TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL);")
        db.executemany("INSERT INTO metadata VALUES (?, ?)", [("projection_version", "2.2"), ("schema_version", "9"), ("normalizer_version", "nfkc-opencc-t2s-v1")])
        rows = [("a", "alpha", "sense", "one", "", "", "共同文本", "definition", "", "definitions", "n", "a", "[]", 10), ("a", "alpha", "phrase", "two", "alpha phrase", "phrase definition", "共同文本", "definition", "", "idioms", "n", "a", "[]", 9), ("b", "beta", "resource", "three", "", "", "其他文本", "guidance", "grammar", "grammar-usage", "v", "b", "[]", 8), ("c", "gamma", "example", "four", "", "", "第三文本", "example", "", "definitions", "n", "c", "[]", 7), ("d", "delta", "sense", "five", "", "", "第四文本", "definition", "", "definitions", "n", "d", "[]", 6), ("e", "epsilon", "form", "six", "", "", "第五文本", "definition", "", "derived-forms", "n", "e", "[]", 5)]
        db.executemany("INSERT INTO documents(entry_id, headword, scope, english_text, candidate_text, definition_text, chinese_text, semantic_role, resource_category, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        db.commit()
    finally:
        db.close()


def sidecar_vector(path: Path, text: str) -> bytes:
    db = sqlite3.connect(path)
    try:
        columns = {str(row[1]) for row in db.execute("PRAGMA table_info(texts)")}
        column = "normalized_chinese_text" if "normalized_chinese_text" in columns else "embedding_text" if "embedding_text" in columns else "chinese_text"
        text_id = db.execute(f"SELECT id FROM texts WHERE {column} = ?", (text,)).fetchone()[0]
        first, count, data = db.execute("SELECT first_vector_id, vector_count, data FROM vector_blocks WHERE ? >= first_vector_id AND ? < first_vector_id + vector_count", (text_id, text_id)).fetchone()
        return bytes(data[(text_id - first) * 2:(text_id - first + 1) * 2])
    finally:
        db.close()


class EmbeddingHandler(BaseHTTPRequestHandler):
    request: dict[str, object] = {}
    user_agent = ""
    base64_mode = False
    tokens: int | None = 3

    def do_POST(self) -> None:  # noqa: N802
        type(self).user_agent = self.headers.get("User-Agent", "")
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
        corpus = load_corpus(self.reverse, ("sense", "phrase", "resource"), 1, "seed")
        full = load_corpus(self.reverse)
        self.assertEqual(len(corpus.texts), 1); self.assertEqual(len(full.texts), 5)
        self.assertEqual(full.scope_masks["共同文本"], SCOPE_BITS["sense"] | SCOPE_BITS["phrase"])
        self.assertEqual(full.documents["其他文本"][0].semantic_role, "guidance")
        self.assertEqual(full.documents["其他文本"][0].resource_category, "grammar")
        self.assertEqual(load_corpus(self.reverse, sample_size=1, sample_seed="seed").texts, corpus.texts)

    def test_semantic_role_contract_rejects_invalid_reverse_documents(self) -> None:
        with self.assertRaises(ValueError):
            Document("entry", "word", "sense", "", "", "", "text", "invalid", "", "definitions", "n", "owner", "[]", 1)
        db = sqlite3.connect(self.reverse)
        try:
            db.execute("UPDATE documents SET semantic_role = 'invalid' WHERE entry_id = 'a' AND scope = 'sense'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "semantic role"):
            load_corpus(self.reverse)

    def test_embedding_text_is_normalized_chinese_only(self) -> None:
        db = sqlite3.connect(self.reverse)
        try:
            db.execute(
                "UPDATE documents SET candidate_text = 'go along with sb', chinese_text = ' 其他　文本 ' WHERE entry_id = 'b'",
            )
            db.commit()
        finally:
            db.close()
        corpus = load_corpus(self.reverse)
        retrieval = "其他 文本"
        self.assertIn(retrieval, corpus.texts)
        self.assertNotIn("go along with sb", corpus.texts)
        self.assertEqual(corpus.documents[retrieval][0].chinese_text, " 其他　文本 ")

    def test_provider_usage_endpoint_and_extra_policy(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), EmbeddingHandler); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=1)))
        url = f"http://127.0.0.1:{server.server_port}"
        for base64_mode in (False, True):
            EmbeddingHandler.base64_mode = base64_mode; EmbeddingHandler.tokens = 3
            result = OpenAIEmbeddingProvider(url, "secret", "model", 2, "base64" if base64_mode else "float", {"truncate": True}, ledger=UsageLedger(None, 1.0)).embed(["one"])
            self.assertTrue(np.allclose(result.vectors[0], [0.6, 0.8])); self.assertTrue(EmbeddingHandler.request["truncate"])
            self.assertEqual(EmbeddingHandler.user_agent, "Lexicon-Semantic-Builder/2")
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
        sidecar = output / "semantic.db"; metadata = write_sidecar(sidecar, corpus, matrix, 2, self.primary, "key", "provider", "Q: {query}", {"input_type": "document"}, {"input_type": "query"}, 0.1, 1)
        self.assertEqual(metadata["schema_version"], "5"); self.assertEqual(metadata["projection_version"], "2.2"); self.assertEqual(metadata["builder_version"], "semantic-builder-v6"); self.assertEqual(metadata["minimum_score"], "0.1"); self.assertEqual(metadata["retrieval_text_version"], RETRIEVAL_TEXT_VERSION); self.assertEqual(metadata["query_extra_json"], '{"input_type":"query"}'); self.assertEqual(metadata["document_extra_json"], '{"input_type":"document"}')
        db = sqlite3.connect(sidecar)
        try:
            self.assertEqual(db.execute("PRAGMA page_size").fetchone()[0], 8192); self.assertEqual(db.execute("SELECT COUNT(*) FROM vector_blocks").fetchone()[0], len(corpus.texts)); self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 6)
            self.assertEqual(db.execute("SELECT semantic_role, resource_category FROM documents WHERE scope = 'resource'").fetchone(), ("guidance", "grammar"))
        finally: db.close()

        reused = output / "semantic-reused.db"
        db = sqlite3.connect(self.reverse)
        try:
            db.execute("UPDATE documents SET semantic_role = 'context' WHERE scope = 'resource'")
            db.commit()
        finally:
            db.close()
        updated_corpus = load_corpus(self.reverse)
        self.assertEqual(updated_corpus.texts, corpus.texts)
        whole_args = self.args(output / "whole-reuse")
        whole_fingerprint = build.build_fingerprint(updated_corpus, self.primary, "key", "m", 2, "Q: {query}", {}, {"input_type": "query"})
        original = build._provider_from_args
        build._provider_from_args = lambda *_: self.fail("whole-sidecar reuse must not create a provider")
        try:
            whole_matrix, whole_usage, _ = build.build_cached_vectors(whole_args, updated_corpus, whole_fingerprint, set(range(len(updated_corpus.texts))))
        finally:
            build._provider_from_args = original
        del whole_matrix
        self.assertEqual(whole_usage, {"promptTokens": 0, "requests": 0, "unmetered": False})
        write_sidecar(reused, updated_corpus, None, 2, self.primary, "key", "provider", "Q: {query}", {"input_type": "document"}, {"input_type": "query"}, 0.1, 1, sidecar)
        source = sqlite3.connect(sidecar); target = sqlite3.connect(reused)
        try:
            self.assertEqual(source.execute("SELECT data FROM vector_blocks ORDER BY block_index").fetchall(), target.execute("SELECT data FROM vector_blocks ORDER BY block_index").fetchall())
            self.assertEqual(target.execute("SELECT candidate_text, definition_text FROM documents WHERE scope='phrase'").fetchone(), ("alpha phrase", "phrase definition"))
            self.assertEqual(target.execute("SELECT semantic_role FROM documents WHERE scope='resource'").fetchone(), ("context",))
        finally:
            source.close(); target.close()

        db = sqlite3.connect(sidecar)
        try:
            db.execute("UPDATE metadata SET value = '2' WHERE key = 'schema_version'")
            db.execute("UPDATE metadata SET value = '1.1' WHERE key = 'projection_version'")
            db.execute("ALTER TABLE texts RENAME COLUMN normalized_chinese_text TO chinese_text")
            db.commit()
        finally:
            db.close()
        legacy_reused = output / "semantic-legacy-reused.db"
        legacy_metadata = write_sidecar(legacy_reused, updated_corpus, None, 2, self.primary, "key", "provider", "Q: {query}", {"input_type": "document"}, {"input_type": "query"}, 0.1, 1, sidecar)
        self.assertEqual(legacy_metadata["schema_version"], "5")
        source = sqlite3.connect(sidecar); target = sqlite3.connect(legacy_reused)
        try:
            self.assertEqual(source.execute("SELECT data FROM vector_blocks ORDER BY block_index").fetchall(), target.execute("SELECT data FROM vector_blocks ORDER BY block_index").fetchall())
        finally:
            source.close(); target.close()

    def test_incremental_text_keyed_reuse_only_embeds_new_texts(self) -> None:
        source_corpus = load_corpus(self.reverse)
        source = self.root / "source.db"
        source_vectors = np.asarray([[1, 0], [0, 1], [-1, 0], [0, -1], [0.5, 0.5]], dtype=np.float32)
        write_sidecar(source, source_corpus, source_vectors, 2, self.primary, "key", "m", "Q: {query}", {}, {}, 0.1, 2)

        db = sqlite3.connect(self.reverse)
        try:
            db.execute("DELETE FROM documents WHERE entry_id = 'e'")
            rows = [(f"new-{index}", f"new-{index}", "sense", "", "", "", f"一新增文本{index:02d}", "definition", "", "definitions", "n", f"new-{index}", "[]", 1) for index in range(30)]
            db.executemany("INSERT INTO documents(entry_id, headword, scope, english_text, candidate_text, definition_text, chinese_text, semantic_role, resource_category, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            db.commit()
        finally:
            db.close()
        target_corpus = load_corpus(self.reverse)
        source_texts = reusable_texts(source, 2, "key", "m", {})
        reused_indices = {index for index, text in enumerate(target_corpus.texts) if text in source_texts}
        self.assertEqual(len(target_corpus.texts), 34)
        self.assertEqual(len(reused_indices), 4)
        self.assertNotIn("第五文本", target_corpus.texts)

        output = self.root / "incremental"
        args = self.args(output)
        args.batch_size = 7
        fingerprint = build.build_fingerprint(target_corpus, self.primary, "key", "m", 2, "Q: {query}", {}, {})
        calls: list[str] = []

        class Provider:
            def embed(self, texts: list[str], _: int | None = None):
                calls.extend(texts)
                return SimpleNamespace(vectors=np.tile(np.asarray([[0.0, 1.0]], dtype=np.float32), (len(texts), 1)), prompt_tokens=len(texts), requests=1, unmetered=False)

        original = build._provider_from_args
        build._provider_from_args = lambda *_: Provider()
        try:
            matrix, _, _ = build.build_cached_vectors(args, target_corpus, fingerprint, reused_indices)
        finally:
            build._provider_from_args = original
        new_texts = set(target_corpus.texts).difference(source_texts)
        self.assertEqual(set(calls), new_texts)
        self.assertEqual(len(calls), 30)
        checkpoint = json.loads((output / "checkpoint.json").read_text())
        self.assertTrue(all(checkpoint["completed"]))

        target = self.root / "target.db"
        metadata = write_sidecar(target, target_corpus, matrix, 2, self.primary, "key", "m", "Q: {query}", {}, {}, 0.1, 3, source)
        del matrix
        self.assertEqual((metadata["reused_vector_count"], metadata["new_vector_count"]), ("4", "30"))
        self.assertEqual(sidecar_vector(target, "共同文本"), sidecar_vector(source, "共同文本"))
        self.assertEqual(sidecar_vector(target, "一新增文本00"), bytes((0, 127)))
        source_db = sqlite3.connect(source); target_db = sqlite3.connect(target)
        try:
            source_id = source_db.execute("SELECT id FROM texts WHERE normalized_chinese_text = '共同文本'").fetchone()[0]
            target_id = target_db.execute("SELECT id FROM texts WHERE normalized_chinese_text = '共同文本'").fetchone()[0]
            self.assertNotEqual(source_id, target_id)
            self.assertEqual(target_db.execute("SELECT vector_count FROM vector_blocks ORDER BY block_index").fetchall(), [(3,)] * 11 + [(1,)])
        finally:
            source_db.close(); target_db.close()

        db = sqlite3.connect(source)
        try:
            db.execute("UPDATE metadata SET value = 'different' WHERE key = 'model_key'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "model_key"):
            reusable_texts(source, 2, "key", "m", {})

    def test_runtime_int8_evaluation_and_fingerprint(self) -> None:
        corpus, matrix_path = load_corpus(self.reverse), self.root / "vectors.f16"; build._initialise_matrix(matrix_path, 5, 2)
        matrix = build.open_matrix(matrix_path, 5, 2, "r+"); matrix[:] = np.asarray([[1, 0], [0, 1], [0.7, 0.7], [-1, 0], [0, -1]], dtype=np.float16); matrix.flush()
        queries = np.asarray([[1, 0], [0, 1]], dtype=np.float32)
        float_scores, int8_scores = score_matrices(matrix, queries, block_size=2)
        np.testing.assert_allclose(float_scores, np.asarray(matrix, dtype=np.float32) @ queries.T)
        np.testing.assert_array_equal(int8_scores, quantize_block(matrix).astype(np.int32) @ quantize_block(queries).astype(np.int32).T)
        result = evaluate(corpus, matrix, lambda _: queries[:1], [{"query": "first", "mustHit": ["engrossing", "alpha"]}], "Q: {query}", 4)
        self.assertEqual(result["float16"]["hitAtK"]["1"], 1.0)
        self.assertEqual(result["runtimeInt8"]["hitAtK"]["1"], 1.0)
        self.assertEqual(result["float16"]["labeledTargetRecallAtK"]["1"], 0.5)
        self.assertEqual(result["rows"][0]["float16TargetRanks"], {"alpha": 1})
        self.assertEqual(quantize_block(np.asarray([[0.5, -0.5]], dtype=np.float32)).tolist(), [[64, -64]])
        first = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Q: {query}", {}, {})
        second = build.build_fingerprint(corpus, self.primary, "key", "model", 2, "Q: {query}", {"input_type": "document"}, {})
        self.assertNotEqual(first, second)

    def test_quality_summary_separates_hit_rate_from_labeled_target_recall(self) -> None:
        summary = summarize(
            [
                {"alpha": 1, "beta": 3},
                {"gamma": 2},
                {},
            ],
            [
                {"alpha", "beta", "missing"},
                {"gamma"},
                {"delta"},
            ],
            8,
        )
        self.assertEqual(summary["hitAtK"], {"1": 1 / 3, "3": 2 / 3, "8": 2 / 3})
        self.assertAlmostEqual(summary["labeledTargetRecallAtK"]["1"], 1 / 9)
        self.assertAlmostEqual(summary["labeledTargetRecallAtK"]["3"], 5 / 9)
        self.assertAlmostEqual(summary["labeledTargetRecallAtK"]["8"], 5 / 9)
        self.assertAlmostEqual(summary["meanReciprocalRank"], 0.5)

    def test_request_reservation_uses_utf8_input_size(self) -> None:
        templated = "Instruct: retrieve a dictionary answer\nQuery: " + "中文描述" * 10
        reserve = build.conservative_reservation_tokens([templated], 1.15)
        self.assertGreater(reserve, 10)  # Above a one-token-per-document preflight average.
        self.assertEqual(reserve, int(np.ceil(len(templated.encode("utf-8")) * 1.15)))

    def test_atomic_json_write_retries_transient_windows_reader(self) -> None:
        path = self.root / "report.json"
        original = build.os.replace
        attempts = 0

        def flaky_replace(source: Path, target: Path) -> None:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise PermissionError("temporarily open")
            original(source, target)

        build.os.replace = flaky_replace
        try:
            build.write_json_atomic(path, {"ok": True})
        finally:
            build.os.replace = original
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"ok": True})
        self.assertEqual(attempts, 3)

    def test_quality_files_preserve_order_and_reject_duplicates(self) -> None:
        first, second = self.root / "one.json", self.root / "two.json"
        first.write_text('[{"query":"first","mustHit":["alpha"]}]', encoding="utf-8")
        second.write_text('[{"query":"second","mustHit":["beta"]}]', encoding="utf-8")
        self.assertEqual([row["query"] for row in load_quality([first, second])], ["first", "second"])
        second.write_text('[{"query":"first","mustHit":["beta"]}]', encoding="utf-8")
        with self.assertRaises(ValueError):
            load_quality([first, second])


if __name__ == "__main__": unittest.main()
