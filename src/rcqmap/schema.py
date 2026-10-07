from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class AnnotationValidationError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


@dataclass(frozen=True)
class FieldSpec:
    key: str
    value_type: str
    allowed: tuple[Any, ...]


@dataclass(frozen=True)
class AnnotationSchema:
    version: str
    fields: tuple[FieldSpec, ...]

    @classmethod
    def load(cls, path: Path) -> "AnnotationSchema":
        raw = json.loads(path.read_text(encoding="utf-8"))
        fields = tuple(
            FieldSpec(
                key=str(field["key"]),
                value_type=str(field["type"]),
                allowed=tuple(field["allowed"]),
            )
            for field in raw["fields"]
        )
        keys = [field.key for field in fields]
        if len(fields) != 24 or len(set(keys)) != len(keys):
            raise ValueError("Annotation schema must define exactly 24 unique fields.")
        if any(field.value_type not in {"integer", "string"} for field in fields):
            raise ValueError("Annotation schema contains an unsupported field type.")
        return cls(version=str(raw["schema_version"]), fields=fields)

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(field.key for field in self.fields)

    def to_json_schema(self) -> dict[str, Any]:
        """Return the strict JSON Schema shared with providers that support it."""
        properties = {
            field.key: {
                "type": field.value_type,
                "enum": list(field.allowed),
            }
            for field in self.fields
        }
        return {
            "type": "object",
            "properties": properties,
            "required": list(self.keys),
            "additionalProperties": False,
        }

    def validate_prompt_coverage(self, prompt: str) -> None:
        """Fail when a model prompt omits a field or exact categorical value."""
        missing_fields = [key for key in self.keys if key not in prompt]
        allowed_strings = {
            value
            for field in self.fields
            for value in field.allowed
            if isinstance(value, str)
        }
        missing_values = sorted(value for value in allowed_strings if value not in prompt)
        errors: list[str] = []
        if missing_fields:
            errors.append(f"missing fields: {', '.join(missing_fields)}")
        if missing_values:
            errors.append(f"missing allowed values: {', '.join(missing_values)}")
        if errors:
            raise ValueError("Model prompt taxonomy coverage failed: " + "; ".join(errors))

    def validate(self, value: object) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise AnnotationValidationError(["Annotation must be a JSON object."])

        received = set(value)
        expected = set(self.keys)
        errors: list[str] = []
        missing = sorted(expected - received)
        extra = sorted(received - expected)
        if missing:
            errors.append(f"Missing fields: {', '.join(missing)}")
        if extra:
            errors.append(f"Unexpected fields: {', '.join(extra)}")

        for field in self.fields:
            if field.key not in value:
                continue
            field_value = value[field.key]
            if field.value_type == "integer" and type(field_value) is not int:
                errors.append(f"{field.key} must be an integer, not {type(field_value).__name__}")
            elif field.value_type == "string" and type(field_value) is not str:
                errors.append(f"{field.key} must be a string, not {type(field_value).__name__}")
            elif field_value not in field.allowed:
                errors.append(f"{field.key} has an invalid value: {field_value!r}")

        if not missing:
            context_value = int(
                any(value[key] == 1 for key in ("ctx_patient", "ctx_institutional", "ctx_evidence"))
            )
            if value["needs_context"] != context_value:
                errors.append("needs_context must equal OR(ctx_patient, ctx_institutional, ctx_evidence)")
            if value["ctx_evidence"] == 1 and value["evidence_dependent"] != 1:
                errors.append("ctx_evidence = 1 requires evidence_dependent = 1")
            if value["clinical_domain"] == "Medicine":
                if value["medicine_division"] == "Not applicable":
                    errors.append("Medicine requires a named medicine_division")
            elif value["medicine_division"] != "Not applicable":
                errors.append("Non-Medicine domains require medicine_division = 'Not applicable'")

        if errors:
            raise AnnotationValidationError(errors)
        return {field.key: value[field.key] for field in self.fields}


def parse_json_response(content: str) -> tuple[object, str]:
    raw = str(content or "").strip()
    if not raw:
        raise ValueError("The model returned an empty response.")

    try:
        return json.loads(raw), "strict"
    except json.JSONDecodeError as strict_error:
        if raw.startswith("```") and raw.endswith("```"):
            lines = raw.splitlines()
            if len(lines) >= 3:
                fenced = "\n".join(lines[1:-1]).strip()
                try:
                    return json.loads(fenced), "fenced"
                except json.JSONDecodeError:
                    pass

        start = raw.find("{")
        if start >= 0:
            try:
                value, _ = json.JSONDecoder().raw_decode(raw[start:])
                return value, "extracted"
            except json.JSONDecodeError:
                pass
        raise ValueError(f"The model response was not valid JSON: {strict_error.msg}") from strict_error
