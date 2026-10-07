from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
from typing import Any


class OutputStore:
    def __init__(self, output_path: Path):
        self.output_path = output_path
        self.manifest_path = output_path.with_name(output_path.name + ".manifest.json")
        self.import_path = output_path.with_name(f"{output_path.stem}.import.json")
        self.lock_path = output_path.with_name(output_path.name + ".lock")
        self._lock_handle = None

    def __enter__(self) -> "OutputStore":
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_handle = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self._lock_handle.close()
            raise RuntimeError(f"Another evaluation process is using {self.output_path}.") from error
        return self

    def __exit__(self, *_: object) -> None:
        if self._lock_handle is not None:
            fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_UN)
            self._lock_handle.close()
            self._lock_handle = None

    def prepare_manifest(self, expected: dict[str, Any]) -> dict[str, Any]:
        if self.output_path.exists() and not self.manifest_path.exists():
            raise RuntimeError(
                f"Refusing to append to {self.output_path}: its run manifest is missing. "
                "Choose a new --output path."
            )
        if self.manifest_path.exists():
            current = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            if current.get("run_fingerprint") != expected["run_fingerprint"]:
                raise RuntimeError(
                    "The existing output was created with a different dataset, prompt, schema, "
                    "model, or sampling configuration. Choose a new --output path."
                )
            return current
        self.write_manifest(expected)
        return dict(expected)

    def successful_query_ids(self) -> set[str]:
        if not self.output_path.exists():
            return set()
        successful: set[str] = set()
        with self.output_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError(
                        f"Invalid JSONL at {self.output_path}:{line_number}; repair or use a new output path."
                    ) from error
                if record.get("status") == "ok" and record.get("query_id") is not None:
                    successful.add(str(record["query_id"]))
        return successful

    def successful_records(self) -> dict[str, dict[str, Any]]:
        if not self.output_path.exists():
            return {}
        successful: dict[str, dict[str, Any]] = {}
        with self.output_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError(
                        f"Invalid JSONL at {self.output_path}:{line_number}; repair or use a new output path."
                    ) from error
                if record.get("status") == "ok" and record.get("query_id") is not None:
                    query_id = str(record["query_id"])
                    successful[query_id] = {
                        key: value
                        for key, value in record.items()
                        if key not in {"question", "query", "query_text"}
                    }
        return successful

    def append(self, record: dict[str, Any]) -> None:
        with self.output_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def write_manifest(self, manifest: dict[str, Any]) -> None:
        self._write_json_atomic(self.manifest_path, manifest)

    def write_import_bundle(self, manifest: dict[str, Any]) -> Path:
        selected_ids = [str(value) for value in manifest.get("selected_query_ids", [])]
        if not selected_ids or len(selected_ids) != len(set(selected_ids)):
            raise RuntimeError("Cannot create an import bundle without unique selected query IDs.")
        successful = self.successful_records()
        missing = [query_id for query_id in selected_ids if query_id not in successful]
        if missing:
            raise RuntimeError(
                f"Cannot create an import bundle: {len(missing)} selected queries lack successful results."
            )
        bundle = {
            "bundle_format": "rcq_llm_evaluation",
            "bundle_version": 1,
            "created_at": manifest.get("updated_at") or manifest.get("created_at"),
            "manifest": manifest,
            "predictions": [successful[query_id] for query_id in selected_ids],
        }
        self._write_json_atomic(self.import_path, bundle)
        return self.import_path

    @staticmethod
    def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            if temporary.exists():
                temporary.unlink()
