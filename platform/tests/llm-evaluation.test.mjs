import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  calculateLlmAgreement,
  parseEvaluationBundle,
  parseJsonLines,
  validateLlmImport,
} from "../lib/llm-evaluation.js";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../lib/taxonomy.js";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function validAnnotation() {
  return Object.fromEntries(
    TAXONOMY_FIELDS.map((field) => {
      if (field.key === "clinical_domain") return [field.key, "Medicine"];
      if (field.key === "medicine_division") return [field.key, "Cardiology"];
      return [field.key, field.options[0].value];
    }),
  );
}

function fixture() {
  const question = "What is the oral to IV conversion?";
  const runId = "a".repeat(64);
  const prompt = "b".repeat(64);
  return {
    dataset: {
      datasetId: "dataset-1",
      codebookVersion: CODEBOOK_VERSION,
      questions: [{ id: "q1", question }],
    },
    manifest: {
      run_fingerprint: runId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt_sha256: prompt,
      schema_sha256: "c".repeat(64),
      schema_version: CODEBOOK_VERSION,
      selected_query_ids: ["q1"],
      last_run: { succeeded: 1, failed: 0 },
    },
    records: [{
      status: "ok",
      query_id: "q1",
      query_sha256: digest(question),
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt_sha256: prompt,
      annotation: validAnnotation(),
      attempts: 1,
      usage: { total_tokens: 100 },
      response_id: "response-1",
    }],
  };
}

test("JSONL parsing accepts a final record without a trailing newline", () => {
  assert.deepEqual(parseJsonLines('{"query_id":"q1"}'), [{ query_id: "q1" }]);
  assert.throws(() => parseJsonLines('{"query_id":'), /line 1/);
});

test("single-file evaluation bundles contain a manifest and predictions", () => {
  const input = fixture();
  const parsed = parseEvaluationBundle({
    bundle_format: "rcq_llm_evaluation",
    bundle_version: 1,
    manifest: input.manifest,
    predictions: input.records,
  });
  assert.equal(parsed.manifest.run_fingerprint, input.manifest.run_fingerprint);
  assert.equal(parsed.records.length, 1);
  assert.throws(
    () => parseEvaluationBundle({ bundle_format: "wrong", bundle_version: 1 }),
    /not an RCQ LLM evaluation bundle/,
  );
});

test("LLM import validates dataset identity and the exact taxonomy", () => {
  const input = fixture();
  input.manifest.untrusted_extra = "must not be stored";
  const validated = validateLlmImport(input);
  assert.equal(validated.run.recordCount, 1);
  assert.equal(validated.records[0].questionId, "q1");
  assert.deepEqual(validated.records[0].labels, validAnnotation());
  assert.equal(Object.hasOwn(validated.run.manifest, "untrusted_extra"), false);
});

test("LLM import rejects query text and dataset hash mismatches", () => {
  const withText = fixture();
  withText.records[0].question = "private duplicate";
  assert.throws(() => validateLlmImport(withText), /contains query text/);

  const wrongHash = fixture();
  wrongHash.records[0].query_sha256 = "d".repeat(64);
  assert.throws(() => validateLlmImport(wrongHash), /does not match the active dataset/);
});

test("human-model agreement is paired by query and excludes derived fields", () => {
  const fields = [
    { key: "field_a", number: "1", label: "A", type: "choice" },
    { key: "field_b", number: "2", label: "B", type: "choice" },
    { key: "derived", number: "3", label: "Derived", type: "derived" },
  ];
  const result = calculateLlmAgreement([
    { question_id: "q1", human_labels: { field_a: "x", field_b: "y", derived: 0 }, llm_labels: { field_a: "x", field_b: "z", derived: 1 } },
    { question_id: "q1", human_labels: { field_a: "x", field_b: "z", derived: 0 }, llm_labels: { field_a: "x", field_b: "z", derived: 1 } },
  ], fields);

  assert.equal(result.pairedReviews, 2);
  assert.equal(result.pairedQueries, 1);
  assert.equal(result.comparisons, 4);
  assert.equal(result.agreements, 3);
  assert.equal(result.overallAgreement, 0.75);
  assert.deepEqual(result.fields.map((field) => field.key), ["field_a", "field_b"]);
  assert.equal(result.queries[0].humanReviews, 2);
});

test("human-model agreement is available after the first completed clinician review", () => {
  const result = calculateLlmAgreement([
    {
      question_id: "q1",
      human_labels: { task: "same", domain: "human" },
      llm_labels: { task: "same", domain: "model" },
    },
  ], [
    { key: "task", number: "1", label: "Task", type: "choice" },
    { key: "domain", number: "2", label: "Domain", type: "choice" },
  ]);

  assert.equal(result.pairedReviews, 1);
  assert.equal(result.pairedQueries, 1);
  assert.equal(result.comparisons, 2);
  assert.equal(result.overallAgreement, 0.5);
});
