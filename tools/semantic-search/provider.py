"""OpenAI-compatible embedding transport with pre-request budget reservations."""

from __future__ import annotations

import base64
import json
import math
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener

import numpy as np


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
RESERVED_FIELDS = frozenset({"model", "input", "encoding_format", "dimensions"})


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingResult:
    vectors: np.ndarray
    prompt_tokens: int
    requests: int = 1
    unmetered: bool = False


class UsageLedger:
    """Thread-safe confirmed usage plus conservative, pre-request reservations."""

    def __init__(self, weighted_limit: float | None, multiplier: float, initial_tokens: int = 0, initial_requests: int = 0, initial_unmetered: bool = False) -> None:
        self._limit = weighted_limit
        self._multiplier = multiplier
        self._tokens = initial_tokens
        self._requests = initial_requests
        self._reserved = 0
        self._unmetered = initial_unmetered
        self._lock = threading.Lock()

    def reserve(self, prompt_tokens: int) -> int:
        if prompt_tokens < 1:
            raise ProviderError("embedding reservation must be positive")
        with self._lock:
            projected = self._tokens + self._reserved + prompt_tokens
            if self._limit is not None and projected * self._multiplier > self._limit:
                raise ProviderError("embedding budget reservation exceeds the configured limit")
            self._reserved += prompt_tokens
        return prompt_tokens

    def cancel(self, reservation: int | None) -> None:
        if reservation is None:
            return
        with self._lock:
            self._reserved -= reservation

    def settle(self, reservation: int | None, tokens: int, unmetered: bool) -> None:
        if tokens < 0:
            raise ProviderError("provider usage is invalid")
        with self._lock:
            if reservation is not None:
                if tokens > reservation:
                    raise ProviderError("provider usage exceeded its preflight reservation")
                self._reserved -= reservation
            self._tokens += tokens
            self._requests += 1
            self._unmetered = self._unmetered or unmetered

    def snapshot(self) -> dict[str, int | float | bool]:
        with self._lock:
            return {
                "promptTokens": self._tokens,
                "requests": self._requests,
                "weightedUnits": self._tokens * self._multiplier,
                "unmetered": self._unmetered,
                "reservedPromptTokens": self._reserved,
            }


def embeddings_endpoint(base_url: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        raise ValueError("base URL must be an absolute http or https URL without query or fragment")
    value = base_url.rstrip("/")
    if value.endswith("/v1/embeddings") or value.endswith("/embeddings"):
        return value
    return value + "/embeddings" if value.endswith("/v1") else value + "/v1/embeddings"


def validate_extra(extra: dict[str, Any] | None) -> dict[str, Any]:
    value = extra or {}
    conflict = RESERVED_FIELDS.intersection(value)
    if conflict:
        raise ValueError("provider extra JSON cannot override " + ", ".join(sorted(conflict)))
    return value


class OpenAIEmbeddingProvider:
    def __init__(self, base_url: str, api_key: str, model: str, dimensions: int, encoding_format: str = "float", extra: dict[str, Any] | None = None, timeout_seconds: float = 60.0, max_retries: int = 3, proxy: str | None = None, ledger: UsageLedger | None = None, allow_unmetered: bool = False) -> None:
        if not api_key or not model or dimensions < 1:
            raise ValueError("environment-supplied API key, model, and positive dimensions are required")
        if encoding_format not in {"float", "base64"}:
            raise ValueError("encoding format must be float or base64")
        self.endpoint = embeddings_endpoint(base_url)
        self.api_key, self.model, self.dimensions = api_key, model, dimensions
        self.encoding_format, self.extra = encoding_format, validate_extra(extra)
        self.timeout_seconds, self.max_retries, self.ledger = timeout_seconds, max_retries, ledger
        self.allow_unmetered = allow_unmetered
        self.opener = build_opener(ProxyHandler({"https": proxy, "http": proxy}) if proxy else ProxyHandler())

    def embed(self, texts: list[str], reserve_prompt_tokens: int | None = None) -> EmbeddingResult:
        if not texts or any(not text.strip() for text in texts):
            raise ProviderError("embedding input must contain non-empty strings")
        reservation = self.ledger.reserve(reserve_prompt_tokens) if self.ledger and reserve_prompt_tokens else None
        payload: dict[str, Any] = {"model": self.model, "input": texts, "encoding_format": self.encoding_format, "dimensions": self.dimensions}
        payload.update(self.extra)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last_error: Exception | None = None
        try:
            for attempt in range(self.max_retries + 1):
                request = Request(self.endpoint, body, {"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"}, method="POST")
                try:
                    with self.opener.open(request, timeout=self.timeout_seconds) as response:
                        payload_bytes = response.read(MAX_RESPONSE_BYTES + 1)
                    if len(payload_bytes) > MAX_RESPONSE_BYTES:
                        raise ProviderError("embedding provider response exceeds 16 MiB")
                    result = parse_embedding_response(json.loads(payload_bytes.decode("utf-8")), len(texts), self.dimensions, self.allow_unmetered)
                    if self.ledger:
                        self.ledger.settle(reservation, result.prompt_tokens, result.unmetered)
                        reservation = None
                    return result
                except HTTPError as error:
                    last_error = ProviderError(f"embedding provider returned HTTP {error.code}")
                    if error.code != 429 and error.code < 500:
                        break
                except (URLError, TimeoutError, json.JSONDecodeError) as error:
                    last_error = ProviderError("embedding provider request failed: " + str(error))
                if attempt < self.max_retries:
                    time.sleep(min(2**attempt, 8))
        finally:
            if self.ledger and reservation is not None:
                self.ledger.cancel(reservation)
        raise last_error or ProviderError("embedding provider request failed")


def parse_embedding_response(body: Any, expected_count: int, dimensions: int, allow_unmetered: bool = False) -> EmbeddingResult:
    if not isinstance(body, dict) or not isinstance(body.get("data"), list) or len(body["data"]) != expected_count:
        raise ProviderError("embedding response has an invalid data count")
    ordered: list[np.ndarray | None] = [None] * expected_count
    for fallback, item in enumerate(body["data"]):
        if not isinstance(item, dict) or not isinstance(item.get("index", fallback), int):
            raise ProviderError("embedding response has an invalid item")
        index = item.get("index", fallback)
        if index < 0 or index >= expected_count or ordered[index] is not None:
            raise ProviderError("embedding response indexes are invalid")
        raw = item.get("embedding")
        if isinstance(raw, list):
            vector = np.asarray(raw, dtype=np.float32)
        elif isinstance(raw, str):
            try:
                vector = np.frombuffer(base64.b64decode(raw, validate=True), dtype="<f4")
            except ValueError as error:
                raise ProviderError("embedding response has invalid base64") from error
        else:
            raise ProviderError("embedding response has an invalid vector")
        if vector.ndim != 1 or vector.size != dimensions or not np.isfinite(vector).all():
            raise ProviderError("embedding response dimensions or values are invalid")
        norm = float(np.linalg.norm(vector))
        if norm == 0:
            raise ProviderError("embedding response contains a zero vector")
        ordered[index] = vector / norm
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    tokens = usage.get("prompt_tokens", usage.get("input_tokens", usage.get("total_tokens")))
    unmetered = not isinstance(tokens, int) or tokens == 0
    if unmetered:
        if not allow_unmetered:
            raise ProviderError("provider usage is absent or zero; use --allow-unmetered only when no budget is required")
        tokens = 0
    if tokens < 0:
        raise ProviderError("provider usage is invalid")
    return EmbeddingResult(vectors=np.asarray(ordered, dtype=np.float32), prompt_tokens=tokens, unmetered=unmetered)
