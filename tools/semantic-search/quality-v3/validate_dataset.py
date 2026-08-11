"""Validate the quality-v3 development set against its reverse-search corpus."""

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
DEFAULT_DATA = HERE / "development.json"
DEFAULT_REVERSE_DB = REPOSITORY / "data" / "reverse-search.db"
SCOPES = frozenset(("sense", "phrase", "usage", "example", "form"))
LENGTH_BANDS = ("1-3", "4-6", "7-12", "13-24")
EXPECTED_CASES = 144
EXPECTED_REVERSE_BYTES = 89_268_224
EXPECTED_REVERSE_SHA256 = "918659296faf552472d512208f0d7aa1712ab95e9104a7f1bf9d68ecf1adc9d1"
EXPECTED_REVERSE_SCHEMA = "7"
EXPECTED_PROJECTION_VERSION = "1.6"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def query_band(query: str) -> str:
    length = len(query.strip())
    for lower, upper, label in ((1, 3, "1-3"), (4, 6, "4-6"), (7, 12, "7-12"), (13, 24, "13-24")):
        if lower <= length <= upper:
            return label
    raise ValueError(f"query length outside 1..24: {query!r}")


def normalized_query(query: str) -> str:
    normalized = unicodedata.normalize("NFKC", query).casefold()
    return "".join(character for character in normalized if not character.isspace() and not unicodedata.category(character).startswith("P"))


def target_key(target: dict[str, Any]) -> tuple[str, str]:
    return str(target.get("entryId", "")), str(target.get("headword", "")).casefold()


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


def load_cases(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, list), "development data must be a JSON array")
    require(all(isinstance(case, dict) for case in value), "every case must be an object")
    return value


def _load_annotated_documents(
    db: sqlite3.Connection,
    entry_ids: Iterable[str],
) -> dict[str, list[sqlite3.Row]]:
    selected = sorted(set(entry_ids))
    if not selected:
        return {}
    placeholders = ",".join("?" for _ in selected)
    rows = db.execute(
        "SELECT entry_id, headword, scope, candidate_text, definition_text, chinese_text, english_text, "
        "section, part, owner_id, path_json "
        f"FROM documents WHERE entry_id IN ({placeholders})",
        selected,
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["entry_id"]].append(row)
    return grouped


def _evidence_matches(row: sqlite3.Row, evidence: dict[str, Any]) -> bool:
    location = evidence["location"]
    return (
        row["scope"] == evidence["scope"]
        and evidence["contains"] in (row["chinese_text"] + "\n" + row["english_text"])
        and row["section"] == location["section"]
        and ("part" not in location or row["part"] == location["part"])
        and ("ownerId" not in location or row["owner_id"] == location["ownerId"])
        and json.loads(row["path_json"]) == location["path"]
    )


def _validate_evidence_shape(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label}: evidence must be an object")
    require(value.get("scope") in SCOPES, f"{label}: unsupported evidence scope")
    require(isinstance(value.get("contains"), str) and value["contains"].strip(), f"{label}: evidence.contains must be non-empty")
    location = value.get("location")
    require(isinstance(location, dict), f"{label}: evidence.location must be an object")
    require(isinstance(location.get("section"), str) and location["section"], f"{label}: evidence.location.section must be non-empty")
    for field in ("part", "ownerId"):
        if field in location:
            require(isinstance(location[field], str) and location[field], f"{label}: evidence.location.{field} must be non-empty when present")
    require(isinstance(location.get("path"), list) and all(isinstance(part, str) for part in location["path"]), f"{label}: evidence.location.path must be a string array")
    return value


def validate(data_path: Path, reverse_db: Path) -> dict[str, Any]:
    cases = load_cases(data_path)
    require(120 <= len(cases) <= 160, "development set must contain 120..160 cases")
    require(len(cases) == EXPECTED_CASES, f"expected {EXPECTED_CASES} checked-in development cases")

    identifiers: set[str] = set()
    query_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    normalized_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pair_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    leakage_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    all_entry_ids: set[str] = set()
    missing_headwords: set[str] = set()

    for index, case in enumerate(cases):
        label = f"development[{index}]"
        for field in ("id", "query", "split", "category", "scopes", "expectation", "intent", "tags", "queryStyle", "isNaturalQuery", "queryLength", "lengthBand", "relevance", "evidenceExpectations", "forbidden"):
            require(field in case, f"{label}: missing {field}")
        require(isinstance(case["id"], str) and case["id"], f"{label}: id must be non-empty")
        require(case["id"] not in identifiers, f"{label}: duplicate id {case['id']}")
        identifiers.add(case["id"])
        require(isinstance(case["query"], str) and case["query"].strip(), f"{case['id']}: query must be non-empty")
        require("\n" not in case["query"] and "\r" not in case["query"], f"{case['id']}: query must be one line")
        require(case["split"] == "development", f"{case['id']}: only development rows are allowed")
        require(isinstance(case["category"], str) and case["category"], f"{case['id']}: category must be non-empty")
        require(isinstance(case["intent"], str) and case["intent"], f"{case['id']}: intent must be non-empty")
        require(isinstance(case["tags"], list) and all(isinstance(tag, str) and tag for tag in case["tags"]), f"{case['id']}: tags must be strings")
        require(isinstance(case["queryStyle"], str) and case["queryStyle"], f"{case['id']}: queryStyle must be non-empty")
        require(isinstance(case["isNaturalQuery"], bool), f"{case['id']}: isNaturalQuery must be boolean")
        require(case["queryLength"] == len(case["query"].strip()), f"{case['id']}: stale queryLength")
        require(case["lengthBand"] == query_band(case["query"]), f"{case['id']}: stale lengthBand")
        require(isinstance(case["scopes"], list) and case["scopes"], f"{case['id']}: scopes must be non-empty")
        require(len(case["scopes"]) == len(set(case["scopes"])) and set(case["scopes"]).issubset(SCOPES), f"{case['id']}: scopes must be unique supported values")
        require(case["expectation"] in ("retrieval", "gap"), f"{case['id']}: invalid expectation")
        require(isinstance(case["relevance"], list), f"{case['id']}: relevance must be an array")
        require(isinstance(case["evidenceExpectations"], list), f"{case['id']}: evidenceExpectations must be an array")
        require(isinstance(case["forbidden"], list), f"{case['id']}: forbidden must be an array")

        query_groups[case["query"]].append(case)
        normalized_groups[normalized_query(case["query"])].append(case)
        if "pairGroup" in case:
            require(isinstance(case["pairGroup"], str) and case["pairGroup"], f"{case['id']}: pairGroup must be non-empty")
            require(isinstance(case.get("pairRole"), str) and case["pairRole"], f"{case['id']}: pairRole is required with pairGroup")
            pair_groups[case["pairGroup"]].append(case)
        else:
            require("pairRole" not in case, f"{case['id']}: pairRole requires pairGroup")
        if "leakageGroup" in case:
            require(isinstance(case["leakageGroup"], str) and case["leakageGroup"], f"{case['id']}: leakageGroup must be non-empty")
            leakage_groups[case["leakageGroup"]].append(case)

        relevance_keys: set[tuple[str, str]] = set()
        relevance_grades: dict[tuple[str, str], int] = {}
        for target_index, target in enumerate(case["relevance"]):
            target_label = f"{case['id']}.relevance[{target_index}]"
            require(isinstance(target, dict), f"{target_label}: target must be an object")
            require(isinstance(target.get("entryId"), str) and target["entryId"], f"{target_label}: entryId is required")
            require(isinstance(target.get("headword"), str) and target["headword"], f"{target_label}: headword is required")
            require(isinstance(target.get("grade"), int) and 1 <= target["grade"] <= 3, f"{target_label}: grade must be 1..3")
            require("evidence" not in target, f"{target_label}: entry relevance must not embed evidence")
            key = target_key(target)
            require(key not in relevance_keys, f"{target_label}: duplicate relevance target")
            relevance_keys.add(key)
            relevance_grades[key] = target["grade"]
            all_entry_ids.add(target["entryId"])

        evidence_keys: set[tuple[str, str, str, str, str]] = set()
        covered_relevance: set[tuple[str, str]] = set()
        for evidence_index, expectation in enumerate(case["evidenceExpectations"]):
            evidence_label = f"{case['id']}.evidenceExpectations[{evidence_index}]"
            require(isinstance(expectation, dict), f"{evidence_label}: expectation must be an object")
            require(isinstance(expectation.get("entryId"), str) and expectation["entryId"], f"{evidence_label}: entryId is required")
            require(isinstance(expectation.get("headword"), str) and expectation["headword"], f"{evidence_label}: headword is required")
            require(isinstance(expectation.get("grade"), int) and 1 <= expectation["grade"] <= 3, f"{evidence_label}: grade must be 1..3")
            key = target_key(expectation)
            require(key in relevance_keys, f"{evidence_label}: evidence must refer to a relevance target")
            require(expectation["grade"] == relevance_grades[key], f"{evidence_label}: grade must match entry relevance")
            evidence = _validate_evidence_shape(expectation.get("evidence"), evidence_label)
            require(evidence["scope"] in case["scopes"], f"{evidence_label}: evidence scope is outside requested scopes")
            location_key = json.dumps(evidence["location"], ensure_ascii=False, sort_keys=True)
            unique_key = (expectation["entryId"], expectation["headword"].casefold(), evidence["scope"], evidence["contains"], location_key)
            require(unique_key not in evidence_keys, f"{evidence_label}: duplicate evidence expectation")
            evidence_keys.add(unique_key)
            covered_relevance.add(key)
            all_entry_ids.add(expectation["entryId"])
        require(covered_relevance == relevance_keys, f"{case['id']}: every entry target needs at least one independent evidence expectation")

        forbidden_keys: set[tuple[str, str]] = set()
        for forbidden_index, target in enumerate(case["forbidden"]):
            forbidden_label = f"{case['id']}.forbidden[{forbidden_index}]"
            require(isinstance(target, dict), f"{forbidden_label}: target must be an object")
            require(isinstance(target.get("entryId"), str) and target["entryId"], f"{forbidden_label}: entryId is required")
            require(isinstance(target.get("headword"), str) and target["headword"], f"{forbidden_label}: headword is required")
            require(target.get("grade") == 0, f"{forbidden_label}: forbidden grade must be 0")
            key = target_key(target)
            require(key not in relevance_keys and key not in forbidden_keys, f"{forbidden_label}: target overlaps or duplicates another annotation")
            forbidden_keys.add(key)
            if "evidence" in target:
                evidence = _validate_evidence_shape(target["evidence"], forbidden_label)
                require(evidence["scope"] in case["scopes"], f"{forbidden_label}: forbidden evidence scope is outside requested scopes")
            all_entry_ids.add(target["entryId"])

        if case["expectation"] == "retrieval":
            require(case["relevance"], f"{case['id']}: retrieval case needs relevance")
            require(any(target["grade"] == 3 for target in case["relevance"]), f"{case['id']}: retrieval case needs a grade-3 target")
            require("gap" not in case, f"{case['id']}: retrieval case must not carry gap metadata")
        else:
            require(not case["relevance"] and not case["evidenceExpectations"], f"{case['id']}: gap case must not have positives")
            gap_value = case.get("gap")
            require(isinstance(gap_value, dict) and gap_value.get("type") == "corpus-gap", f"{case['id']}: gap must be an explicit corpus-gap")
            require(gap_value.get("absence") in ("all-scopes", "selected-scopes"), f"{case['id']}: unsupported gap absence mode")
            headwords = gap_value.get("missingHeadwords")
            require(isinstance(headwords, list) and headwords and all(isinstance(headword, str) and headword for headword in headwords), f"{case['id']}: gap missingHeadwords must be non-empty")
            missing_headwords.update(headword.casefold() for headword in headwords)

    for query, group in query_groups.items():
        if len(group) == 1:
            continue
        pair_names = {case.get("pairGroup") for case in group}
        require(len(group) == 2 and None not in pair_names and len(pair_names) == 1, f"duplicate query outside one two-row pairGroup: {query!r}")

    for signature, group in normalized_groups.items():
        if len(group) == 1:
            continue
        leakage_names = {case.get("leakageGroup") for case in group}
        require(None not in leakage_names and len(leakage_names) == 1, f"normalized duplicate lacks one leakageGroup: {signature!r}")

    require(len(pair_groups) >= 20, "at least 20 scope-pair groups are required")
    for name, group in pair_groups.items():
        require(len(group) == 2, f"{name}: scope pair must contain exactly two cases")
        require(len({case["query"] for case in group}) == 1, f"{name}: scope pair queries must be identical")
        require(len({case["pairRole"] for case in group}) == 2, f"{name}: pair roles must differ")
        require(set(group[0]["scopes"]).isdisjoint(group[1]["scopes"]), f"{name}: paired scopes must be disjoint")
        require(group[0].get("leakageGroup") == group[1].get("leakageGroup"), f"{name}: pair must stay in one leakage group")
        target_sets = [{target_key(target) for target in case["relevance"]} for case in group]
        require(target_sets[0] != target_sets[1], f"{name}: scope intervention must change the annotated target set")

    retrieval_cases = [case for case in cases if case["expectation"] == "retrieval"]
    gap_cases = [case for case in cases if case["expectation"] == "gap"]
    target_counts = [len(case["relevance"]) for case in retrieval_cases]
    multi_target_cases = sum(count >= 2 for count in target_counts)
    require(multi_target_cases / len(retrieval_cases) >= 2 / 3, "fewer than two thirds of retrieval cases have multiple targets")
    require(sum(target_counts) / len(target_counts) >= 2.5, "average relevance targets per retrieval case is below 2.5")
    single_character = [case for case in cases if len(case["query"]) == 1]
    require(len(single_character) >= 10, "at least 10 single-character queries are required")
    require(all({"single-character", "high-frequency", "polysemy", "stability"}.issubset(case["tags"]) for case in single_character), "single-character cases must identify their stability and polysemy purpose")
    require(sum(case["isNaturalQuery"] for case in cases) / len(cases) >= 0.9, "natural queries must dominate the set")

    length_counts = Counter(case["lengthBand"] for case in cases)
    length_shares = {band: length_counts[band] / len(cases) for band in LENGTH_BANDS}
    for band, expected, tolerance in (("1-3", 0.45, 0.035), ("4-6", 0.30, 0.035), ("7-12", 0.18, 0.035), ("13-24", 0.07, 0.025)):
        require(abs(length_shares[band] - expected) <= tolerance, f"length band {band} is outside its scenario-balance tolerance")

    required_categories = {
        "direct-translation", "high-frequency-polysemy", "phrase-idiom", "colloquial-network",
        "synonym-near", "terminology", "usage-metalanguage", "example-fragment",
        "descriptive-reverse", "negation-contrast", "robustness-format", "broad-recall",
        "morphology-derivation", "corpus-gap", "example-scenario",
    }
    category_counts = Counter(case["category"] for case in cases)
    require(required_categories.issubset(category_counts), "required scenario categories are missing")
    required_tags = {"scope-filter", "network-expression", "mixed-input", "contrast", "evidence-ranking", "derived-form", "high-recall"}
    observed_tags = {tag for case in cases for tag in case["tags"]}
    require(required_tags.issubset(observed_tags), "required cross-cutting scenarios are missing")

    with open_read_only(reverse_db) as db:
        documents = _load_annotated_documents(db, all_entry_ids)
        for case in cases:
            relevance_by_key = {target_key(target): target for target in case["relevance"]}
            for target in (*case["relevance"], *case["forbidden"]):
                rows = documents.get(target["entryId"], [])
                require(any(row["headword"].casefold() == target["headword"].casefold() for row in rows), f"{case['id']}: target identity is absent from the sidecar")
                require(any(row["headword"].casefold() == target["headword"].casefold() and row["scope"] in case["scopes"] for row in rows), f"{case['id']}: annotated target has no document in requested scopes")
            for expectation in case["evidenceExpectations"]:
                rows = documents.get(expectation["entryId"], [])
                matched_rows = [row for row in rows if row["headword"].casefold() == expectation["headword"].casefold() and _evidence_matches(row, expectation["evidence"])]
                require(matched_rows, f"{case['id']}: evidence expectation is absent from the sidecar")
                if expectation["evidence"]["scope"] == "phrase":
                    require(all(row["candidate_text"].strip() for row in matched_rows), f"{case['id']}: phrase evidence requires non-empty candidate_text")
                require(target_key(expectation) in relevance_by_key, f"{case['id']}: orphan evidence expectation")
            for forbidden in case["forbidden"]:
                if "evidence" in forbidden:
                    rows = documents.get(forbidden["entryId"], [])
                    require(any(row["headword"].casefold() == forbidden["headword"].casefold() and _evidence_matches(row, forbidden["evidence"]) for row in rows), f"{case['id']}: forbidden evidence is absent from the sidecar")

        if missing_headwords:
            placeholders = ",".join("?" for _ in missing_headwords)
            present_rows = db.execute(
                f"SELECT lower(headword) AS headword, scope FROM documents WHERE lower(headword) IN ({placeholders})",
                sorted(missing_headwords),
            ).fetchall()
            present_by_headword: dict[str, set[str]] = defaultdict(set)
            for row in present_rows:
                present_by_headword[row["headword"]].add(row["scope"])
            for case in gap_cases:
                gap_value = case["gap"]
                for headword in gap_value["missingHeadwords"]:
                    present_scopes = present_by_headword[headword.casefold()]
                    if gap_value["absence"] == "all-scopes":
                        require(not present_scopes, f"{case['id']}: declared all-scope gap is present: {headword}")
                    else:
                        require(present_scopes, f"{case['id']}: selected-scope gap must exist elsewhere: {headword}")
                        require(present_scopes.isdisjoint(case["scopes"]), f"{case['id']}: declared selected-scope gap is present: {headword}")

        corpus_scope_counts = {row["scope"]: row["count"] for row in db.execute("SELECT scope, count(*) AS count FROM documents GROUP BY scope")}
        metadata = {row["key"]: row["value"] for row in db.execute("SELECT key, value FROM metadata")}

    evidence_scope_counts = Counter(
        expectation["evidence"]["scope"]
        for case in retrieval_cases
        for expectation in case["evidenceExpectations"]
    )
    require(all(evidence_scope_counts[scope] > 0 for scope in ("sense", "phrase", "usage", "example")), "retrievable evidence must cover sense, phrase, usage and example")
    require(corpus_scope_counts.get("form", 0) == 0, "form-gap assumption changed; re-annotate form evidence before use")
    require(any(case["gap"]["absence"] == "selected-scopes" and "form" in case["scopes"] for case in gap_cases), "empty form scope must be represented as a selected-scope corpus gap")

    grade_counts = Counter(target["grade"] for case in retrieval_cases for target in case["relevance"])
    selected_scope_counts = Counter(scope for case in cases for scope in case["scopes"])
    multi_leakage_groups = {name: len(group) for name, group in leakage_groups.items() if len(group) > 1}
    reverse_sha256 = sha256_file(reverse_db)
    require(reverse_db.stat().st_size == EXPECTED_REVERSE_BYTES, "reverse sidecar byte-size pin changed")
    require(reverse_sha256 == EXPECTED_REVERSE_SHA256, "reverse sidecar SHA-256 pin changed")
    require(metadata.get("schema_version") == EXPECTED_REVERSE_SCHEMA, "reverse sidecar schema pin changed")
    require(metadata.get("projection_version") == EXPECTED_PROJECTION_VERSION, "reverse projection pin changed")

    return {
        "schemaVersion": "quality-v3.0",
        "data": str(data_path),
        "cases": len(cases),
        "retrievalCases": len(retrieval_cases),
        "gapCases": len(gap_cases),
        "categories": dict(sorted(category_counts.items())),
        "lengthBands": {band: {"cases": length_counts[band], "share": round(length_shares[band], 4)} for band in LENGTH_BANDS},
        "naturalQueries": sum(case["isNaturalQuery"] for case in cases),
        "singleCharacterQueries": len(single_character),
        "relevance": {
            "targets": sum(target_counts),
            "averagePerRetrievalCase": round(sum(target_counts) / len(target_counts), 4),
            "multiTargetCases": multi_target_cases,
            "multiTargetShare": round(multi_target_cases / len(retrieval_cases), 4),
            "grades": {str(grade): grade_counts[grade] for grade in (3, 2, 1)},
        },
        "evidenceExpectations": sum(len(case["evidenceExpectations"]) for case in retrieval_cases),
        "forbiddenTargets": sum(len(case["forbidden"]) for case in cases),
        "scopePairs": len(pair_groups),
        "selectedScopes": {scope: selected_scope_counts[scope] for scope in SCOPES},
        "evidenceScopes": {scope: evidence_scope_counts[scope] for scope in SCOPES},
        "multiCaseLeakageGroups": dict(sorted(multi_leakage_groups.items())),
        "corpusScopes": {scope: corpus_scope_counts.get(scope, 0) for scope in SCOPES},
        "reverseSearch": {
            "bytes": reverse_db.stat().st_size,
            "sha256": reverse_sha256,
            "schemaVersion": metadata.get("schema_version"),
            "projectionVersion": metadata.get("projection_version"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--reverse-db", type=Path, default=DEFAULT_REVERSE_DB)
    args = parser.parse_args()
    print(json.dumps(validate(args.data, args.reverse_db), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
