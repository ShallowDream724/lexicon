"""Offline fixtures for semantic absolute-threshold calibration."""

from __future__ import annotations

import json
import subprocess
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from calibrate_threshold import (  # noqa: E402
    SCORE_DENOMINATOR,
    answerable_quality,
    calibrate,
    evaluate_cases,
    go_quantize_query,
    load_cases,
    load_sidecar,
    normalized_headword,
    score_query,
    validate_disjoint,
    validate_targets,
)


def write_fixture(path: Path) -> None:
    database = sqlite3.connect(path)
    try:
        database.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE texts (id INTEGER PRIMARY KEY, normalized_chinese_text TEXT NOT NULL, scope_mask INTEGER NOT NULL);
            CREATE TABLE documents (text_id INTEGER NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL);
            CREATE TABLE vector_blocks (block_index INTEGER PRIMARY KEY, first_vector_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, data BLOB NOT NULL);
        """)
        metadata = {
            "schema_version": "5", "quantization": "symmetric-int8-127", "dimensions": "2",
            "block_size": "2", "vector_count": "2", "model_key": "fixture-key", "provider_model": "fixture-model",
            "query_template": "query: {query}", "query_extra_json": "{}",
        }
        database.executemany("INSERT INTO metadata(key, value) VALUES (?, ?)", metadata.items())
        database.executemany("INSERT INTO texts(id, normalized_chinese_text, scope_mask) VALUES (?, ?, ?)", [(0, "甲", 1), (1, "乙", 1)])
        database.executemany("INSERT INTO documents(text_id, headword, scope) VALUES (?, ?, ?)", [(0, "ˈal·pha", "sense"), (1, "ˌbe·ta", "phrase")])
        vectors = np.asarray([[127, 0], [0, 127]], dtype=np.int8)
        database.execute("INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (0, 0, 2, ?)", (vectors.tobytes(),))
        database.commit()
    finally:
        database.close()


class CalibrationFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "sidecar.db"
        write_fixture(self.path)
        self.sidecar = load_sidecar(self.path, ("sense", "phrase"))

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_scores_runtime_int8_and_targets(self) -> None:
        self.assertEqual(normalized_headword("ˈawk·ward ˌcred·i·ble"), "awkward credible")
        self.assertEqual(go_quantize_query(np.asarray([1.0, 0.0]), 2).tolist(), [127, 0])
        maximum, heads, text_scores = score_query(self.sidecar, np.asarray([1.0, 0.0]), 2)
        self.assertEqual(maximum, 1.0)
        self.assertEqual(heads[0]["headword"], "alpha")
        self.assertEqual(text_scores, {})
        cases = [{"id": "a", "split": "development", "label": "answerable", "category": "fixture", "query": "x", "targets": ["alpha"]}, {"id": "r", "split": "development", "label": "reject", "category": "fixture", "query": "y"}]
        rows = evaluate_cases(self.sidecar, cases, np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32), 2)
        self.assertEqual(rows[0]["score"], 1.0)
        self.assertEqual(rows[0]["bestTargetRank"], 1)
        self.assertEqual(rows[0]["topHeadwords"][0]["headword"], "alpha")
        self.assertEqual(rows[1]["topHeadwords"][0]["headword"], "beta")
        self.assertEqual(self.sidecar.model_key, "fixture-key")
        self.assertEqual(answerable_quality(rows)["hitAt1"], 1.0)

    def test_dataset_guards_and_disjointness(self) -> None:
        dataset = Path(self.directory.name) / "cases.json"
        dataset.write_text(json.dumps([
            {"id": "a", "split": "development", "label": "answerable", "query": "查询", "category": "fixture", "targets": ["alpha"]},
            {"id": "r", "split": "development", "label": "reject", "query": "拒绝", "category": "fixture"},
        ], ensure_ascii=False), encoding="utf-8")
        cases = load_cases([dataset], "development")
        validate_targets(cases, self.sidecar)
        overlap = Path(self.directory.name) / "overlap.json"
        overlap.write_text(json.dumps([{"query": " 查 询 "}], ensure_ascii=False), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "overlaps"):
            validate_disjoint(cases, [overlap])
        invalid = Path(self.directory.name) / "invalid.json"
        invalid.write_text(json.dumps([{"id": "bad", "split": "development", "label": "reject", "query": "bad", "category": "fixture", "targets": ["alpha"]}]), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "must omit targets"):
            load_cases([invalid], "development")

    def test_calibration_prefers_rejection_after_retention(self) -> None:
        rows = [
            {"label": "answerable", "score": 0.9}, {"label": "answerable", "score": 0.8},
            {"label": "reject", "score": 0.7}, {"label": "reject", "score": 0.85},
        ]
        selected, pareto, candidates = calibrate(rows, minimum_retention=1.0)
        self.assertGreater(selected["threshold"], 0.7)
        self.assertEqual(selected["reject"]["rejected"], 1)
        self.assertTrue(pareto)
        self.assertGreater(len(candidates), len(pareto))

    def test_validate_mode_never_requires_a_provider(self) -> None:
        dataset = Path(self.directory.name) / "validate.json"
        dataset.write_text(json.dumps([
            {"id": "dev", "split": "development", "label": "answerable", "query": "查询", "category": "fixture", "targets": ["alpha"]},
            {"id": "holdout", "split": "holdout", "label": "reject", "query": "拒绝", "category": "fixture"},
        ], ensure_ascii=False), encoding="utf-8")
        completed = subprocess.run([
            sys.executable,
            str(Path(__file__).parent / "calibrate_threshold.py"),
            "--mode", "validate",
            "--sidecar", str(self.path),
            "--dataset", str(dataset),
        ], check=True, capture_output=True, text=True)
        report = json.loads(completed.stdout)
        self.assertEqual(report["providerRequests"], 0)
        self.assertEqual(report["splits"], {"development": 1, "holdout": 1})


if __name__ == "__main__":
    unittest.main()
