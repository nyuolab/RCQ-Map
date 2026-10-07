"""Load the canonical annotation guidelines and build the request exactly as used in the paper."""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from importlib import resources
from pathlib import Path

from .dataset import Query

# sha256 of the guidelines used for every run reported in the paper (corpus, validation set and CABA)
PAPER_PROMPT_SHA256 = "f8f0fc98778ed0398e76b83c6c843d0088391154045d80602500f9619fcb5394"


@dataclass(frozen=True)
class ConcurrencyPlan:
    estimated_input_tokens: int
    max_output_tokens: int
    estimated_tokens_per_request: int
    token_budget: int
    max_concurrency: int
    concurrency: int
    estimated_tokens_in_flight: int


def default_prompt_path() -> Path:
    return Path(str(resources.files("rcqmap") / "data" / "annotation_guidelines.txt"))


def default_schema_path() -> Path:
    return Path(str(resources.files("rcqmap") / "data" / "annotation_schema.json"))


def load_system_prompt(path: Path) -> tuple[str, str]:
    """Read the guidelines and return (text, sha256). The 24-field JSON contract must be present."""
    prompt_bytes = path.read_bytes()
    prompt = prompt_bytes.decode("utf-8-sig")
    if "exactly the 24 fields" not in prompt or "Return a single JSON object" not in prompt:
        raise ValueError("Guidelines are missing the required 24-field JSON output contract.")
    return prompt, hashlib.sha256(prompt_bytes).hexdigest()


def build_messages(system_prompt: str, query: Query) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        # Two spaces after the colon, exactly as in the paper's runs.
        {"role": "user", "content": f"Question:  {query.text}"},
    ]


def plan_concurrency(
    system_prompt: str,
    queries: list[Query],
    *,
    max_output_tokens: int,
    token_budget: int,
    max_concurrency: int,
    supplemental_input_chars: int = 0,
    characters_per_token: float = 4.0,
) -> ConcurrencyPlan:
    if max_output_tokens < 1:
        raise ValueError("max_output_tokens must be positive.")
    if token_budget < 1:
        raise ValueError("token_budget must be positive.")
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be positive.")
    if supplemental_input_chars < 0:
        raise ValueError("supplemental_input_chars cannot be negative.")
    if characters_per_token <= 0:
        raise ValueError("characters_per_token must be positive.")

    largest_query = max((len(query.text) for query in queries), default=0)
    # Include provider-specific request material (such as a JSON Schema), add a
    # small chat-envelope allowance, and use the largest pending query.
    estimated_input_tokens = (
        math.ceil(
            (len(system_prompt) + largest_query + supplemental_input_chars)
            / characters_per_token
        )
        + 32
    )
    per_request = estimated_input_tokens + max_output_tokens
    budget_concurrency = max(1, (token_budget - 1) // per_request)
    concurrency = max(
        1,
        min(max_concurrency, budget_concurrency, max(1, len(queries))),
    )
    return ConcurrencyPlan(
        estimated_input_tokens=estimated_input_tokens,
        max_output_tokens=max_output_tokens,
        estimated_tokens_per_request=per_request,
        token_budget=token_budget,
        max_concurrency=max_concurrency,
        concurrency=concurrency,
        estimated_tokens_in_flight=concurrency * per_request,
    )
