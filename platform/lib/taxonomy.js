import { OPTION_DEFINITIONS } from "./option-definitions.js";

export const BINARY_OPTIONS = [
  { value: 0, label: "No" },
  { value: 1, label: "Yes" },
];

const options = (fieldKey, values) => values.map((value) => ({
  value,
  label: value,
  description: OPTION_DEFINITIONS[fieldKey]?.[value] || "",
}));

export const TAXONOMY_GROUPS = [
  {
    id: "classification",
    label: "Classification",
    shortLabel: "Classify",
    description: "Identify the requested task, its clinical owner, and the answer the clinician wants.",
  },
  {
    id: "judgement",
    label: "Clinical judgement",
    shortLabel: "Judge",
    description: "Judge the query independently on specificity, actionability, and dependence on evidence.",
  },
  {
    id: "routing",
    label: "Context & routing",
    shortLabel: "Route",
    description: "Identify missing context, stakes, answerability, and the safest deployment route.",
  },
  {
    id: "surface",
    label: "Surface flags",
    shortLabel: "Flags",
    description: "Mark only cues that literally appear in the query. Do not infer them.",
  },
  {
    id: "form",
    label: "Scope & form",
    shortLabel: "Finish",
    description: "Finish with query form and abbreviation use.",
  },
];

export const TAXONOMY_FIELDS = [
  {
    key: "task_category",
    number: "1",
    group: "classification",
    label: "Primary task",
    prompt: "What single task would satisfy the request?",
    help: "Classify by the deliverable, not merely the subject mentioned. Drafting a true artifact beats its topic; drug regimen questions are drug information, while broader care strategy is treatment and management.",
    type: "choice",
    options: options("task_category", [
      "Drug information & pharmacotherapy",
      "Treatment & management",
      "Foundational knowledge",
      "Patient education & communication",
      "Test & result interpretation",
      "Documentation & workflow",
      "Diagnosis & differential",
      "Coding & administrative",
      "Procedural guidance",
      "Other",
    ]),
  },
  {
    key: "clinical_domain",
    number: "2",
    group: "classification",
    label: "Owning clinical department",
    prompt: "Which clinical department ordinarily owns this problem?",
    help: "Judge only the query's clinical content. Apply the precedence ladder: psychiatry; organic neurologic disease; pregnancy/gynecology; other pediatric care; operative departments; perioperative/pain; ED processes; diagnostic services; radiation oncology; organ-defined territory; Medicine; population health; basic science; forensic; Other. For a clinical medication with multiple common indications across services and no stated indication, do not guess: use Medicine, not Biochemistry and Molecular Pharmacology.",
    type: "choice",
    control: "select",
    options: options("clinical_domain", [
      "Anesthesiology, Perioperative Care, and Pain Medicine",
      "Biochemistry and Molecular Pharmacology",
      "Cardiothoracic Surgery",
      "Child and Adolescent Psychiatry",
      "Dermatology",
      "Emergency Medicine",
      "Forensic Medicine",
      "Medicine",
      "Neurology",
      "Neurosurgery",
      "Obstetrics and Gynecology",
      "Ophthalmology",
      "Orthopedic Surgery",
      "Otolaryngology-Head and Neck Surgery",
      "Pathology",
      "Pediatrics",
      "Plastic Surgery",
      "Population Health",
      "Psychiatry",
      "Radiation Oncology",
      "Radiology",
      "Rehabilitation Medicine",
      "Surgery",
      "Urology",
      "Other",
    ]),
  },
  {
    key: "medicine_division",
    number: "2b",
    group: "classification",
    label: "Department of Medicine division",
    prompt: "Which Medicine division owns the problem?",
    help: "Complete this only when the clinical department is Medicine. Otherwise select Not applicable. For a medication with multiple common indications across divisions and no stated indication, use General Internal Medicine and Clinical Innovation.",
    type: "choice",
    control: "select",
    options: options("medicine_division", [
      "Cardiology",
      "Endocrinology, Diabetes, and Metabolism",
      "Environmental Medicine",
      "Gastroenterology and Hepatology",
      "General Internal Medicine and Clinical Innovation",
      "Geriatric Medicine and Palliative Care",
      "Hematology and Medical Oncology",
      "Hospital Medicine",
      "Infectious Diseases and Immunology",
      "Medical Humanities",
      "Nephrology",
      "Precision Medicine",
      "Pulmonary, Critical Care, and Sleep Medicine",
      "Rheumatology",
      "Not applicable",
    ]),
  },
  {
    key: "question_intent",
    number: "3",
    group: "classification",
    label: "Question intent",
    prompt: "What does the asker want from the answer?",
    help: "Intent is the motive, distinct from task. Explicit confirmation cues make Verification outrank other intents; dose answers are always Dosing/conversion; a patient-anchored choice is Clinical decision, while a general contrast is Comparison.",
    type: "choice",
    options: options("question_intent", [
      "Verification",
      "Fact/property lookup",
      "Clinical decision",
      "Documentation drafting",
      "Definition/concept",
      "Dosing/conversion",
      "Procedure/how-to",
      "Comparison",
      "Mechanism/rationale",
      "Coding",
      "Result interpretation",
      "Other",
    ]),
  },
  {
    key: "ama_category",
    number: "4",
    group: "classification",
    label: "AMA physician AI use case",
    prompt: "Which AMA use-case best matches the primary deliverable?",
    help: "Drafting wins when it embeds another function. General clinical knowledge and patient-specific management default to summaries of research and standards of care; Assistive diagnosis is reserved for case-anchored diagnostic support.",
    type: "choice",
    options: options("ama_category", [
      "Summaries of medical research and standards of care",
      "Creation of discharge instructions, care plans or progress notes",
      "Documentation of billing codes, medical charts or visit notes",
      "Generation of chart summaries",
      "Generation of draft responses to patient portal messages",
      "Translation services",
      "Assistive diagnosis",
      "None of the above",
    ]),
  },
  {
    key: "patient_specific",
    number: "5",
    group: "judgement",
    label: "Patient-specific",
    prompt: "Does the query concern one real individual patient?",
    help: "Yes for a real case with individual details, “my patient,” or pasted chart material. No for population classes, general questions, or explicitly hypothetical vignettes.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "actionable",
    number: "6",
    group: "judgement",
    label: "Actionable",
    prompt: "Could the answer directly change near-term clinical action or documentation?",
    help: "Orders, prescriptions, plans, communication, notes, codes, and verification of a planned action count. Purely educational background does not.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "evidence_dependent",
    number: "7",
    group: "judgement",
    label: "Evidence-dependent",
    prompt: "Does a safe answer materially rest on published evidence or standards?",
    help: "Yes when misremembering studies, guidelines, drug references, or standards could make the answer materially wrong. No for pure logic, arithmetic, drafting mechanics, stable definitions, or institutional rules alone.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "ctx_patient",
    number: "8",
    group: "routing",
    label: "Missing patient context",
    prompt: "Is patient-level information absent but required for a safe answer?",
    help: "Consider history, medication list, allergies, labs, weight, and renal function. A patient-specific case can still be complete enough to mark No.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "ctx_institutional",
    number: "9",
    group: "routing",
    label: "Needs institutional context",
    prompt: "Does a safe answer require local institutional knowledge?",
    help: "Examples include local protocols, order sets, formulary restrictions, antibiograms, payer rules, or EHR configuration.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "ctx_evidence",
    number: "10",
    group: "routing",
    label: "Needs current evidence retrieval",
    prompt: "Must current published sources be consulted rather than relying on memory?",
    help: "Yes for guideline-sensitive or fast-moving topics, safety-critical dosing precision, recently changed recommendations, and new agents. Yes automatically implies evidence-dependent.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "needs_context",
    number: "11",
    group: "routing",
    label: "Needs context",
    prompt: "Does any patient, institutional, or evidence context flag apply?",
    help: "This field is derived automatically: Yes if and only if at least one of fields 8–10 is Yes.",
    type: "derived",
    options: BINARY_OPTIONS,
  },
  {
    key: "risk",
    number: "12",
    group: "routing",
    label: "Risk if answered incorrectly",
    prompt: "What is the potential clinical harm if the answer is wrong and acted upon?",
    help: "Rate potential harm, not error likelihood. Minimal: no plausible welfare impact. Low: minor/easily caught. Moderate: temporary or reversible harm. High: serious or lasting harm. Critical: death or catastrophic harm, including high-alert medications, pediatric weight-based dosing, time-critical emergencies, or teratogenic exposure.",
    type: "choice",
    options: options("risk", ["Minimal", "Low", "Moderate", "High", "Critical"]),
  },
  {
    key: "answerability",
    number: "13",
    group: "routing",
    label: "Answerability as asked",
    prompt: "How fully can the query be answered using only its text and general knowledge?",
    help: "High: complete answer possible. Partial: useful answer needs material conditions or assumptions. Low: too vague, dependent on unavailable information, or unsafe to attempt.",
    type: "choice",
    options: options("answerability", ["High", "Partial", "Low"]),
  },
  {
    key: "route",
    number: "14",
    group: "routing",
    label: "Safest deployment route",
    prompt: "What is the least restrictive route that is still safe?",
    help: "Test in order: Direct, Retrieval, Clarification, Escalation, Abstention. Retrieval addresses source needs; Clarification addresses missing details the asker can supply; Escalation is for individualized human judgement beyond an assistant pathway.",
    type: "choice",
    options: options("route", ["Direct", "Retrieval", "Clarification", "Escalation", "Abstention"]),
  },
  {
    key: "mentions_medication",
    number: "15",
    group: "surface",
    label: "Names a medication",
    prompt: "Does the text name a specific drug, biologic, vaccine, or administered blood product?",
    help: "Generic and brand names count. A class alone, such as “antibiotics” or “beta-blocker,” does not.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "mentions_dose",
    number: "16",
    group: "surface",
    label: "States a dose",
    prompt: "Does a numeric dose, strength, concentration, or rate appear?",
    help: "Examples: 5 mg, 1 g q8h, 0.9%, 10 mL/h. A frequency or route alone does not count.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "mentions_lab_or_result",
    number: "17",
    group: "surface",
    label: "States a lab or test result",
    prompt: "Does the text reference a numeric or qualitative laboratory/test result?",
    help: "Positive cultures and elevated troponin count. Merely naming a test to ask whether or how to order it does not; bedside vital signs alone do not.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "mentions_imaging",
    number: "18",
    group: "surface",
    label: "Mentions imaging",
    prompt: "Does the text reference an imaging study or report?",
    help: "X-ray, CT, MRI, ultrasound, echo, and nuclear studies count, including asking whether to order one.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "vulnerable_population",
    number: "19",
    group: "surface",
    label: "Names a vulnerable population",
    prompt: "Does the text explicitly identify a vulnerable population?",
    help: "Includes patients under 18, pregnancy/lactation, age 65+, elderly/geriatric/frail people, or a comparably vulnerable group such as severe cognitive impairment.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "acute_or_urgent",
    number: "20",
    group: "surface",
    label: "Current acute or urgent situation",
    prompt: "Does the text describe a current or imminent time-critical situation?",
    help: "Use only literal current cues such as “actively seizing,” “in the ED now,” or “BP 70/40.” General knowledge about acute conditions is No.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "requests_text_generation",
    number: "21",
    group: "surface",
    label: "Requests text generation",
    prompt: "Does the query ask for a written artifact to be used?",
    help: "Notes, letters, instructions, portal replies, summaries of supplied text, and translations count. An answer or explanation does not, however long or formatted.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
  {
    key: "query_form",
    number: "22",
    group: "form",
    label: "Query form",
    prompt: "What is the functional form of the main request?",
    help: "Question: interrogative in function, including permissibility. Command: an imperative addressed to the assistant, even if politely phrased as “Can you write…”. Fragment: neither. A central imperative wins in a mixed query.",
    type: "choice",
    options: options("query_form", ["Question", "Command", "Fragment"]),
  },
  {
    key: "uses_abbreviation",
    number: "23",
    group: "form",
    label: "Uses clinical abbreviation",
    prompt: "Does the query contain clinical abbreviations, acronyms, or shorthand?",
    help: "CrCl, PO, IV, STEMI, s/p, BID, CBC, CT, HIV, and “g tube” count. Units alone, brand names, and non-clinical shorthand such as ASAP do not.",
    type: "binary",
    options: BINARY_OPTIONS,
  },
];

export const TAXONOMY_KEYS = TAXONOMY_FIELDS.map((field) => field.key);
export const TAXONOMY_BY_KEY = Object.fromEntries(TAXONOMY_FIELDS.map((field) => [field.key, field]));

export function emptyAnnotation() {
  return Object.fromEntries(TAXONOMY_KEYS.map((key) => [key, null]));
}

export function normalizeAnnotation(input = {}) {
  return applyDerivedRules(
    Object.fromEntries(TAXONOMY_KEYS.map((key) => [key, input?.[key] ?? null])),
  );
}

export function applyDerivedRules(input) {
  const annotation = { ...input };
  const anyContext = ["ctx_patient", "ctx_institutional", "ctx_evidence"].some(
    (key) => annotation[key] === 1,
  );
  const allContextAnswered = ["ctx_patient", "ctx_institutional", "ctx_evidence"].every(
    (key) => annotation[key] === 0 || annotation[key] === 1,
  );
  annotation.needs_context = allContextAnswered ? (anyContext ? 1 : 0) : null;

  if (annotation.ctx_evidence === 1) annotation.evidence_dependent = 1;
  if (annotation.clinical_domain && annotation.clinical_domain !== "Medicine") {
    annotation.medicine_division = "Not applicable";
  }
  if (annotation.clinical_domain === "Medicine" && annotation.medicine_division === "Not applicable") {
    annotation.medicine_division = null;
  }
  return annotation;
}

export function annotationProgress(annotation) {
  const normalized = applyDerivedRules(annotation || {});
  const completed = TAXONOMY_KEYS.filter((key) => normalized[key] !== null && normalized[key] !== undefined).length;
  return { completed, total: TAXONOMY_KEYS.length, isComplete: completed === TAXONOMY_KEYS.length };
}

export function validateAnnotation(value, { partial = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["Annotation must be an object."], annotation: emptyAnnotation() };
  }

  const extraKeys = Object.keys(value).filter((key) => !TAXONOMY_KEYS.includes(key));
  const normalized = normalizeAnnotation(value);
  const errors = extraKeys.length ? [`Unexpected fields: ${extraKeys.join(", ")}.`] : [];

  for (const field of TAXONOMY_FIELDS) {
    const fieldValue = normalized[field.key];
    if (fieldValue == null) {
      if (!partial) errors.push(`${field.key} is required.`);
      continue;
    }
    if (!field.options.some((option) => Object.is(option.value, fieldValue))) {
      errors.push(`Invalid value for ${field.key}.`);
    }
  }

  if (normalized.ctx_evidence === 1 && normalized.evidence_dependent !== 1) {
    errors.push("ctx_evidence = 1 requires evidence_dependent = 1.");
  }
  const expectedNeedsContext = ["ctx_patient", "ctx_institutional", "ctx_evidence"].some(
    (key) => normalized[key] === 1,
  )
    ? 1
    : 0;
  const contextComplete = ["ctx_patient", "ctx_institutional", "ctx_evidence"].every(
    (key) => normalized[key] === 0 || normalized[key] === 1,
  );
  if (contextComplete && normalized.needs_context !== expectedNeedsContext) {
    errors.push("needs_context must equal the OR of the three context fields.");
  }
  if (
    normalized.clinical_domain &&
    normalized.medicine_division &&
    (normalized.clinical_domain === "Medicine") !== (normalized.medicine_division !== "Not applicable")
  ) {
    errors.push("medicine_division must be Not applicable if and only if clinical_domain is not Medicine.");
  }

  return { ok: errors.length === 0, errors, annotation: normalized };
}

export const CODEBOOK_VERSION = "1.0";
