"""Minimal OpenAI-compatible embedding provider with truthful usage accounting."""

from __future__ import annotations

import base64
import json
import math
import struct
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingResult:
    vectors: list[list[float]]
    prompt_tokens: int
    requests: int


class UsageLedger:
    def __init__(self, weighted_limit: float | None, multiplier: float, initial_tokens: int = 0, initial_requests: int = 0) -> None:
        self._limit = weighted_limit
        self._multiplier = multiplier
        self._tokens = initial_tokens
        self._requests = initial_requests
        self._lock = threading.Lock()

    def record(self, tokens: int) -> None:
        if tokens < 0:
            raise ProviderError("provider usage is invalid")
        with self._lock:
            next_tokens = self._tokens + tokens
            if self._limit is not None and next_tokens * self._multiplier > self._limit:
                raise ProviderError("embedding hard budget limit would be exceeded")
            self._tokens = next_tokens
            self._requests += 1

    def snapshot(self) -> dict[str, int | float]:
        with self._lock:
            return {"promptTokens": self._tokens, "requests": self._requests, "weightedUnits": self._tokens * self._multiplier}


def embeddings_endpoint(base_url: str) -> str:
    value = base_url.rstrip("/")
    if value.endswith("/v1/embeddings") or value.endswith("/embeddings"):
        return value
    if value.endswith("/v1"):
        return value + "/embeddings"
    return value + "/v1/embeddings"


class OpenAIEmbeddingProvider:
    def __init__(self, base_url: str, api_key: str, model: str, dimensions: int, encoding_format: str = "float", extra: dict[str, Any] | None = None, timeout_seconds: float = 60.0, max_retries: int = 3, proxy: str | None = None, ledger: UsageLedger | None = None) -> None:
        if not base_url or not api_key or not model or dimensions < 1:
            raise ValueError("base URL, environment-supplied API key, model, and positive dimensions are required")
        if encoding_format not in {"float", "base64"}:
            raise ValueError("encoding format must be float or base64")
        extra = extra or {}
        reserved = {"model", "input", "encoding_format", "dimensions"}
        conflict = reserved.intersection(extra)
        if conflict:
            raise ValueError("provider extra JSON cannot override " + ", ".join(sorted(conflict)))
        self.endpoint, self.api_key, self.model, self.dimensions = embeddings_endpoint(base_url), api_key, model, dimensions
        self.encoding_format, self.extra, self.timeout_seconds, self.max_retries = encoding_format, extra, timeout_seconds, max_retries
        self.opener = build_opener(ProxyHandler({"https": proxy, "http": proxy}) if proxy else ProxyHandler())
        self.ledger = ledger

    def embed(self, texts: list[str]) -> EmbeddingResult:
        if not texts or any(not text.strip() for text in texts):
            raise ProviderError("embedding input must contain non-empty strings")
        payload: dict[str, Any] = {"model": self.model, "input": texts, "encoding_format": self.encoding_format, "dimensions": self.dimensions}
        payload.update(self.extra)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            request = Request(self.endpoint, body, {"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"}, method="POST")
            try:
                with self.opener.open(request, timeout=self.timeout_seconds) as response:
                    parsed = json.loads(response.read(4 * 1024 * 1024).decode("utf-8"))
                result = parse_embedding_response(parsed, len(texts), self.dimensions)
                if self.ledger:
                    self.ledger.record(result.prompt_tokens)
                return result
            except HTTPError as error:
                last_error = ProviderError(f"embedding provider returned HTTP {error.code}")
                if error.code != 429 and error.code < 500:
                    break
            except (URLError, TimeoutError, json.JSONDecodeError) as error:
                last_error = ProviderError("embedding provider request failed: " + str(error))
            if attempt < self.max_retries:
                time.sleep(min(2**attempt, 8))
        raise last_error or ProviderError("embedding provider request failed")


def parse_embedding_response(body: Any, expected_count: int, dimensions: int) -> EmbeddingResult:
    if not isinstance(body, dict) or not isinstance(body.get("data"), list) or len(body["data"]) != expected_count:
        raise ProviderError("embedding response has an invalid data count")
    ordered: list[list[float] | None] = [None] * expected_count
    for fallback, item in enumerate(body["data"]):
        if not isinstance(item, dict) or not isinstance(item.get("index", fallback), int):
            raise ProviderError("embedding response has an invalid item")
        index = item.get("index", fallback)
        if index < 0 or index >= expected_count or ordered[index] is not None:
            raise ProviderError("embedding response indexes are invalid")
        raw = item.get("embedding")
        if isinstance(raw, list):
            vector = [float(value) for value in raw]
        elif isinstance(raw, str):
            try:
                decoded = base64.b64decode(raw, validate=True)
                if len(decoded) != dimensions * 4:
                    raise ValueError
                vector = list(struct.unpack("<" + "f" * dimensions, decoded))
            except (ValueError, struct.error) as error:
                raise ProviderError("embedding response has invalid base64") from error
        else:
            raise ProviderError("embedding response has an invalid vector")
        if len(vector) != dimensions or not all(math.isfinite(value) for value in vector):
            raise ProviderError("embedding response dimensions or values are invalid")
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            raise ProviderError("embedding response contains a zero vector")
        ordered[index] = [value / norm for value in vector]
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    tokens = usage.get("prompt_tokens", usage.get("input_tokens", usage.get("total_tokens", 0)))
    if not isinstance(tokens, int) or tokens < 0:
        raise ProviderError("embedding response usage is invalid")
    return EmbeddingResult(vectors=[value for value in ordered if value is not None], prompt_tokens=tokens, requests=1)
