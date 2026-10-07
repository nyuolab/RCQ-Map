from __future__ import annotations

import csv
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path


TEXT_REPLACEMENTS = (
    ("‚Äö√Ñ√¨", "-"),
    ("-¬≠", "-"),
    ("&amp;", "&"),
    ("&nbsp;", " "),
    ("‚Äô", "'"),
    ("‚Äò", "'"),
    ("‚Äã", ""),
    ("‚Ä¶", "…"),
    ("‚Ä¢", "-"),
    ("‚Äê", "-"),
    ("‚Äú", "'"),
    ("‚Äù", "'"),
    ("¬†", " "),
    ("‚Äì", "–"),
    ("¬Æ", "®"),
    ("\u00a0", " "),
)

ID_COLUMNS = ("id", "index", "row_index", "query_id", "question_id", "chat_id")
QUESTION_COLUMNS = (
    "question",
    "query",
    "prompt",
    "query_text",
    "chat",
    "message",
    "user_message",
    "text",
)


@dataclass(frozen=True)
class Query:
    query_id: str
    text: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


def normalize_text(value: object) -> str:
    text = str(value or "")
    for source, replacement in TEXT_REPLACEMENTS:
        text = text.replace(source, replacement)
    return text


def normalize_header(value: object) -> str:
    return re.sub(r"[\s-]+", "_", str(value or "").lstrip("\ufeff").strip().lower())


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_column(headers: list[str], candidates: tuple[str, ...]) -> int | None:
    return next((headers.index(candidate) for candidate in candidates if candidate in headers), None)


def load_queries(path: Path) -> list[Query]:
    if not path.is_file():
        raise FileNotFoundError(f"Input CSV not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    if len(rows) < 2:
        raise ValueError("The annotation dataset has no query rows.")

    headers = [normalize_header(value) for value in rows[0]]
    id_column = _find_column(headers, ID_COLUMNS)
    question_column = _find_column(headers, QUESTION_COLUMNS)
    if question_column is None:
        raise ValueError(
            "Could not find a query-text column; expected one of: "
            + ", ".join(QUESTION_COLUMNS)
        )

    queries: list[Query] = []
    seen_ids: set[str] = set()
    for source_row, row in enumerate(rows[1:], start=2):
        text = normalize_text(row[question_column] if question_column < len(row) else "").strip()
        if not text:
            continue
        fallback_id = f"Q{len(queries) + 1:04d}"
        query_id = (
            str(row[id_column]).strip()
            if id_column is not None and id_column < len(row) and str(row[id_column]).strip()
            else fallback_id
        )
        if query_id in seen_ids:
            raise ValueError(f"Duplicate query ID {query_id!r} at input row {source_row}.")
        seen_ids.add(query_id)
        queries.append(Query(query_id=query_id, text=text))

    if not queries:
        raise ValueError("The annotation dataset contains no usable queries.")
    return queries
