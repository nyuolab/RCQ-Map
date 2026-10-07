"""Offline tests: no network, no API keys."""
import hashlib
import json
from pathlib import Path

import pytest

from rcqmap.derive import INTENT_GROUP, TASK_GROUP, derive
from rcqmap.prompting import PAPER_PROMPT_SHA256, build_messages, default_prompt_path, default_schema_path, load_system_prompt
from rcqmap.dataset import Query
from rcqmap.schema import AnnotationSchema, AnnotationValidationError

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = AnnotationSchema.load(default_schema_path())
EXAMPLES = [json.loads(l) for l in (ROOT / "examples" / "labels.jsonl").read_text().splitlines() if l.strip()]


def test_guidelines_are_the_paper_version_and_identical_copies():
    bundled = default_prompt_path().read_bytes()
    assert hashlib.sha256(bundled).hexdigest() == PAPER_PROMPT_SHA256
    assert (ROOT / "guidelines" / "annotation_guidelines.txt").read_bytes() == bundled
    assert (ROOT / "schema" / "annotation_schema.json").read_bytes() == default_schema_path().read_bytes()


def test_schema_has_24_fields_and_prompt_covers_them():
    assert len(SCHEMA.keys) == 24
    prompt, sha = load_system_prompt(default_prompt_path())
    SCHEMA.validate_prompt_coverage(prompt)
    assert sha == PAPER_PROMPT_SHA256


def test_user_message_format_matches_paper():
    msgs = build_messages("SYSTEM", Query(query_id="1", text="apixaban dose CrCl 28, 60 kg"))
    assert msgs[1]["content"] == "Question:  apixaban dose CrCl 28, 60 kg"


@pytest.mark.parametrize("record", EXAMPLES, ids=lambda r: r["query_id"])
def test_examples_validate(record):
    SCHEMA.validate(record["annotation"])


def _example(qid):
    return dict(next(r for r in EXAMPLES if r["query_id"] == qid)["annotation"])


def test_consistency_rule_needs_context():
    a = _example("ex02")
    a["needs_context"] = 0
    with pytest.raises(AnnotationValidationError):
        SCHEMA.validate(a)


def test_consistency_rule_evidence():
    a = _example("ex04")
    a["ctx_evidence"], a["needs_context"], a["evidence_dependent"] = 1, 1, 0
    with pytest.raises(AnnotationValidationError):
        SCHEMA.validate(a)


def test_consistency_rule_medicine_division():
    a = _example("ex07")
    a["medicine_division"] = "Cardiology"
    with pytest.raises(AnnotationValidationError):
        SCHEMA.validate(a)


def test_rejects_unknown_value_and_extra_field():
    a = _example("ex01")
    a["risk"] = "Severe"
    with pytest.raises(AnnotationValidationError):
        SCHEMA.validate(a)
    b = _example("ex01")
    b["extra"] = 1
    with pytest.raises(AnnotationValidationError):
        SCHEMA.validate(b)


def test_derive_reported_fields():
    d = derive(_example("ex02"))
    assert d["kind_of_work"] == "Knowledge retrieval"
    assert d["intent_group"] == "Decide or verify"
    assert d["ctx_local"] == 1 and d["high_or_critical"] == 1 and d["answer_not_high"] == 1 and d["not_direct"] == 1
    assert "actionable" not in d and "evidence_dependent" not in d and "needs_context" not in d
    d7 = derive(_example("ex07"))
    assert d7["no_recoverable_request"] == 1 and d7["kind_of_work"] == "Other"


def test_derive_maps_cover_schema_values():
    allowed = {f.key: set(f.allowed) for f in SCHEMA.fields}
    assert set(TASK_GROUP) == allowed["task_category"]
    assert set(INTENT_GROUP) == allowed["question_intent"]
