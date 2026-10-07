from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .dataset import Query
from .prompting import build_messages
from .schema import AnnotationSchema


@dataclass(frozen=True)
class ProviderCompletion:
    text: str
    response_id: str
    response_model: str
    finish_reason: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    uncached_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0


class CompletionProvider(Protocol):
    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion: ...


def _attr(value: object, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _int_attr(value: object, name: str) -> int:
    return int(_attr(value, name, 0) or 0)


class OpenAIHTTPError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class APIConnectionError(RuntimeError):
    pass


class APITimeoutError(RuntimeError):
    pass


class OpenAIResponsesHTTPClient:
    """Small async facade over the documented Responses REST endpoint."""

    endpoint = "https://api.openai.com/v1/responses"

    def __init__(self, *, api_key: str, timeout: float):
        self.api_key = api_key
        self.timeout = timeout
        self.responses = self

    async def create(self, **payload: object) -> dict[str, object]:
        return await asyncio.to_thread(self._create_sync, payload)

    def _create_sync(self, payload: dict[str, object]) -> dict[str, object]:
        request = Request(
            self.endpoint,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "rcqmap/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            message = f"OpenAI API request failed with HTTP {error.code}."
            try:
                body = json.loads(error.read().decode("utf-8"))
                detail = body.get("error", {}).get("message")
                if isinstance(detail, str) and detail:
                    message = detail
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            raise OpenAIHTTPError(error.code, message[:600]) from error
        except TimeoutError as error:
            raise APITimeoutError("OpenAI API request timed out.") from error
        except URLError as error:
            raise APIConnectionError(f"OpenAI API connection failed: {error.reason}") from error

        if not isinstance(decoded, dict):
            raise APIConnectionError("OpenAI API returned a non-object response.")
        return decoded


class OpenAICompatibleProvider:
    """Adapter for any OpenAI-compatible chat-completions endpoint (for example a self-hosted model server).

    Uses the guidelines as the system message and validates the JSON locally; JSON mode is optional."""

    def __init__(self, client: Any, *, json_mode: bool = False):
        self.client = client
        self.json_mode = json_mode

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion:
        del schema  # compatibility mode relies on the guidelines plus local validation
        request: dict[str, Any] = {
            "model": model,
            "messages": build_messages(system_prompt, query),
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            request["temperature"] = temperature
        if self.json_mode:
            request["response_format"] = {"type": "json_object"}

        response = await self.client.chat.completions.create(**request)
        if not getattr(response, "choices", None):
            raise ValueError("The model response did not contain a completion choice.")
        choice = response.choices[0]
        content = getattr(getattr(choice, "message", None), "content", None)
        if not isinstance(content, str):
            raise ValueError("The model response did not contain text content.")
        usage = getattr(response, "usage", None)
        prompt_tokens = _int_attr(usage, "prompt_tokens")
        completion_tokens = _int_attr(usage, "completion_tokens")
        total_tokens = _int_attr(usage, "total_tokens") or prompt_tokens + completion_tokens
        return ProviderCompletion(
            text=content,
            response_id=str(getattr(response, "id", "") or ""),
            response_model=str(getattr(response, "model", "") or ""),
            finish_reason=str(getattr(choice, "finish_reason", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            uncached_input_tokens=prompt_tokens,
        )


class OpenAIResponsesProvider:
    """Adapter for OpenAI's Responses API with strict JSON Schema output."""

    def __init__(self, client: Any, *, reasoning_effort: str = "none"):
        self.client = client
        self.reasoning_effort = reasoning_effort

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion:
        request: dict[str, Any] = {
            "model": model,
            "instructions": system_prompt,
            "input": [{"role": "user", "content": f"Question:  {query.text}"}],
            "max_output_tokens": max_tokens,
            "reasoning": {"effort": self.reasoning_effort},
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "rcq_annotation",
                    "strict": True,
                    "schema": schema.to_json_schema(),
                },
                "verbosity": "low",
            },
            "prompt_cache_key": "rcq-map-v2-1",
            "store": False,
        }
        if temperature is not None:
            request["temperature"] = temperature

        response = await self.client.responses.create(**request)
        content = _attr(response, "output_text")
        if not isinstance(content, str) or not content:
            text_parts: list[str] = []
            for item in _attr(response, "output", []) or []:
                if _attr(item, "type") != "message":
                    continue
                for block in _attr(item, "content", []) or []:
                    if _attr(block, "type") == "output_text":
                        text = _attr(block, "text")
                        if isinstance(text, str):
                            text_parts.append(text)
            content = "".join(text_parts)
        if not isinstance(content, str) or not content:
            raise ValueError("The OpenAI response did not contain output text.")

        usage = _attr(response, "usage")
        prompt_tokens = _int_attr(usage, "input_tokens")
        completion_tokens = _int_attr(usage, "output_tokens")
        total_tokens = _int_attr(usage, "total_tokens") or prompt_tokens + completion_tokens
        input_details = _attr(usage, "input_tokens_details")
        cache_read_input_tokens = _int_attr(input_details, "cached_tokens")
        cache_creation_input_tokens = _int_attr(input_details, "cache_write_tokens")
        uncached_input_tokens = max(
            0,
            prompt_tokens - cache_read_input_tokens - cache_creation_input_tokens,
        )

        return ProviderCompletion(
            text=content,
            response_id=str(_attr(response, "id", "") or ""),
            response_model=str(_attr(response, "model", "") or ""),
            finish_reason=str(_attr(response, "status", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            uncached_input_tokens=uncached_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
        )


class AnthropicProvider:
    """Adapter for Claude's Messages API with native JSON Schema output."""

    def __init__(self, client: Any):
        self.client = client

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion:
        request: dict[str, Any] = {
            "model": model,
            "system": [
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": [{"role": "user", "content": f"Question:  {query.text}"}],
            "max_tokens": max_tokens,
            # Bounded classification: disable extended thinking so the output cap is spent on the JSON.
            "thinking": {"type": "disabled"},
            "output_config": {
                "format": {
                    "type": "json_schema",
                    "schema": schema.to_json_schema(),
                }
            },
        }
        if temperature is not None:
            request["temperature"] = temperature

        response = await self.client.messages.create(**request)
        text_blocks = [
            block.text
            for block in getattr(response, "content", [])
            if getattr(block, "type", None) == "text" and isinstance(getattr(block, "text", None), str)
        ]

        usage = getattr(response, "usage", None)
        uncached_input_tokens = _int_attr(usage, "input_tokens")
        cache_creation_input_tokens = _int_attr(usage, "cache_creation_input_tokens")
        cache_read_input_tokens = _int_attr(usage, "cache_read_input_tokens")
        prompt_tokens = (
            uncached_input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        )
        completion_tokens = _int_attr(usage, "output_tokens")
        return ProviderCompletion(
            # Return an empty string rather than raising here so the batch layer
            # can retain usage and stop metadata before classifying the failure.
            text="".join(text_blocks),
            response_id=str(getattr(response, "id", "") or ""),
            response_model=str(getattr(response, "model", "") or ""),
            finish_reason=str(getattr(response, "stop_reason", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            uncached_input_tokens=uncached_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
        )
