"""Validate the one-use blind holdout and its pinned SQLite evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
DEFAULT_HOLDOUT = HERE / "holdout.json"
DEFAULT_DEVELOPMENT = HERE / "development.json"
DEFAULT_REVERSE_DB = REPOSITORY / "data" / "reverse-search.db"
SCOPES = frozenset(("sense", "phrase", "usage", "example", "form"))
LENGTH_BANDS = ("1-3", "4-6", "7-12", "13-24")
EXPECTED_LENGTHS = {"1-3": 70, "4-6": 52, "7-12": 42, "13-24": 28}
EXPECTED_CATEGORIES = {
    "direct-translation": 42,
    "high-frequency-polysemy": 16,
    "descriptive-reverse": 24,
    "phrase-idiom": 16,
    "terminology": 14,
    "corpus-gap": 10,
    "colloquial-network": 14,
    "negation-contrast": 10,
    "usage-metalanguage": 10,
    "synonym-near": 8,
    "morphology-derivation": 6,
    "example-fragment": 8,
    "robustness-format": 6,
    "broad-recall": 4,
    "example-scenario": 4,
}
EXPECTED_REVERSE_BYTES = 72_228_864
EXPECTED_REVERSE_SHA256 = "6a5288a931c1818fa064e030dc6476b72724717444ee751f52e26fc38e73fab0"
EXPECTED_REVERSE_SCHEMA = "5"
EXPECTED_PROJECTION_VERSION = "1.4"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_array(path: Path, label: str) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, list), f"{label} must be a JSON array")
    require(all(isinstance(case, dict) for case in value), f"{label} cases must be objects")
    return value


def query_signature(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(
        character
        for character in normalized
        if not character.isspace() and not unicodedata.category(character).startswith(("P", "S"))
    )


def query_band(value: str) -> str:
    length = len(value.strip())
    for lower, upper, band in ((1, 3, "1-3"), (4, 6, "4-6"), (7, 12, "7-12"), (13, 24, "13-24")):
        if lower <= length <= upper:
            return band
    raise ValueError(f"query length is outside 1..24: {value!r}")


def target_key(value: dict[str, Any]) -> tuple[str, str]:
    return str(value.get("entryId", "")), str(value.get("headword", "")).casefold()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_read_only(path: Path) -> sqlite3.Connection:
    require(path.is_file(), f"reverse sidecar is missing: {path}")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def validate_location(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label}: location must be an object")
    require(isinstance(value.get("section"), str) and value["section"], f"{label}: location.section is required")
    require(isinstance(value.get("path"), list) and all(isinstance(part, str) for part in value["path"]), f"{label}: location.path must be strings")
    for name in ("part", "ownerId"):
        if name in value:
            require(isinstance(value[name], str) and value[name], f"{label}: location.{name} must be non-empty")
    return value


def validate_evidence(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label}: evidence must be an object")
    require(value.get("scope") in SCOPES, f"{label}: unsupported evidence scope")
    require(isinstance(value.get("contains"), str) and value["contains"].strip(), f"{label}: evidence.contains is required")
    validate_location(value.get("location"), label)
    return value


def _load_documents(db: sqlite3.Connection, entry_ids: Iterable[str]) -> dict[str, list[sqlite3.Row]]:
    selected = sorted(set(entry_ids))
    if not selected:
        return {}
    placeholders = ",".join("?" for _ in selected)
    rows = db.execute(
        "SELECT entry_id, headword, scope, candidate_text, chinese_text, english_text, section, part, owner_id, path_json "
        f"FROM documents WHERE entry_id IN ({placeholders})",
        selected,
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["entry_id"]].append(row)
    return grouped


def evidence_matches(row: sqlite3.Row, evidence: dict[str, Any]) -> bool:
    location = evidence["location"]
    return (
        row["scope"] == evidence["scope"]
        and evidence["contains"] in (row["chinese_text"] + "\n" + row["english_text"])
        and row["section"] == location["section"]
        and json.loads(row["path_json"]) == location["path"]
        and ("part" not in location or row["part"] == location["part"])
        and ("ownerId" not in location or row["owner_id"] == location["ownerId"])
    )


def validate(holdout_path: Path, development_path: Path, reverse_db: Path) -> dict[str, Any]:
    cases = load_array(holdout_path, "holdout")
    development = load_array(development_path, "development")
    require(len(cases) == 192, "holdout must contain exactly 192 cases")

    development_signatures = {query_signature(case["query"]) for case in development}
    development_single_characters = {case["query"] for case in development if len(case["query"]) == 1}
    development_entry_ids = {
        target["entryId"]
        for case in development
        for target in case.get("relevance", [])
        if isinstance(target, dict) and isinstance(target.get("entryId"), str)
    }
    development_leakage_groups = {case["leakageGroup"] for case in development if case.get("leakageGroup")}

    identifiers: set[str] = set()
    signatures: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pair_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    all_entry_ids: set[str] = set()
    relevance_by_case: dict[str, set[tuple[str, str]]] = {}
    source_counts: Counter[str] = Counter()

    for index, case in enumerate(cases):
        label = f"holdout[{index}]"
        required_fields = (
            "id", "query", "split", "category", "scopes", "expectation", "intent", "tags",
            "queryStyle", "isNaturalQuery", "queryLength", "lengthBand", "auditStatus",
            "leakageAuditStatus",
            "relevance", "evidenceExpectations", "forbidden",
        )
        for field in required_fields:
            require(field in case, f"{label}: missing {field}")
        require(isinstance(case["id"], str) and case["id"], f"{label}: id is required")
        require(case["id"] not in identifiers, f"{label}: duplicate id")
        identifiers.add(case["id"])
        require(case["split"] == "holdout", f"{case['id']}: split must be holdout")
        require(isinstance(case["query"], str) and case["query"].strip(), f"{case['id']}: query is required")
        require("\n" not in case["query"] and "\r" not in case["query"], f"{case['id']}: query must be one line")
        signature = query_signature(case["query"])
        require(signature and signature not in development_signatures, f"{case['id']}: normalized query leaks from development")
        signatures[signature].append(case)
        require(case["queryLength"] == len(case["query"].strip()), f"{case['id']}: stale queryLength")
        require(case["lengthBand"] == query_band(case["query"]), f"{case['id']}: stale lengthBand")
        require(isinstance(case["scopes"], list) and case["scopes"], f"{case['id']}: scopes are required")
        require(len(case["scopes"]) == len(set(case["scopes"])) and set(case["scopes"]).issubset(SCOPES), f"{case['id']}: invalid scopes")
        require(case["expectation"] in {"retrieval", "gap"}, f"{case['id']}: invalid expectation")
        require(isinstance(case["intent"], str) and case["intent"].strip(), f"{case['id']}: intent is required")
        require(isinstance(case["tags"], list) and all(isinstance(tag, str) and tag for tag in case["tags"]), f"{case['id']}: invalid tags")
        require("blind-annotation" in case["tags"], f"{case['id']}: blind provenance tag is required")
        seed_tags = [tag for tag in case["tags"] if tag.startswith("pool-seed:")]
        require(len(seed_tags) == 1 and seed_tags[0][10:11] in {"A", "B", "C"}, f"{case['id']}: exactly one A/B/C pool seed is required")
        source_counts[seed_tags[0][10]] += 1
        require(case["auditStatus"] == "double-reviewed", f"{case['id']}: double review is required")
        require(case["leakageAuditStatus"] == "development-distinct", f"{case['id']}: manual near-duplicate audit is required")
        require(isinstance(case["queryStyle"], str) and case["queryStyle"], f"{case['id']}: queryStyle is required")
        require(isinstance(case["isNaturalQuery"], bool), f"{case['id']}: isNaturalQuery must be boolean")
        if case.get("leakageGroup"):
            require(case["leakageGroup"] not in development_leakage_groups, f"{case['id']}: leakageGroup crosses development")
        if case.get("pairGroup"):
            require(case.get("leakageGroup") == case["pairGroup"], f"{case['id']}: pair must be one leakage group")
            require(case.get("pairRole") in {"sense", "phrase"}, f"{case['id']}: invalid pair role")
            pair_groups[case["pairGroup"]].append(case)

        relevance = case["relevance"]
        expectations = case["evidenceExpectations"]
        forbidden = case["forbidden"]
        require(isinstance(relevance, list) and isinstance(expectations, list) and isinstance(forbidden, list), f"{case['id']}: target fields must be arrays")
        relevance_keys: set[tuple[str, str]] = set()
        grades: dict[tuple[str, str], int] = {}
        for target_index, target in enumerate(relevance):
            target_label = f"{case['id']}.relevance[{target_index}]"
            require(isinstance(target, dict), f"{target_label}: target must be an object")
            require(isinstance(target.get("entryId"), str) and target["entryId"], f"{target_label}: entryId is required")
            require(isinstance(target.get("headword"), str) and target["headword"], f"{target_label}: headword is required")
            require(isinstance(target.get("grade"), int) and 1 <= target["grade"] <= 3, f"{target_label}: grade must be 1..3")
            require("evidence" not in target, f"{target_label}: relevance must not embed evidence")
            key = target_key(target)
            require(key not in relevance_keys, f"{target_label}: duplicate target")
            relevance_keys.add(key)
            grades[key] = target["grade"]
            all_entry_ids.add(target["entryId"])
        relevance_by_case[case["id"]] = relevance_keys

        evidence_keys: set[tuple[str, str, str]] = set()
        covered: set[tuple[str, str]] = set()
        for expectation_index, expectation in enumerate(expectations):
            expectation_label = f"{case['id']}.evidenceExpectations[{expectation_index}]"
            require(isinstance(expectation, dict), f"{expectation_label}: expectation must be an object")
            key = target_key(expectation)
            require(key in relevance_keys, f"{expectation_label}: orphan evidence")
            require(expectation.get("grade") == grades[key], f"{expectation_label}: grade mismatch")
            evidence = validate_evidence(expectation.get("evidence"), expectation_label)
            require(evidence["scope"] in case["scopes"], f"{expectation_label}: evidence scope is outside requested scopes")
            location_key = json.dumps(evidence["location"], ensure_ascii=False, sort_keys=True)
            unique_key = (expectation["entryId"], evidence["scope"], location_key)
            require(unique_key not in evidence_keys, f"{expectation_label}: duplicate evidence")
            evidence_keys.add(unique_key)
            covered.add(key)
            all_entry_ids.add(expectation["entryId"])
        require(covered == relevance_keys, f"{case['id']}: every relevance target needs independent evidence")

        forbidden_keys: set[tuple[str, str]] = set()
        for forbidden_index, target in enumerate(forbidden):
            forbidden_label = f"{case['id']}.forbidden[{forbidden_index}]"
            require(isinstance(target, dict) and target.get("grade") == 0, f"{forbidden_label}: grade must be 0")
            key = target_key(target)
            require(key not in relevance_keys and key not in forbidden_keys, f"{forbidden_label}: overlapping forbidden target")
            forbidden_keys.add(key)
            evidence = validate_evidence(target.get("evidence"), forbidden_label)
            require(evidence["scope"] in case["scopes"], f"{forbidden_label}: scope is outside requested scopes")
            all_entry_ids.add(target["entryId"])

        if case["expectation"] == "retrieval":
            require(relevance and any(target["grade"] == 3 for target in relevance), f"{case['id']}: retrieval needs a grade-3 target")
            require("gap" not in case, f"{case['id']}: retrieval must not have gap metadata")
            novel = any(target["grade"] >= 2 and target["entryId"] not in development_entry_ids for target in relevance)
            require(("novel-target" in case["tags"]) == novel, f"{case['id']}: stale novel-target tag")
        else:
            require(not relevance and not expectations, f"{case['id']}: gap must not have positives")
            gap = case.get("gap")
            require(isinstance(gap, dict) and gap.get("type") == "corpus-gap", f"{case['id']}: explicit corpus gap is required")
            require(gap.get("absence") in {"all-scopes", "selected-scopes"}, f"{case['id']}: invalid gap absence")
            missing = gap.get("missingHeadwords")
            require(isinstance(missing, list) and missing and all(isinstance(item, str) and item for item in missing), f"{case['id']}: missingHeadwords are required")

    for signature, group in signatures.items():
        if len(group) == 1:
            continue
        names = {case.get("pairGroup") for case in group}
        require(len(group) == 2 and None not in names and len(names) == 1, f"normalized duplicate is not one scope pair: {signature!r}")

    require(12 <= len(pair_groups) <= 16, "holdout needs 12..16 sense/phrase scope pairs")
    for name, group in pair_groups.items():
        require(len(group) == 2 and len({case["query"] for case in group}) == 1, f"{name}: pair must contain two identical queries")
        require({tuple(case["scopes"]) for case in group} == {("sense",), ("phrase",)}, f"{name}: pair must contrast sense and phrase")
        require({case["pairRole"] for case in group} == {"sense", "phrase"}, f"{name}: pair roles are incomplete")
        require(relevance_by_case[group[0]["id"]] != relevance_by_case[group[1]["id"]], f"{name}: pair target sets must differ")

    retrieval_cases = [case for case in cases if case["expectation"] == "retrieval"]
    gap_cases = [case for case in cases if case["expectation"] == "gap"]
    require(len(retrieval_cases) == 182 and len(gap_cases) == 10, "holdout must contain 182 retrieval and 10 gap cases")
    category_counts = Counter(case["category"] for case in cases)
    require(category_counts == Counter(EXPECTED_CATEGORIES), "category quotas changed")
    length_counts = Counter(case["lengthBand"] for case in cases)
    for band, expected in EXPECTED_LENGTHS.items():
        require(abs(length_counts[band] - expected) <= 6, f"length band {band} is outside +/-6")
    natural_count = sum(case["isNaturalQuery"] for case in cases)
    require(natural_count / len(cases) >= 0.95, "natural queries must be at least 95%")
    single_characters = [case for case in cases if len(case["query"]) == 1]
    require(len(single_characters) >= 10, "at least 10 single-character cases are required")
    require(all(case["query"] not in development_single_characters for case in single_characters), "single-character query leaks from development")
    require(all({"single-character", "high-frequency", "polysemy", "stability", "literal-path"}.issubset(case["tags"]) for case in single_characters), "single-character audit tags are incomplete")

    grade_two_counts = [sum(target["grade"] >= 2 for target in case["relevance"]) for case in retrieval_cases]
    require(sum(count >= 2 for count in grade_two_counts) / len(retrieval_cases) >= 0.75, "fewer than 75% of retrieval cases have two grade>=2 targets")
    require(sum(grade_two_counts) / len(retrieval_cases) >= 2.0, "average grade>=2 targets is below 2.0")
    novel_cases = [case for case in retrieval_cases if "novel-target" in case["tags"]]
    require(len(novel_cases) / len(retrieval_cases) >= 0.5, "fewer than half of retrieval cases have a novel target")
    require(all(source_counts[source] >= 25 for source in "ABC"), "all candidate pools need material representation")
    require(sum(case["gap"]["absence"] == "selected-scopes" for case in gap_cases) <= 1, "at most one selected-scope gap is allowed")
    require(not any(expectation["evidence"]["scope"] == "form" for case in retrieval_cases for expectation in case["evidenceExpectations"]), "form positives are not allowed")

    with open_read_only(reverse_db) as db:
        documents = _load_documents(db, all_entry_ids)
        for case in cases:
            for target in (*case["relevance"], *case["forbidden"]):
                rows = documents.get(target["entryId"], [])
                require(any(row["headword"].casefold() == target["headword"].casefold() and row["scope"] in case["scopes"] for row in rows), f"{case['id']}: target identity is absent in requested scopes")
            for expectation in case["evidenceExpectations"]:
                rows = documents.get(expectation["entryId"], [])
                matches = [row for row in rows if row["headword"].casefold() == expectation["headword"].casefold() and evidence_matches(row, expectation["evidence"])]
                require(matches, f"{case['id']}: evidence is absent from the pinned sidecar")
                if expectation["evidence"]["scope"] == "phrase":
                    require(all(row["candidate_text"].strip() for row in matches), f"{case['id']}: phrase candidate_text is empty")
            for forbidden in case["forbidden"]:
                rows = documents.get(forbidden["entryId"], [])
                require(any(row["headword"].casefold() == forbidden["headword"].casefold() and evidence_matches(row, forbidden["evidence"]) for row in rows), f"{case['id']}: forbidden evidence is absent")
            if case["expectation"] == "gap":
                for headword in case["gap"]["missingHeadwords"]:
                    present_scopes = {row[0] for row in db.execute("SELECT scope FROM documents WHERE lower(headword)=lower(?)", (headword,))}
                    if case["gap"]["absence"] == "all-scopes":
                        require(not present_scopes, f"{case['id']}: all-scope gap is present: {headword}")
                    else:
                        require(present_scopes and present_scopes.isdisjoint(case["scopes"]), f"{case['id']}: selected-scope gap is invalid: {headword}")
        corpus_scopes = {row["scope"]: row["count"] for row in db.execute("SELECT scope, count(*) AS count FROM documents GROUP BY scope")}
        metadata = {row["key"]: row["value"] for row in db.execute("SELECT key, value FROM metadata")}

    reverse_sha256 = sha256_file(reverse_db)
    require(reverse_db.stat().st_size == EXPECTED_REVERSE_BYTES, "reverse sidecar byte-size pin changed")
    require(reverse_sha256 == EXPECTED_REVERSE_SHA256, "reverse sidecar SHA-256 pin changed")
    require(metadata.get("schema_version") == EXPECTED_REVERSE_SCHEMA, "reverse schema pin changed")
    require(metadata.get("projection_version") == EXPECTED_PROJECTION_VERSION, "reverse projection pin changed")
    require(corpus_scopes.get("form", 0) == 0, "form scope is no longer empty; re-annotate the holdout")

    grade_counts = Counter(target["grade"] for case in retrieval_cases for target in case["relevance"])
    evidence_scopes = Counter(expectation["evidence"]["scope"] for case in retrieval_cases for expectation in case["evidenceExpectations"])
    selected_scopes = Counter(scope for case in cases for scope in case["scopes"])
    source_total = sum(source_counts.values())
    return {
        "schemaVersion": "quality-v3.0-holdout",
        "data": str(holdout_path),
        "cases": len(cases),
        "retrievalCases": len(retrieval_cases),
        "gapCases": len(gap_cases),
        "categories": dict(sorted(category_counts.items())),
        "lengthBands": {band: length_counts[band] for band in LENGTH_BANDS},
        "naturalQueries": natural_count,
        "singleCharacterQueries": len(single_characters),
        "scopePairs": len(pair_groups),
        "selectedScopes": {scope: selected_scopes[scope] for scope in SCOPES},
        "relevance": {
            "targets": sum(len(case["relevance"]) for case in retrieval_cases),
            "gradeAtLeast2Average": round(sum(grade_two_counts) / len(retrieval_cases), 4),
            "multiTargetCases": sum(count >= 2 for count in grade_two_counts),
            "multiTargetShare": round(sum(count >= 2 for count in grade_two_counts) / len(retrieval_cases), 4),
            "grades": {str(grade): grade_counts[grade] for grade in (3, 2, 1)},
        },
        "evidence": {
            "expectations": sum(len(case["evidenceExpectations"]) for case in retrieval_cases),
            "scopes": {scope: evidence_scopes[scope] for scope in SCOPES},
        },
        "forbiddenTargets": sum(len(case["forbidden"]) for case in cases),
        "novelTargetCases": len(novel_cases),
        "novelTargetShare": round(len(novel_cases) / len(retrieval_cases), 4),
        "candidatePools": {source: {"cases": source_counts[source], "share": round(source_counts[source] / source_total, 4)} for source in "ABC"},
        "doubleReviewedCases": sum(case["auditStatus"] == "double-reviewed" for case in cases),
        "developmentOverlap": {"query": 0, "normalizedQuery": 0, "manualNearDuplicateIntent": 0, "singleCharacter": 0, "leakageGroup": 0},
        "reverseSearch": {
            "bytes": reverse_db.stat().st_size,
            "sha256": reverse_sha256,
            "schemaVersion": metadata.get("schema_version"),
            "projectionVersion": metadata.get("projection_version"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--holdout", type=Path, default=DEFAULT_HOLDOUT)
    parser.add_argument("--development", type=Path, default=DEFAULT_DEVELOPMENT)
    parser.add_argument("--reverse-db", type=Path, default=DEFAULT_REVERSE_DB)
    args = parser.parse_args()
    print(json.dumps(validate(args.holdout, args.development, args.reverse_db), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
