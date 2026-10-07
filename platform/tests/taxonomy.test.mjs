import test from "node:test";
import assert from "node:assert/strict";
import {
  annotationProgress,
  applyDerivedRules,
  CODEBOOK_VERSION,
  emptyAnnotation,
  normalizeAnnotation,
  TAXONOMY_FIELDS,
  TAXONOMY_KEYS,
  validateAnnotation,
} from "../lib/taxonomy.js";
import { OPTION_DEFINITIONS } from "../lib/option-definitions.js";
import { parseCsv } from "../lib/csv.js";
import { normalizeDatasetText, parseAnnotationCsv } from "../lib/dataset-parser.js";
import { toRaterDataset } from "../lib/rater-dataset.js";

test("CSV parser preserves commas, quotes, and embedded newlines", () => {
  const rows = parseCsv('id,text\r\n1,"Dose, route, and \"\"timing\"\"?"\r\n2,"line one\nline two"\r\n');
  assert.deepEqual(rows, [
    ["id", "text"],
    ["1", 'Dose, route, and "timing"?'],
    ["2", "line one\nline two"],
  ]);
});

test("dataset ingestion treats source metadata as metadata and skips only empty queries", () => {
  const parsed = parseAnnotationCsv(
    "row_index,phipii,text,specialty\n1,PHINO,First query,Medicine\n2,PHIYES,Second query,\n3,,,\n",
  );
  assert.equal(parsed.skippedEmptyRows, 1);
  assert.deepEqual(parsed.questions, [
    { id: "1", question: "First query", specialty: "Medicine" },
    { id: "2", question: "Second query", specialty: "" },
  ]);
});

test("dataset ingestion rejects duplicate stable IDs", () => {
  assert.throws(
    () => parseAnnotationCsv("row_index,text\n7,First\n7,Second\n"),
    /Duplicate query ID/,
  );
});

test("dataset ingestion repairs known mojibake and HTML entities", () => {
  const replacements = [
    ["‚Äô", "'"],
    ["‚Äò", "'"],
    ["‚Äã", ""],
    ["‚Ä¶", "…"],
    ["‚Ä¢", "-"],
    ["‚Äê", "-"],
    ["-¬≠", "-"],
    ["‚Äú", "'"],
    ["‚Äù", "'"],
    ["&nbsp;", " "],
    ["¬†", " "],
    ["‚Äì", "–"],
    ["¬Æ", "®"],
    ["&amp;", "&"],
    ["‚Äö√Ñ√¨", "-"],
    ["\u00a0", " "],
  ];

  for (const [source, expected] of replacements) {
    assert.equal(normalizeDatasetText(source), expected, `Failed to normalize ${source}`);
  }
});

test("rater dataset excludes submitter metadata", () => {
  const dataset = toRaterDataset({
    datasetId: "test-dataset",
    questions: [
      {
        id: "1",
        question: "What is the treatment?",
        specialty: "Cardiology",
        internalSource: "hidden",
      },
    ],
  });

  assert.deepEqual(dataset, {
    datasetId: "test-dataset",
    questions: [{ id: "1", question: "What is the treatment?" }],
  });
});

test("codebook exposes exactly 24 unique fields", () => {
  assert.equal(TAXONOMY_FIELDS.length, 24);
  assert.equal(new Set(TAXONOMY_KEYS).size, 24);
  assert.equal(TAXONOMY_KEYS.includes("in_specialty"), false);
});

test("normalization drops retired annotation fields", () => {
  const normalized = normalizeAnnotation({ ...emptyAnnotation(), in_specialty: 1 });
  assert.equal(Object.hasOwn(normalized, "in_specialty"), false);
});

test("only long taxonomies use dropdown controls", () => {
  const dropdownFields = TAXONOMY_FIELDS.filter((field) => field.control === "select");

  assert.deepEqual(
    dropdownFields.map((field) => field.key),
    ["clinical_domain", "medicine_division"],
  );
  assert.ok(dropdownFields.every((field) => field.options.length > 12));
  assert.ok(
    TAXONOMY_FIELDS.filter((field) => field.type !== "derived" && field.control !== "select").every(
      (field) => field.options.length <= 12,
    ),
  );
});

test("every multi-value choice includes inline option definitions", () => {
  const choiceFields = TAXONOMY_FIELDS.filter((field) => field.type === "choice");
  for (const field of choiceFields) {
    assert.ok(
      field.options.every((option) => typeof option.description === "string" && option.description.length > 0),
      `${field.key} is missing an option definition`,
    );
  }
});

test("codebook gives ambiguous multi-indication medications a deterministic owner", () => {
  const domain = TAXONOMY_FIELDS.find((field) => field.key === "clinical_domain");
  const division = TAXONOMY_FIELDS.find((field) => field.key === "medicine_division");

  assert.equal(CODEBOOK_VERSION, "1.0");
  assert.match(domain.help, /multiple common indications/);
  assert.match(domain.help, /use Medicine, not Biochemistry and Molecular Pharmacology/);
  assert.match(division.help, /General Internal Medicine and Clinical Innovation/);
  assert.match(
    OPTION_DEFINITIONS.medicine_division["General Internal Medicine and Clinical Innovation"],
    /multiple common indications/,
  );
});

test("hard context rules are derived consistently", () => {
  const labels = applyDerivedRules({
    ...emptyAnnotation(),
    evidence_dependent: 0,
    ctx_patient: 0,
    ctx_institutional: 0,
    ctx_evidence: 1,
  });
  assert.equal(labels.evidence_dependent, 1);
  assert.equal(labels.needs_context, 1);
});

test("medicine division follows department conditional", () => {
  const surgery = applyDerivedRules({
    ...emptyAnnotation(),
    clinical_domain: "Surgery",
    medicine_division: "Cardiology",
  });
  assert.equal(surgery.medicine_division, "Not applicable");

  const medicine = applyDerivedRules({
    ...surgery,
    clinical_domain: "Medicine",
  });
  assert.equal(medicine.medicine_division, null);
});

test("server validation rejects extra keys and invalid values", () => {
  const extra = validateAnnotation({ ...emptyAnnotation(), unexpected: 1 });
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join(" "), /Unexpected fields/);

  const invalid = validateAnnotation({ ...emptyAnnotation(), risk: "Very high" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(" "), /Invalid value for risk/);
});

test("a complete annotation has all 24 fields", () => {
  const labels = Object.fromEntries(
    TAXONOMY_FIELDS.map((field) => [field.key, field.options[0].value]),
  );
  labels.clinical_domain = "Medicine";
  labels.medicine_division = "Cardiology";
  labels.ctx_patient = 0;
  labels.ctx_institutional = 0;
  labels.ctx_evidence = 0;
  labels.needs_context = 0;
  const validated = validateAnnotation(labels, { partial: false });
  assert.equal(validated.ok, true, validated.errors.join(" "));
  assert.deepEqual(annotationProgress(validated.annotation), {
    completed: 24,
    total: 24,
    isComplete: true,
  });
});
