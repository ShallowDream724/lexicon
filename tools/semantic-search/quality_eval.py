"""Backend-neutral evaluator for graded Chinese reverse-search quality sets."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import sqlite3
import statistics
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


SCOPES = frozenset(("sense", "phrase", "form", "usage", "example"))
SPLITS = frozenset(("development", "holdout"))
HIT_CUTOFFS = (1, 3, 5, 8)
SEMANTIC_STATUSES = frozenset(("applied", "degraded"))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _same_target_identity(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_id, right_id = left.get("entryId"), right.get("entryId")
    if left_id and right_id:
        return left_id == right_id
    left_headword, right_headword = left.get("headword"), right.get("headword")
    return bool(left_headword and right_headword and left_headword.casefold() == right_headword.casefold())


def _normalized_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value)).casefold()


def _normalized_headword(value: Any) -> str:
    return "".join(
        character for character in _normalized_text(value)
        if not character.isspace() and not unicodedata.category(character).startswith(("P", "S"))
    )


def _query_signature(value: Any) -> str:
    return "".join(
        character for character in _normalized_text(value)
        if not character.isspace() and not unicodedata.category(character).startswith(("P", "S"))
    )


def _semantic_eligible(query: str) -> bool:
    cjk = sum(
        ("\u3400" <= character <= "\u4dbf")
        or ("\u4e00" <= character <= "\u9fff")
        or ("\uf900" <= character <= "\ufaff")
        or (0x20000 <= ord(character) <= 0x2EBEF)
        for character in query
    )
    return len(query) <= 200 and cjk >= 2


def _validate_location(value: Any, source: str) -> None:
    _require(isinstance(value, dict), f"{source}: evidence.location must be an object")
    for key in ("section", "part", "ownerId"):
        if key in value:
            _require(isinstance(value[key], str) and value[key], f"{source}: evidence.location.{key} must be a non-empty string")
    if "path" in value:
        _require(isinstance(value["path"], list) and all(isinstance(item, str) for item in value["path"]), f"{source}: evidence.location.path must be a string array")


def _validate_target(value: Any, source: str, allow_grade: bool, require_grade: bool = True) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{source}: target must be an object")
    has_id = isinstance(value.get("entryId"), str) and bool(value["entryId"])
    has_headword = isinstance(value.get("headword"), str) and bool(value["headword"].strip())
    _require(has_id or has_headword, f"{source}: target needs entryId or headword")
    if allow_grade:
        if require_grade or "grade" in value:
            _require(isinstance(value.get("grade"), int) and 0 <= value["grade"] <= 3, f"{source}: grade must be an integer from 0 to 3")
    elif "grade" in value:
        _require(value["grade"] == 0, f"{source}: forbidden targets may only use grade 0")
    evidence = value.get("evidence")
    if evidence is not None:
        _require(isinstance(evidence, dict), f"{source}: evidence must be an object")
        if "scope" in evidence:
            _require(evidence["scope"] in SCOPES, f"{source}: unsupported evidence scope")
        if "contains" in evidence:
            _require(isinstance(evidence["contains"], str) and evidence["contains"].strip(), f"{source}: evidence.contains must be a non-empty string")
        if "location" in evidence:
            _validate_location(evidence["location"], source)
    return value


def validate_cases(value: Any, source: str = "quality data") -> list[dict[str, Any]]:
    """Validate data without assuming a particular API or search implementation."""
    _require(isinstance(value, list), f"{source}: root must be an array")
    identifiers: set[str] = set()
    queries: dict[str, list[dict[str, Any]]] = {}
    query_signatures: dict[str, list[dict[str, Any]]] = {}
    pair_queries: dict[str, str] = {}
    leakage_splits: dict[str, str] = {}
    cases: list[dict[str, Any]] = []
    for index, case in enumerate(value):
        label = f"{source}[{index}]"
        _require(isinstance(case, dict), f"{label}: case must be an object")
        for field in ("id", "query", "split", "category", "scopes", "relevance"):
            _require(field in case, f"{label}: missing {field}")
        _require(isinstance(case["id"], str) and case["id"], f"{label}: id must be a non-empty string")
        _require(case["id"] not in identifiers, f"{label}: duplicate id {case['id']}")
        identifiers.add(case["id"])
        _require(isinstance(case["query"], str) and case["query"].strip(), f"{label}: query must be a non-empty string")
        _require(case["split"] in SPLITS, f"{label}: split must be development or holdout")
        _require(isinstance(case["category"], str) and case["category"], f"{label}: category must be a non-empty string")
        _require(isinstance(case["scopes"], list) and case["scopes"], f"{label}: scopes must be a non-empty array")
        _require(len(case["scopes"]) == len(set(case["scopes"])) and set(case["scopes"]).issubset(SCOPES), f"{label}: scopes must be unique supported scopes")
        same_query = queries.setdefault(case["query"], [])
        pair_group = case.get("pairGroup")
        if pair_group is not None:
            _require(isinstance(pair_group, str) and pair_group, f"{label}: pairGroup must be a non-empty string")
            _require(pair_queries.setdefault(pair_group, case["query"]) == case["query"], f"{label}: one pairGroup cannot contain different queries")
        if same_query:
            _require(isinstance(pair_group, str) and pair_group and all(previous.get("pairGroup") == pair_group for previous in same_query), f"{label}: duplicate query requires one shared pairGroup")
            _require(all(previous["split"] == case["split"] for previous in same_query), f"{label}: paired queries cannot cross evaluation splits")
            _require(all(set(previous["scopes"]) != set(case["scopes"]) for previous in same_query), f"{label}: paired query scopes must differ")
        same_query.append(case)
        leakage_group = case.get("leakageGroup")
        if leakage_group is not None:
            _require(isinstance(leakage_group, str) and leakage_group, f"{label}: leakageGroup must be a non-empty string")
            _require(leakage_splits.setdefault(leakage_group, case["split"]) == case["split"], f"{label}: one leakageGroup cannot cross evaluation splits")
        signature = _query_signature(case["query"])
        normalized_matches = query_signatures.setdefault(signature, [])
        if normalized_matches:
            _require(all(previous["split"] == case["split"] for previous in normalized_matches), f"{label}: normalized query cannot cross evaluation splits")
            if any(previous["query"] != case["query"] for previous in normalized_matches):
                _require(
                    isinstance(leakage_group, str)
                    and leakage_group
                    and all(previous.get("leakageGroup") == leakage_group for previous in normalized_matches),
                    f"{label}: normalized duplicate query requires one shared leakageGroup",
                )
        normalized_matches.append(case)
        _require(isinstance(case["relevance"], list), f"{label}: relevance must be an array")
        relevance = [_validate_target(target, label, True) for target in case["relevance"]]
        _require(all(target["grade"] >= 1 for target in relevance), f"{label}: relevance grades must be from 1 to 3")
        _require(not any(_same_target_identity(left, right) for index, left in enumerate(relevance) for right in relevance[index + 1:]), f"{label}: duplicate relevance target")
        preferred = [target for target in relevance if "preferredRank" in target]
        for target in preferred:
            _require(isinstance(target["preferredRank"], int) and 1 <= target["preferredRank"] <= 3, f"{label}: preferredRank must be an integer from 1 to 3")
            _require(target["grade"] >= 2, f"{label}: preferred targets must have grade 2 or 3")
        preferred_ranks = sorted(target["preferredRank"] for target in preferred)
        preferred_tiers = sorted(set(preferred_ranks))
        _require(not preferred or preferred_tiers == list(range(1, preferred_tiers[-1] + 1)), f"{label}: preferredRank tiers must form a contiguous prefix from 1")
        positive = any(target["grade"] >= 2 for target in relevance)
        expectation = case.get("expectation", "retrieval")
        _require(expectation in ("retrieval", "gap"), f"{label}: expectation must be retrieval or gap")
        _require(positive if expectation == "retrieval" else not relevance, f"{label}: retrieval needs a grade >=2 target; gap needs no relevance")
        forbidden = case.get("forbidden", [])
        _require(isinstance(forbidden, list), f"{label}: forbidden must be an array")
        forbidden_targets = [_validate_target(target, label, False) for target in forbidden]
        _require(not any(_same_target_identity(left, right) for left in relevance for right in forbidden_targets), f"{label}: a target cannot be both relevant and forbidden")
        _require(not any(_same_target_identity(left, right) for index, left in enumerate(forbidden_targets) for right in forbidden_targets[index + 1:]), f"{label}: duplicate forbidden target")
        evidence_expectations = case.get("evidenceExpectations", [])
        _require(isinstance(evidence_expectations, list), f"{label}: evidenceExpectations must be an array")
        evidence_keys: set[str] = set()
        for expectation in evidence_expectations:
            _validate_target(expectation, label, True)
            _require(expectation["grade"] >= 1, f"{label}: evidence expectation grades must be from 1 to 3")
            _require(isinstance(expectation.get("evidence"), dict) and expectation["evidence"], f"{label}: evidence expectation needs evidence constraints")
            _require(any(_same_target_identity(expectation, target) for target in relevance), f"{label}: evidence expectation must belong to a relevant entry")
            evidence_key = json.dumps({
                "entryId": expectation.get("entryId"),
                "headword": expectation.get("headword", "").casefold(),
                "evidence": expectation["evidence"],
            }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            _require(evidence_key not in evidence_keys, f"{label}: duplicate evidence expectation")
            evidence_keys.add(evidence_key)
        for target in preferred:
            _require("evidence" in target or any(_same_target_identity(target, expectation) for expectation in evidence_expectations), f"{label}: every preferred target needs an evidence expectation")
        cases.append(case)
    return cases


def load_cases(paths: Iterable[Path]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for path in paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        merged.extend(validate_cases(data, str(path)))
    return validate_cases(merged, "combined quality data")


def apply_preference_overlays(
    cases: Iterable[dict[str, Any]],
    paths: Iterable[Path],
) -> list[dict[str, Any]]:
    """Join independently reviewed preference tiers onto immutable quality cases."""
    merged = copy.deepcopy(list(cases))
    by_id = {case["id"]: case for case in merged}
    seen_cases: set[str] = set()
    for path in paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        _require(isinstance(data, list), f"{path}: preference root must be an array")
        for index, overlay in enumerate(data):
            source = f"{path}[{index}]"
            _require(isinstance(overlay, dict), f"{source}: preference case must be an object")
            case_id = overlay.get("id")
            _require(isinstance(case_id, str) and case_id, f"{source}: preference case needs a non-empty id")
            _require(case_id in by_id, f"{source}: unknown quality case {case_id}")
            _require(case_id not in seen_cases, f"{source}: duplicate preference case {case_id}")
            seen_cases.add(case_id)
            preferred = overlay.get("preferred")
            _require(isinstance(preferred, list) and preferred, f"{source}: preferred must be a non-empty array")
            case = by_id[case_id]
            _require(
                not any("preferredRank" in target for target in case["relevance"]),
                f"{source}: quality case already contains preference ranks",
            )
            seen_targets: list[dict[str, Any]] = []
            for preferred_index, raw_target in enumerate(preferred):
                target_source = f"{source}.preferred[{preferred_index}]"
                target = _validate_target(raw_target, target_source, True)
                _require(
                    isinstance(target.get("preferredRank"), int),
                    f"{target_source}: preferredRank must be an integer",
                )
                _require(
                    not any(_same_target_identity(target, previous) for previous in seen_targets),
                    f"{target_source}: duplicate preferred target",
                )
                seen_targets.append(target)
                matches = [item for item in case["relevance"] if _same_target_identity(item, target)]
                _require(len(matches) == 1, f"{target_source}: target must match exactly one relevance item")
                relevance = matches[0]
                if target.get("entryId") and target.get("headword") and relevance.get("headword"):
                    _require(
                        _normalized_headword(target["headword"]) == _normalized_headword(relevance["headword"]),
                        f"{target_source}: headword disagrees with the quality case",
                    )
                _require(target.get("grade") == relevance.get("grade"), f"{target_source}: grade disagrees with the quality case")
                evidence = target.get("evidence")
                _require(isinstance(evidence, dict) and evidence, f"{target_source}: preferred target needs exact evidence")
                _require(
                    any(
                        _same_target_identity(target, expectation)
                        and expectation.get("grade") == target.get("grade")
                        and expectation.get("evidence") == evidence
                        for expectation in case.get("evidenceExpectations", [])
                    ),
                    f"{target_source}: evidence is not an exact reviewed expectation",
                )
                relevance["preferredRank"] = target["preferredRank"]
                relevance["evidence"] = copy.deepcopy(evidence)
    return validate_cases(merged, "quality data with preference overlays")


def validate_query_disjoint(
    cases: Iterable[dict[str, Any]],
    reference_paths: Iterable[Path],
) -> None:
    """Reject exact normalized-query leakage from any earlier evaluation corpus."""
    current = {_query_signature(case["query"]): case["query"] for case in cases}
    collisions: list[str] = []
    for path in reference_paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        _require(isinstance(data, list), f"disjoint reference must be an array: {path}")
        for index, row in enumerate(data):
            _require(
                isinstance(row, dict) and isinstance(row.get("query"), str) and row["query"].strip(),
                f"{path}[{index}]: disjoint reference needs a non-empty query",
            )
            signature = _query_signature(row["query"])
            if signature in current:
                collisions.append(
                    f"{current[signature]!r} overlaps {row['query']!r} in {path}",
                )
    if collisions:
        raise ValueError("query leakage:\n" + "\n".join(sorted(set(collisions))))


def validate_against_reverse(cases: Iterable[dict[str, Any]], reverse_db: Path) -> None:
    """Ensure every labelled target is anchored in its requested search scope."""
    uri = reverse_db.resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    issues: list[str] = []
    try:
        for case in cases:
            for target in (*case["relevance"], *case.get("forbidden", []), *case.get("evidenceExpectations", [])):
                clauses: list[str] = []
                values: list[str] = []
                if "entryId" in target:
                    clauses.append("entry_id = ?"); values.append(target["entryId"])
                if "headword" in target:
                    clauses.append("headword = ?"); values.append(target["headword"])
                evidence = target.get("evidence", {})
                target_scopes = [evidence["scope"]] if "scope" in evidence else case["scopes"]
                if not set(target_scopes).issubset(case["scopes"]):
                    issues.append(f"{case['id']}: target evidence scope is outside requested scopes")
                    continue
                placeholders = ",".join("?" for _ in target_scopes)
                clauses.append(f"scope IN ({placeholders})"); values.extend(target_scopes)
                location = evidence.get("location", {})
                for column, key in (("section", "section"), ("part", "part"), ("owner_id", "ownerId")):
                    if key in location:
                        clauses.append(f"{column} = ?"); values.append(location[key])
                if "path" in location:
                    clauses.append("path_json = ?")
                    values.append(json.dumps(location["path"], ensure_ascii=False, separators=(",", ":")))
                rows = db.execute(
                    "SELECT chinese_text, english_text, candidate_text, definition_text FROM documents WHERE "
                    + " AND ".join(clauses),
                    values,
                ).fetchall()
                if "contains" in evidence:
                    needle = _normalized_text(evidence["contains"])
                    rows = [row for row in rows if any(needle in _normalized_text(value) for value in row)]
                if not rows:
                    identity = target.get("entryId") or target.get("headword") or "unknown"
                    issues.append(
                        f"{case['id']} ({identity}): labelled target is absent from requested scopes in {reverse_db.name}",
                    )
    finally:
        db.close()
    if issues:
        raise ValueError("reverse evidence validation failed:\n" + "\n".join(sorted(set(issues))))


def file_metadata(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def _matches_identity(item: dict[str, Any], target: dict[str, Any]) -> bool:
    if "entryId" in target:
        return item.get("id") == target["entryId"]
    return "headword" in target and _normalized_headword(item.get("headword", "")) == _normalized_headword(target["headword"])


def _matches_evidence(match: dict[str, Any], evidence: dict[str, Any]) -> bool:
    if "scope" in evidence and match.get("scope") != evidence["scope"]:
        return False
    text = "\n".join(str(match.get(field, "")) for field in ("candidateText", "definitionText", "chineseText", "englishText"))
    if "contains" in evidence and _normalized_text(evidence["contains"]) not in _normalized_text(text):
        return False
    expected_location = evidence.get("location", {})
    location = match.get("location", {})
    return not any(location.get(api_key) != expected for api_key, expected in (("section", expected_location.get("section")), ("part", expected_location.get("part")), ("ownerId", expected_location.get("ownerId")), ("path", expected_location.get("path"))) if expected is not None)


def _matches_target(item: dict[str, Any], target: dict[str, Any]) -> bool:
    if not _matches_identity(item, target):
        return False
    evidence = target.get("evidence")
    return not evidence or any(_matches_evidence(match, evidence) for match in item["matches"])


def _item_grade(item: dict[str, Any], case: dict[str, Any]) -> int:
    return max((target["grade"] for target in case["relevance"] if _matches_identity(item, target)), default=0)


def _preferred_metrics(
    case: dict[str, Any],
    ranked: list[dict[str, Any]],
    evidence_expectations: list[dict[str, Any]],
) -> dict[str, Any]:
    preferred = sorted(
        (target for target in case["relevance"] if "preferredRank" in target),
        key=lambda target: (
            target["preferredRank"],
            str(target.get("entryId", "")),
            _normalized_headword(target.get("headword", "")),
        ),
    )
    if not preferred:
        return {
            "preferredCount": 0,
            "preferredWidth": 0,
            "canonicalEntryAt1": None,
            "canonicalEntryAndEvidenceAt1": None,
            "preferredPrefixSetAtAvailable": None,
            "preferredPrefixOrderAtAvailable": None,
            "preferredPrefixNdcgAtAvailable": None,
            "preferredFirstEvidenceRate": None,
            "firstScreenPassAtAvailable": None,
            "preferredSetAt3": None,
            "preferredOrderAt3": None,
            "preferredNdcgAt3": None,
            "preferredEvidenceAt1": None,
            "firstScreenPassAt3": None,
        }

    width = min(3, len(preferred))
    actual = ranked[:width]
    canonical_entry = bool(actual and any(target["preferredRank"] == 1 and _matches_identity(actual[0], target) for target in preferred))
    actual_targets = [next((target for target in preferred if _matches_identity(item, target)), None) for item in actual]
    actual_tiers = [target["preferredRank"] if target else 0 for target in actual_targets]
    ideal_tiers = sorted(target["preferredRank"] for target in preferred)[:width]
    set_pass = len(actual) == width and sorted(actual_tiers) == ideal_tiers
    order_pass = set_pass and actual_tiers == ideal_tiers

    gains_by_rank = {target["preferredRank"]: 4 - target["preferredRank"] for target in preferred}
    actual_gains = [
        next((gains_by_rank[target["preferredRank"]] for target in preferred if _matches_identity(item, target)), 0)
        for item in ranked[:3]
    ]
    ideal_gains = [4 - tier for tier in ideal_tiers]
    dcg = sum((2**gain - 1) / math.log2(index + 2) for index, gain in enumerate(actual_gains))
    idcg = sum((2**gain - 1) / math.log2(index + 2) for index, gain in enumerate(ideal_gains))

    evidence_hits: list[bool] = []
    for item, target in zip(actual, actual_targets):
        expectations = [] if target is None else [expectation for expectation in evidence_expectations if _same_target_identity(target, expectation)]
        if target is not None and not expectations and isinstance(target.get("evidence"), dict):
            expectations = [target]
        evidence_hits.append(bool(
            target
            and item.get("matches")
            and any(_matches_evidence(item["matches"][0], expectation["evidence"]) for expectation in expectations)
        ))
    evidence_rate = sum(evidence_hits) / width
    canonical_evidence = canonical_entry and bool(evidence_hits and evidence_hits[0])
    return {
        "preferredCount": len(preferred),
        "preferredWidth": width,
        "canonicalEntryAt1": float(canonical_entry),
        "canonicalEntryAndEvidenceAt1": float(canonical_evidence),
        "preferredPrefixSetAtAvailable": float(set_pass),
        "preferredPrefixOrderAtAvailable": float(order_pass),
        "preferredPrefixNdcgAtAvailable": dcg / idcg if idcg else 0.0,
        "preferredFirstEvidenceRate": evidence_rate,
        "firstScreenPassAtAvailable": float(order_pass and all(evidence_hits)),
        # Compatibility aliases for reports produced during quality-v3.1 development.
        "preferredSetAt3": float(set_pass),
        "preferredOrderAt3": float(order_pass),
        "preferredNdcgAt3": dcg / idcg if idcg else 0.0,
        "preferredEvidenceAt1": evidence_rate,
        "firstScreenPassAt3": float(order_pass and all(evidence_hits)) if width == 3 else None,
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percentile
    lower, upper = math.floor(index), math.ceil(index)
    return ordered[lower] if lower == upper else ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


@dataclass
class HTTPSearchClient:
    base_url: str
    endpoint: str = "/api/v1/search"
    timeout_seconds: float = 10.0

    def search(self, case: dict[str, Any], limit: int, mode: str | None) -> tuple[list[dict[str, Any]], float, str | None]:
        parameters: list[tuple[str, str]] = [("q", case["query"]), ("limit", str(limit)), ("scope", ",".join(case["scopes"]))]
        if mode:
            parameters.append(("mode", mode))
        url = self.base_url.rstrip("/") + self.endpoint + "?" + urllib.parse.urlencode(parameters)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(url, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{case['id']}: API returned HTTP {error.code}") from error
        elapsed_ms = (time.perf_counter() - started) * 1000
        _require(isinstance(payload, dict) and isinstance(payload.get("items"), list), f"{case['id']}: API response must contain items array")
        status = payload.get("semanticStatus")
        _require(status is None or status in SEMANTIC_STATUSES, f"{case['id']}: unsupported semanticStatus {status!r}")
        items = payload["items"]
        identifiers: set[str] = set()
        for index, item in enumerate(items):
            source = f"{case['id']}: items[{index}]"
            _require(isinstance(item, dict), f"{source} must be an object")
            _require(isinstance(item.get("id"), str) and item["id"], f"{source}.id must be a non-empty string")
            _require(item["id"] not in identifiers, f"{case['id']}: duplicate result id {item['id']}")
            identifiers.add(item["id"])
            _require(isinstance(item.get("headword"), str) and item["headword"], f"{source}.headword must be a non-empty string")
            _require(isinstance(item.get("matches"), list), f"{source}.matches must be an array")
            for match_index, match in enumerate(item["matches"]):
                _require(isinstance(match, dict), f"{source}.matches[{match_index}] must be an object")
                _require(match.get("scope") in SCOPES, f"{source}.matches[{match_index}] has an unsupported scope")
        return items, elapsed_ms, status


def _evidence_rank(item: dict[str, Any], target: dict[str, Any]) -> int | None:
    if not _matches_identity(item, target) or "evidence" not in target:
        return None
    return next((index for index, match in enumerate(item["matches"], 1) if _matches_evidence(match, target["evidence"])), None)


def _evidence_outcomes(
    expectations: list[dict[str, Any]],
    ranked: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    outcomes: list[dict[str, Any]] = []
    for target in expectations:
        entry_rank = next((index for index, item in enumerate(ranked, 1) if _matches_identity(item, target)), None)
        item = ranked[entry_rank - 1] if entry_rank is not None else None
        outcomes.append({
            "entryId": target.get("entryId"),
            "headword": target.get("headword"),
            "grade": target["grade"],
            "scope": target["evidence"]["scope"],
            "entryRank": entry_rank,
            "rankWithinEntry": _evidence_rank(item, target) if item else None,
        })

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for target in expectations:
        grouped.setdefault((str(target.get("entryId", "")), target["evidence"]["scope"]), []).append(target)
    group_metrics: list[dict[str, Any]] = []
    for (entry_id, scope), targets in grouped.items():
        item = next((item for item in ranked if _matches_identity(item, targets[0])), None)
        actual = [] if item is None else [
            max((target["grade"] for target in targets if _matches_evidence(match, target["evidence"])), default=0)
            for match in item["matches"][:3]
        ]
        ideal = sorted((target["grade"] for target in targets), reverse=True)[:3]
        dcg = sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(actual))
        idcg = sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(ideal))
        group_metrics.append({"entryId": entry_id, "scope": scope, "ndcgAt3": dcg / idcg if idcg else 0.0})
    return outcomes, group_metrics


def _mean(values: Iterable[float]) -> float | None:
    selected = list(values)
    return statistics.fmean(selected) if selected else None


def _pass_summary(values: Iterable[float]) -> dict[str, Any]:
    selected = list(values)
    total = len(selected)
    passed = sum(value == 1.0 for value in selected)
    if total == 0:
        return {"cases": 0, "passed": 0, "rate": None, "wilson95Lower": None}
    rate = passed / total
    z = 1.959963984540054
    denominator = 1 + z * z / total
    centre = rate + z * z / (2 * total)
    margin = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
    return {
        "cases": total,
        "passed": passed,
        "rate": rate,
        "wilson95Lower": max(0.0, (centre - margin) / denominator),
    }


def _preference_gate_summary(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    selected = list(rows)
    fields = (
        "canonicalEntryAt1",
        "canonicalEntryAndEvidenceAt1",
        "preferredPrefixSetAtAvailable",
        "preferredPrefixOrderAtAvailable",
        "firstScreenPassAtAvailable",
        "firstScreenPassAt3",
    )
    return {
        field: _pass_summary(
            row["metrics"][field]
            for row in selected
            if row["metrics"].get(field) is not None
        )
        for field in fields
    }


def _summarize(rows: list[dict[str, Any]], mode: str | None) -> dict[str, Any]:
    retrieval = [row for row in rows if row["metrics"]["entryNdcgAtK"] is not None]
    gaps = [row for row in rows if row["expectation"] == "gap"]
    returned_count = sum(row["returned"] for row in rows)
    evidence_targets = sum(row["metrics"]["evidenceTargets"] for row in rows)
    evidence_groups = sum(row["metrics"]["evidenceNdcgGroups"] for row in rows)
    statuses = Counter(
        row["semanticStatus"] or ("not-eligible" if not row["semanticExpected"] else "unreported")
        for row in rows
    ) if mode is not None else Counter()
    semantic_expected = sum(row["semanticExpected"] for row in rows)
    preferred = [row for row in rows if row["metrics"]["preferredCount"] > 0]
    preferred_three = [row for row in preferred if row["metrics"]["preferredWidth"] == 3]
    summary: dict[str, Any] = {
        "cases": len(rows),
        "retrievalCases": len(retrieval),
        "gapCases": len(gaps),
        "entryNdcgAtK": _mean(row["metrics"]["entryNdcgAtK"] for row in retrieval),
        "mrrGradeAtLeast2": _mean(row["metrics"]["mrrGradeAtLeast2"] for row in retrieval),
        **{f"recallAt{cutoff}": _mean(row["metrics"][f"recallAt{cutoff}"] for row in retrieval) for cutoff in HIT_CUTOFFS},
        **{f"hitAt{cutoff}": _mean(row["metrics"][f"hitAt{cutoff}"] for row in retrieval) for cutoff in HIT_CUTOFFS},
        "evidenceTargets": evidence_targets,
        **{f"evidenceRecallAt{cutoff}": (sum(row["metrics"][f"evidenceRecallHitsAt{cutoff}"] for row in rows) / evidence_targets if evidence_targets else None) for cutoff in HIT_CUTOFFS},
        "evidenceNdcgAt3WithinEntry": (sum(row["metrics"]["evidenceNdcgAt3Sum"] for row in rows) / evidence_groups if evidence_groups else None),
        "evidenceMrrWithinEntry": (sum(row["metrics"]["evidenceReciprocalRankSum"] for row in rows) / evidence_targets if evidence_targets else None),
        "evidenceHitAt1WithinEntry": (sum(row["metrics"]["evidenceHitAt1"] for row in rows) / evidence_targets if evidence_targets else None),
        "evidenceHitAt3WithinEntry": (sum(row["metrics"]["evidenceHitAt3"] for row in rows) / evidence_targets if evidence_targets else None),
        "preferredCases": len(preferred),
        "preferredThreeCases": len(preferred_three),
        "canonicalEntryAt1": _mean(row["metrics"]["canonicalEntryAt1"] for row in preferred),
        "canonicalEntryAndEvidenceAt1": _mean(row["metrics"]["canonicalEntryAndEvidenceAt1"] for row in preferred),
        "preferredPrefixSetAtAvailable": _mean(row["metrics"]["preferredPrefixSetAtAvailable"] for row in preferred),
        "preferredPrefixOrderAtAvailable": _mean(row["metrics"]["preferredPrefixOrderAtAvailable"] for row in preferred),
        "preferredPrefixNdcgAtAvailable": _mean(row["metrics"]["preferredPrefixNdcgAtAvailable"] for row in preferred),
        "preferredFirstEvidenceRate": _mean(row["metrics"]["preferredFirstEvidenceRate"] for row in preferred),
        "firstScreenPassAtAvailable": _mean(row["metrics"]["firstScreenPassAtAvailable"] for row in preferred),
        "preferredSetAt3": _mean(row["metrics"]["preferredSetAt3"] for row in preferred),
        "preferredOrderAt3": _mean(row["metrics"]["preferredOrderAt3"] for row in preferred),
        "preferredNdcgAt3": _mean(row["metrics"]["preferredNdcgAt3"] for row in preferred),
        "preferredEvidenceAt1": _mean(row["metrics"]["preferredEvidenceAt1"] for row in preferred),
        "firstScreenPassAt3": _mean(row["metrics"]["firstScreenPassAt3"] for row in preferred_three),
        "forbiddenItemRate": (sum(row["forbiddenCount"] for row in rows) / returned_count if returned_count else 0.0),
        "forbiddenCaseRate": (sum(row["forbiddenCount"] > 0 for row in rows) / len(rows) if rows else 0.0),
        "scopeLeakageItemRate": (sum(row["scopeLeakageCount"] for row in rows) / returned_count if returned_count else 0.0),
        "scopeLeakageCaseRate": (sum(row["scopeLeakageCount"] > 0 for row in rows) / len(rows) if rows else 0.0),
        "gapNonemptyRate": (sum(row["returned"] > 0 for row in gaps) / len(gaps) if gaps else None),
        "semanticEligibleCases": semantic_expected if mode is not None else None,
        "semanticNotEligibleCases": len(rows) - semantic_expected if mode is not None else None,
        "semanticAppliedRate": (statuses["applied"] / semantic_expected if mode is not None and semantic_expected else None),
        "semanticDegradedRate": (statuses["degraded"] / semantic_expected if mode is not None and semantic_expected else None),
        "semanticUnreportedRate": (statuses["unreported"] / semantic_expected if mode is not None and semantic_expected else None),
        "semanticStatusCounts": dict(sorted(statuses.items())) if mode is not None else {},
        "latencyMs": {
            "p50": _percentile([row["latencyMs"] for row in rows], 0.50),
            "p95": _percentile([row["latencyMs"] for row in rows], 0.95),
            "p99": _percentile([row["latencyMs"] for row in rows], 0.99),
        },
    }
    # Compatibility aliases remain for existing report consumers.
    summary["forbiddenRate"] = summary["forbiddenItemRate"]
    summary["scopeLeakageRate"] = summary["scopeLeakageItemRate"]
    summary["preferenceGates"] = _preference_gate_summary(preferred)
    summary["preferenceByWidth"] = {
        str(width): {
            "cases": sum(row["metrics"]["preferredWidth"] == width for row in preferred),
            "gates": _preference_gate_summary(
                row for row in preferred if row["metrics"]["preferredWidth"] == width
            ),
        }
        for width in (1, 2, 3)
    }
    return summary


def _macro_summary(summaries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    keys = (
        "entryNdcgAtK", "mrrGradeAtLeast2",
        *(f"recallAt{cutoff}" for cutoff in HIT_CUTOFFS),
        *(f"hitAt{cutoff}" for cutoff in HIT_CUTOFFS),
        "evidenceNdcgAt3WithinEntry", "evidenceMrrWithinEntry",
        *(f"evidenceRecallAt{cutoff}" for cutoff in HIT_CUTOFFS),
        "canonicalEntryAt1", "canonicalEntryAndEvidenceAt1",
        "preferredPrefixSetAtAvailable", "preferredPrefixOrderAtAvailable",
        "preferredPrefixNdcgAtAvailable", "preferredFirstEvidenceRate",
        "preferredSetAt3", "preferredOrderAt3", "preferredNdcgAt3",
        "preferredEvidenceAt1", "firstScreenPassAtAvailable", "firstScreenPassAt3",
    )
    return {
        key: _mean(
            summary[key]
            for summary in summaries.values()
            if summary["retrievalCases"] > 0 and summary.get(key) is not None
        )
        for key in keys
    }


def _evidence_scope_summaries(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    scopes = sorted({outcome["scope"] for row in rows for outcome in row["evidenceOutcomes"]})
    summaries: dict[str, dict[str, Any]] = {}
    for scope in scopes:
        outcomes = [outcome for row in rows for outcome in row["evidenceOutcomes"] if outcome["scope"] == scope and outcome["grade"] >= 2]
        groups = [group for row in rows for group in row["evidenceGroups"] if group["scope"] == scope]
        summaries[scope] = {
            "targets": len(outcomes),
            "ndcgAt3WithinEntry": _mean(group["ndcgAt3"] for group in groups),
            "mrrWithinEntry": _mean(0.0 if outcome["rankWithinEntry"] is None else 1.0 / outcome["rankWithinEntry"] for outcome in outcomes),
            "hitAt1WithinEntry": _mean(float(outcome["rankWithinEntry"] == 1) for outcome in outcomes),
            "hitAt3WithinEntry": _mean(float(outcome["rankWithinEntry"] is not None and outcome["rankWithinEntry"] <= 3) for outcome in outcomes),
            "recallAt8": _mean(float(outcome["entryRank"] is not None and outcome["entryRank"] <= 8 and outcome["rankWithinEntry"] is not None) for outcome in outcomes),
        }
    return summaries


def _scope_pair_report(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("pairGroup"):
            grouped.setdefault(row["pairGroup"], []).append(row)
    report: list[dict[str, Any]] = []
    for name, pair in sorted(grouped.items()):
        if len(pair) != 2:
            continue
        members = []
        for index, row in enumerate(pair):
            other = pair[1 - index]
            own_targets = set(row["relevantEntryIds"])
            other_only = set(other["relevantEntryIds"]) - own_targets
            returned_ids = {item["id"] for item in row["results"]}
            members.append({
                "role": row.get("pairRole"), "scopes": row["scopes"],
                "entryNdcgAtK": row["metrics"]["entryNdcgAtK"], "recallAt8": row["metrics"].get("recallAt8"),
                "otherScopeOnlyTargetsAt8": sorted(returned_ids & other_only),
            })
        report.append({"pairGroup": name, "query": pair[0]["query"], "members": members})
    return report


def evaluate_http(
    cases: Iterable[dict[str, Any]],
    client: HTTPSearchClient,
    mode: str | None = "hybrid",
    top_k: int = 8,
    metadata: dict[str, Any] | None = None,
    *,
    allow_holdout: bool = False,
) -> dict[str, Any]:
    _require(top_k >= max(HIT_CUTOFFS), "top_k must be at least 8")
    selected = list(cases)
    _require(allow_holdout or all(case["split"] != "holdout" for case in selected), "holdout evaluation requires explicit allow_holdout=True")
    rows: list[dict[str, Any]] = []
    for case in selected:
        items, elapsed_ms, semantic_status = client.search(case, top_k, mode)
        ranked = items[:top_k]
        grades = [_item_grade(item, case) for item in ranked]
        forbidden = [any(_matches_target(item, target) for target in case.get("forbidden", [])) for item in ranked]
        leakage_count = sum(any(match["scope"] not in case["scopes"] for match in item["matches"]) for item in ranked)
        positives = [target for target in case["relevance"] if target["grade"] >= 2]
        metrics: dict[str, Any] = {"entryNdcgAtK": None, "mrrGradeAtLeast2": None}
        if positives:
            dcg = sum((2**grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(grades))
            ideal = sorted((target["grade"] for target in case["relevance"]), reverse=True)[:top_k]
            idcg = sum((2**grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(ideal))
            first = next((index + 1 for index, grade in enumerate(grades) if grade >= 2), None)
            metrics["entryNdcgAtK"] = dcg / idcg if idcg else 0.0
            metrics["mrrGradeAtLeast2"] = 0.0 if first is None else 1.0 / first
            for cutoff in HIT_CUTOFFS:
                returned = ranked[:cutoff]
                recovered = sum(any(_matches_identity(item, target) for item in returned) for target in positives)
                metrics[f"recallAt{cutoff}"] = recovered / len(positives)
                metrics[f"hitAt{cutoff}"] = float(any(grade >= 2 for grade in grades[:cutoff]))
        evidence_expectations = case.get("evidenceExpectations")
        if evidence_expectations is None:
            evidence_expectations = [target for target in case["relevance"] if "evidence" in target]
        evidence_outcomes, evidence_groups = _evidence_outcomes(evidence_expectations, ranked)
        evidence_targets = [outcome for outcome in evidence_outcomes if outcome["grade"] >= 2]
        metrics.update({
            "evidenceTargets": len(evidence_targets),
            **{f"evidenceRecallHitsAt{cutoff}": sum(
                outcome["entryRank"] is not None and outcome["entryRank"] <= cutoff and outcome["rankWithinEntry"] is not None
                for outcome in evidence_targets
            ) for cutoff in HIT_CUTOFFS},
            "evidenceNdcgGroups": len(evidence_groups),
            "evidenceNdcgAt3Sum": sum(group["ndcgAt3"] for group in evidence_groups),
            "evidenceReciprocalRankSum": sum(1.0 / outcome["rankWithinEntry"] for outcome in evidence_targets if outcome["rankWithinEntry"] is not None),
            "evidenceHitAt1": sum(outcome["rankWithinEntry"] == 1 for outcome in evidence_targets),
            "evidenceHitAt3": sum(outcome["rankWithinEntry"] is not None and outcome["rankWithinEntry"] <= 3 for outcome in evidence_targets),
        })
        metrics.update(_preferred_metrics(case, ranked, evidence_expectations))
        rows.append({
            "id": case["id"], "query": case["query"], "split": case["split"], "category": case["category"], "expectation": case.get("expectation", "retrieval"),
            "scopes": case["scopes"], "tags": case.get("tags", []), "queryLength": case.get("queryLength", len(case["query"])),
            "lengthBand": case.get("lengthBand"), "pairGroup": case.get("pairGroup"), "pairRole": case.get("pairRole"),
            "leakageGroup": case.get("leakageGroup"), "gap": case.get("gap"),
            "latencyMs": round(elapsed_ms, 3), "semanticStatus": semantic_status, "semanticExpected": _semantic_eligible(case["query"]), "grades": grades,
            "forbidden": forbidden, "forbiddenCount": sum(forbidden), "scopeLeakageCount": leakage_count,
            "returned": len(ranked), "backendReturned": len(items),
            "relevantEntryIds": [target.get("entryId") for target in case["relevance"]],
            "results": [{"id": item["id"], "headword": item["headword"], "grade": grade} for item, grade in zip(ranked, grades)],
            "evidenceOutcomes": evidence_outcomes, "evidenceGroups": evidence_groups,
            "metrics": metrics,
        })
    summary = _summarize(rows, mode)
    by_category = {category: _summarize([row for row in rows if row["category"] == category], mode) for category in sorted({row["category"] for row in rows})}
    by_slice = {
        "length-1-3": _summarize([row for row in rows if row["lengthBand"] == "1-3"], mode),
        "single-character": _summarize([row for row in rows if row["queryLength"] == 1], mode),
        "high-recall": _summarize([row for row in rows if "high-recall" in row["tags"]], mode),
    }
    return {
        "schemaVersion": "quality-v3.1",
        "metadata": metadata or {},
        "summary": summary,
        "byCategory": by_category,
        "categoryMacro": _macro_summary(by_category),
        "bySlice": by_slice,
        "byEvidenceScope": _evidence_scope_summaries(rows),
        "scopePairs": _scope_pair_report(rows),
        "gapReport": [
            {"id": row["id"], "query": row["query"], "scopes": row["scopes"], "gap": row["gap"], "results": row["results"], "forbiddenCount": row["forbiddenCount"]}
            for row in rows if row["expectation"] == "gap"
        ],
        "rows": rows,
    }


def _parse_metadata(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    candidate = Path(value)
    raw = candidate.read_text(encoding="utf-8") if candidate.is_file() else value
    parsed = json.loads(raw)
    _require(isinstance(parsed, dict), "metadata must be a JSON object")
    return parsed


def _parse_assets(values: list[str]) -> dict[str, dict[str, Any]]:
    assets: dict[str, dict[str, Any]] = {}
    for value in values:
        name, separator, raw_path = value.partition("=")
        _require(bool(separator) and bool(name) and bool(raw_path), "assets must use NAME=PATH")
        _require(name not in assets, f"duplicate asset name: {name}")
        path = Path(raw_path)
        _require(path.is_file(), f"asset is missing: {path}")
        assets[name] = file_metadata(path)
    return assets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate quality data and optional pinned sidecar evidence")
    validate.add_argument("--data", type=Path, action="append", required=True)
    validate.add_argument("--preferences", type=Path, action="append", default=[])
    validate.add_argument("--reverse-db", type=Path)
    validate.add_argument("--disjoint-from", type=Path, action="append", default=[])
    run = commands.add_parser("run", help="evaluate an HTTP reverse-search endpoint")
    run.add_argument("--data", type=Path, action="append", required=True)
    run.add_argument("--preferences", type=Path, action="append", default=[])
    run.add_argument("--base-url", required=True)
    run.add_argument("--endpoint", default="/api/v1/search")
    run.add_argument("--split", choices=(*sorted(SPLITS), "all"), default="development")
    run.add_argument("--allow-holdout", action="store_true", help="explicitly permit holdout evaluation after ranking is frozen")
    run.add_argument("--mode", choices=("lexical", "hybrid"), default="hybrid")
    run.add_argument("--top-k", type=int, default=8)
    run.add_argument("--timeout-seconds", type=float, default=10.0)
    run.add_argument("--metadata-json")
    run.add_argument("--model-metadata-json", help="opaque model metadata JSON, without provider-specific assumptions")
    run.add_argument("--asset", action="append", default=[], metavar="NAME=PATH", help="hash a runtime asset into the report")
    run.add_argument("--reverse-db", type=Path)
    run.add_argument("--disjoint-from", type=Path, action="append", default=[])
    run.add_argument("--output", type=Path)
    args = parser.parse_args()
    cases = load_cases(args.data)
    cases = apply_preference_overlays(cases, args.preferences)
    validate_query_disjoint(cases, args.disjoint_from)
    if args.reverse_db:
        validate_against_reverse(cases, args.reverse_db)
    if args.command == "validate":
        preferred_widths = Counter(
            min(3, sum("preferredRank" in target for target in case["relevance"]))
            for case in cases
            if any("preferredRank" in target for target in case["relevance"])
        )
        print(json.dumps({
            "cases": len(cases),
            "splits": dict(Counter(case["split"] for case in cases)),
            "preferredWidths": dict(sorted(preferred_widths.items())),
        }, ensure_ascii=False))
        return
    filtered = cases if args.split == "all" else [case for case in cases if case["split"] == args.split]
    metadata = _parse_metadata(args.metadata_json)
    assets = _parse_assets(args.asset)
    if args.reverse_db:
        assets.setdefault("reverseSearch", file_metadata(args.reverse_db))
    if assets:
        metadata = {**metadata, "assets": assets}
    if args.model_metadata_json:
        metadata = {**metadata, "model": _parse_metadata(args.model_metadata_json)}
    report = evaluate_http(
        filtered,
        HTTPSearchClient(args.base_url, args.endpoint, args.timeout_seconds),
        None if args.mode == "lexical" else args.mode,
        args.top_k,
        metadata,
        allow_holdout=args.allow_holdout,
    )
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
