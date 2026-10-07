from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .dataset import Query
from .providers import CompletionProvider
from .schema import AnnotationSchema, AnnotationValidationError, parse_json_response


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    uncached_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    def add(self, other: "TokenUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens
        self.uncached_input_tokens += other.uncached_input_tokens
        self.cache_creation_input_tokens += other.cache_creation_input_tokens
        self.cache_read_input_tokens += other.cache_read_input_tokens

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "uncached_input_tokens": self.uncached_input_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
        }


@dataclass(frozen=True)
class BatchConfig:
    provider: str
    model: str
    max_tokens: int
    temperature: float | None
    max_retries: int
    include_query_text: bool
    prompt_sha256: str


def _status_code(error: Exception) -> int | None:
    value = getattr(error, "status_code", None)
    return value if isinstance(value, int) else None


def _retryable_api_error(error: Exception) -> bool:
    status = _status_code(error)
    if status in {408, 409, 429} or (status is not None and status >= 500):
        return True
    return type(error).__name__ in {
        "APIConnectionError",
        "APITimeoutError",
        "RateLimitError",
        "InternalServerError",
    }


def _fatal_api_error(error: Exception) -> bool:
    status = _status_code(error)
    return status in {400, 401, 403, 404, 405, 422}


def _safe_error(error: Exception) -> str:
    return " ".join(str(error).split())[:600] or type(error).__name__


async def evaluate_query(
    *,
    provider: CompletionProvider,
    query: Query,
    system_prompt: str,
    schema: AnnotationSchema,
    semaphore: asyncio.Semaphore,
    abort_event: asyncio.Event,
    config: BatchConfig,
) -> dict[str, Any] | None:
    started = time.perf_counter()
    total_usage = TokenUsage()
    last_error: Exception | None = None
    error_kind = "unknown"
    last_response_id = ""
    last_response_model = ""
    last_finish_reason = ""
    max_attempts = config.max_retries + 1

    for attempt in range(1, max_attempts + 1):
        if abort_event.is_set():
            return None
        try:
            async with semaphore:
                if abort_event.is_set():
                    return None
                completion = await provider.complete(
                    model=config.model,
                    system_prompt=system_prompt,
                    query=query,
                    schema=schema,
                    max_tokens=config.max_tokens,
                    temperature=config.temperature,
                )

            last_response_id = completion.response_id
            last_response_model = completion.response_model
            last_finish_reason = completion.finish_reason
            total_usage.add(
                TokenUsage(
                    prompt_tokens=completion.prompt_tokens,
                    completion_tokens=completion.completion_tokens,
                    total_tokens=completion.total_tokens,
                    uncached_input_tokens=completion.uncached_input_tokens,
                    cache_creation_input_tokens=completion.cache_creation_input_tokens,
                    cache_read_input_tokens=completion.cache_read_input_tokens,
                )
            )
            parsed, parse_mode = parse_json_response(completion.text)
            annotation = schema.validate(parsed)

            record: dict[str, Any] = {
                "format_version": 1,
                "status": "ok",
                "query_id": query.query_id,
                "query_sha256": query.sha256,
                "annotation": annotation,
                "provider": config.provider,
                "model": config.model,
                "response_model": completion.response_model,
                "response_id": completion.response_id,
                "finish_reason": completion.finish_reason,
                "prompt_sha256": config.prompt_sha256,
                "parse_mode": parse_mode,
                "attempts": attempt,
                "usage": total_usage.as_dict(),
                "latency_seconds": round(time.perf_counter() - started, 3),
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            if config.include_query_text:
                record["question"] = query.text
            return record
        except (AnnotationValidationError, ValueError) as error:
            last_error = error
            error_kind = "invalid_model_output"
            retryable = True
        except Exception as error:  # SDK exceptions vary across compatible servers.
            last_error = error
            error_kind = "api_error"
            retryable = _retryable_api_error(error)
            if _fatal_api_error(error):
                abort_event.set()

        if not retryable or attempt >= max_attempts:
            break
        delay = min(16.0, 2 ** (attempt - 1)) + random.uniform(0.0, 0.4)
        await asyncio.sleep(delay)

    return {
        "format_version": 1,
        "status": "error",
        "query_id": query.query_id,
        "query_sha256": query.sha256,
        "provider": config.provider,
        "model": config.model,
        "response_model": last_response_model,
        "response_id": last_response_id,
        "finish_reason": last_finish_reason,
        "prompt_sha256": config.prompt_sha256,
        "error_type": error_kind,
        "error": _safe_error(last_error or RuntimeError("Unknown evaluation failure.")),
        "attempts": attempt,
        "usage": total_usage.as_dict(),
        "latency_seconds": round(time.perf_counter() - started, 3),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


async def run_batch(
    *,
    provider: CompletionProvider,
    queries: list[Query],
    system_prompt: str,
    schema: AnnotationSchema,
    concurrency: int,
    config: BatchConfig,
    on_result: Callable[[dict[str, Any], int, int], None],
) -> tuple[list[dict[str, Any]], int]:
    semaphore = asyncio.Semaphore(concurrency)
    abort_event = asyncio.Event()
    tasks = [
        asyncio.create_task(
            evaluate_query(
                provider=provider,
                query=query,
                system_prompt=system_prompt,
                schema=schema,
                semaphore=semaphore,
                abort_event=abort_event,
                config=config,
            )
        )
        for query in queries
    ]

    results: list[dict[str, Any]] = []
    try:
        for completed, task in enumerate(asyncio.as_completed(tasks), start=1):
            result = await task
            if result is not None:
                results.append(result)
                on_result(result, completed, len(tasks))
        return results, len(tasks) - len(results)
    finally:
        unfinished = [task for task in tasks if not task.done()]
        for task in unfinished:
            task.cancel()
        if unfinished:
            await asyncio.gather(*unfinished, return_exceptions=True)
