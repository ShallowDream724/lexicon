from __future__ import annotations

import json
import math
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from quality_eval import HTTPSearchClient, evaluate_http, load_cases, validate_against_reverse, validate_cases


def target(entry_id: str, headword: str, grade: int = 3) -> dict[str, object]:
    return {"entryId": entry_id, "headword": headword, "grade": grade, "evidence": {"scope": "sense", "contains": "evidence"}}


def case(case_id: str, relevance: list[dict[str, object]], **extra: object) -> dict[str, object]:
    return {"id": case_id, "query": case_id, "split": "development", "category": "fixture", "scopes": ["sense"], "relevance": relevance, **extra}


class SearchHandler(BaseHTTPRequestHandler):
    payload: dict[str, object] = {}

    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps(type(self).payload).encode("utf-8")
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        pass


class QualityEvaluationTest(unittest.TestCase):
    def test_schema_supports_grades_and_rejects_bad_gap(self) -> None:
        valid = case("grades", [target("a", "alpha", 3), {"entryId": "b", "headword": "beta", "grade": 2}, {"entryId": "c", "headword": "gamma", "grade": 1}], forbidden=[{"entryId": "z", "headword": "zeta"}])
        self.assertEqual(validate_cases([valid]), [valid])
        with self.assertRaisesRegex(ValueError, "gap needs no relevance"):
            validate_cases([case("gap", [target("a", "alpha")], expectation="gap")])
        duplicate = [case("one", [target("a", "alpha")]), case("two", [target("b", "beta")])]
        duplicate[1]["query"] = "one"
        with self.assertRaisesRegex(ValueError, "shared pairGroup"):
            validate_cases(duplicate)
        paired = [case("pair-sense", [target("a", "alpha")], pairGroup="pair", scopes=["sense"]), case("pair-phrase", [target("b", "beta")], pairGroup="pair", scopes=["phrase"])]
        paired[1]["query"] = paired[0]["query"]
        self.assertEqual(validate_cases(paired), paired)
        with self.assertRaisesRegex(ValueError, "duplicate relevance target"):
            validate_cases([case("identity", [{"entryId": "a", "headword": "alpha", "grade": 3}, {"headword": "alpha", "grade": 2}])])

    def test_reverse_validation_checks_anchored_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reverse.db"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE documents(entry_id TEXT, headword TEXT, scope TEXT, english_text TEXT, chinese_text TEXT, section TEXT, part TEXT, owner_id TEXT, path_json TEXT)")
            db.execute("INSERT INTO documents VALUES ('a', 'alpha', 'sense', 'english', 'evidence', 'definitions', 'noun', 'owner', '[\"senses\",\"0\"]')")
            db.commit(); db.close()
            good = case("anchored", [{**target("a", "alpha"), "evidence": {"scope": "sense", "contains": "evidence", "location": {"ownerId": "owner", "path": ["senses", "0"]}}}])
            validate_against_reverse(validate_cases([good]), path)
            bad = case("missing", [target("b", "beta")])
            with self.assertRaisesRegex(ValueError, "absent"):
                validate_against_reverse(validate_cases([bad]), path)
            weak = case("weak", [target("a", "alpha"), {"entryId": "b", "headword": "beta", "grade": 1}])
            with self.assertRaisesRegex(ValueError, "absent"):
                validate_against_reverse(validate_cases([weak]), path)
            wrong_scope = case("scope", [{"entryId": "a", "headword": "alpha", "grade": 3, "evidence": {"scope": "usage"}}])
            with self.assertRaisesRegex(ValueError, "outside requested scopes"):
                validate_against_reverse(validate_cases([wrong_scope]), path)

    def test_evidence_expectations_are_separate_and_anchored_to_relevance(self) -> None:
        valid = case("separate", [{"entryId": "a", "headword": "alpha", "grade": 3}], evidenceExpectations=[target("a", "alpha", 3)])
        self.assertEqual(validate_cases([valid]), [valid])
        unrelated = case("unrelated", [{"entryId": "a", "headword": "alpha", "grade": 3}], evidenceExpectations=[target("b", "beta", 3)])
        with self.assertRaisesRegex(ValueError, "relevant entry"):
            validate_cases([unrelated])

    def test_http_metrics_grade_forbidden_scope_and_latency(self) -> None:
        SearchHandler.payload = {"semanticStatus": "degraded", "items": [
            {"id": "b", "headword": "beta", "matches": [{"scope": "sense", "chineseText": "evidence"}]},
            {"id": "a", "headword": "al·pha", "matches": [{"scope": "sense", "chineseText": "evidence"}]},
            {"id": "z", "headword": "zeta", "matches": [{"scope": "usage", "chineseText": "wrong scope"}]},
        ]}
        server = ThreadingHTTPServer(("127.0.0.1", 0), SearchHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=1)))
        cases = validate_cases([case("ranked", [target("a", "alpha", 3), target("b", "beta", 2)], forbidden=[{"entryId": "z", "headword": "zeta"}])])
        cases[0]["query"] = "排序测试"
        report = evaluate_http(cases, HTTPSearchClient(f"http://127.0.0.1:{server.server_port}"), metadata={"model": {"key": "fixture"}})
        summary = report["summary"]
        self.assertEqual(report["metadata"]["model"]["key"], "fixture")
        self.assertEqual(summary["hitAt1"], 1.0)
        self.assertEqual(summary["recallAt3"], 1.0)
        self.assertEqual(summary["mrrGradeAtLeast2"], 1.0)
        self.assertGreater(summary["entryNdcgAtK"], 0.0)
        self.assertEqual(summary["forbiddenRate"], 1 / 3)
        self.assertEqual(summary["scopeLeakageRate"], 1 / 3)
        self.assertEqual(summary["forbiddenCaseRate"], 1.0)
        self.assertEqual(summary["scopeLeakageCaseRate"], 1.0)
        self.assertEqual(summary["evidenceHitAt1WithinEntry"], 1.0)
        self.assertEqual(summary["semanticAppliedRate"], 0.0)
        self.assertEqual(summary["semanticDegradedRate"], 1.0)
        self.assertEqual(summary["semanticStatusCounts"], {"degraded": 1})
        self.assertIsNotNone(summary["latencyMs"]["p95"])

    def test_holdout_requires_explicit_permission(self) -> None:
        hidden = case("hidden", [target("a", "alpha")])
        hidden["split"] = "holdout"
        with self.assertRaisesRegex(ValueError, "explicit"):
            evaluate_http([hidden], HTTPSearchClient("http://127.0.0.1:1"))

    def test_development_and_holdout_reject_normalized_query_leakage(self) -> None:
        development = case("development", [target("a", "alpha")])
        development["query"] = "Wi-Fi 连不上"
        holdout = case("holdout", [target("b", "beta")])
        holdout.update({"query": "ｗｉ－ｆｉ连不上！", "split": "holdout"})
        with self.assertRaisesRegex(ValueError, "normalized query cannot cross"):
            validate_cases([development, holdout])

        grouped = case("grouped", [target("c", "gamma")], leakageGroup="shared-intent")
        grouped_holdout = case("grouped-holdout", [target("d", "delta")], leakageGroup="shared-intent")
        grouped_holdout["split"] = "holdout"
        with self.assertRaisesRegex(ValueError, "leakageGroup cannot cross"):
            validate_cases([grouped, grouped_holdout])

    def test_http_rejects_unknown_semantic_status(self) -> None:
        SearchHandler.payload = {"semanticStatus": "mystery", "items": []}
        server = ThreadingHTTPServer(("127.0.0.1", 0), SearchHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=1)))
        with self.assertRaisesRegex(ValueError, "unsupported semanticStatus"):
            evaluate_http([case("status", [target("a", "alpha")])], HTTPSearchClient(f"http://127.0.0.1:{server.server_port}"))

    def test_evidence_order_is_measured_separately_from_entry_order(self) -> None:
        SearchHandler.payload = {"semanticStatus": "applied", "items": [{
            "id": "a", "headword": "alpha", "matches": [
                {"scope": "sense", "chineseText": "other"},
                {"scope": "sense", "chineseText": "EVIDENCE"},
            ],
        }]}
        server = ThreadingHTTPServer(("127.0.0.1", 0), SearchHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=1)))
        evidence_case = case("evidence-order", [target("a", "alpha")])
        evidence_case["query"] = "证据排序"
        report = evaluate_http([evidence_case], HTTPSearchClient(f"http://127.0.0.1:{server.server_port}"))
        summary = report["summary"]
        self.assertEqual(summary["entryNdcgAtK"], 1.0)
        self.assertEqual(summary["evidenceMrrWithinEntry"], 0.5)
        self.assertAlmostEqual(summary["evidenceNdcgAt3WithinEntry"], 1 / math.log2(3), places=6)
        self.assertEqual(summary["evidenceHitAt1WithinEntry"], 0.0)
        self.assertEqual(summary["evidenceHitAt3WithinEntry"], 1.0)
        self.assertIn("fixture", report["byCategory"])
        self.assertEqual(report["categoryMacro"]["entryNdcgAtK"], 1.0)
        self.assertEqual(report["byEvidenceScope"]["sense"]["hitAt3WithinEntry"], 1.0)

    def test_checked_in_development_set_uses_the_v3_contract(self) -> None:
        cases = load_cases([HERE / "quality-v3" / "development.json"])
        self.assertEqual(len(cases), 144)
        self.assertTrue(all(case["split"] == "development" for case in cases))
        self.assertGreaterEqual(sum(len(case["query"]) == 1 for case in cases), 10)
        self.assertEqual(len({case["pairGroup"] for case in cases if "pairGroup" in case}), 20)
        self.assertTrue(all(len(case["relevance"]) == len(case["evidenceExpectations"]) for case in cases if case["expectation"] == "retrieval"))
        self.assertGreaterEqual(sum(len(case["relevance"]) >= 2 for case in cases if case["expectation"] == "retrieval"), 90)
        self.assertFalse(any("\n" in case["query"] or "\r" in case["query"] for case in cases))


if __name__ == "__main__":
    unittest.main()
