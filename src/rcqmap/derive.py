"""Fields as reported in the paper, derived from the 24 annotated fields.

The guidelines (and the model) record 24 fields. After the clinician validation study the paper reports 20:
actionability and evidence dependence are not analyzed; patient and institutional context are combined into
"needs patient or local information" (ctx_local); the derived any-context field is not reported; and the 12
intents are grouped into five intent groups for comparisons. Clinician agreement for every field is in the
paper's Extended Data Table 2.
"""
from __future__ import annotations

from typing import Any, Mapping

TASK_GROUP = {
    "Documentation & workflow": "Documentation & administration",
    "Coding & administrative": "Documentation & administration",
    "Foundational knowledge": "Knowledge retrieval",
    "Drug information & pharmacotherapy": "Knowledge retrieval",
    "Treatment & management": "Clinical reasoning",
    "Diagnosis & differential": "Clinical reasoning",
    "Test & result interpretation": "Clinical reasoning",
    "Procedural guidance": "Clinical reasoning",
    "Patient education & communication": "Clinical reasoning",
    "Other": "Other",
}
KINDS_OF_WORK = ["Documentation & administration", "Knowledge retrieval", "Clinical reasoning", "Other"]

INTENT_GROUP = {
    "Clinical decision": "Decide or verify",
    "Verification": "Decide or verify",
    "Dosing/conversion": "Decide or verify",
    "Result interpretation": "Decide or verify",
    "Fact/property lookup": "Look up or understand",
    "Definition/concept": "Look up or understand",
    "Mechanism/rationale": "Look up or understand",
    "Comparison": "Look up or understand",
    "Documentation drafting": "Draft text or code",
    "Coding": "Draft text or code",
    "Procedure/how-to": "Follow a procedure",
    "Other": "Other",
}
INTENT_GROUPS = ["Decide or verify", "Look up or understand", "Draft text or code", "Follow a procedure", "Other"]

NOT_REPORTED = ("actionable", "evidence_dependent", "needs_context")


def derive(annotation: Mapping[str, Any]) -> dict[str, Any]:
    """Return the reported fields for one validated annotation."""
    a = dict(annotation)
    return {
        "kind_of_work": TASK_GROUP[a["task_category"]],
        "task_category": a["task_category"],
        "intent_group": INTENT_GROUP[a["question_intent"]],
        "question_intent": a["question_intent"],
        "clinical_domain": a["clinical_domain"],
        "medicine_division": a["medicine_division"],
        "ama_category": a["ama_category"],
        "patient_specific": int(a["patient_specific"]),
        "ctx_local": int(a["ctx_patient"] == 1 or a["ctx_institutional"] == 1),
        "ctx_evidence": int(a["ctx_evidence"]),
        "risk": a["risk"],
        "high_or_critical": int(a["risk"] in ("High", "Critical")),
        "answerability": a["answerability"],
        "answer_not_high": int(a["answerability"] != "High"),
        "route": a["route"],
        "not_direct": int(a["route"] != "Direct"),
        "no_recoverable_request": int(
            a["task_category"] == "Other" and a["question_intent"] == "Other"
            and a["answerability"] == "Low" and a["route"] == "Clarification"
        ),
        **{k: int(a[k]) for k in ("mentions_medication", "mentions_dose", "mentions_lab_or_result", "mentions_imaging",
                                  "vulnerable_population", "acute_or_urgent", "requests_text_generation",
                                  "uses_abbreviation")},
        "query_form": a["query_form"],
    }
