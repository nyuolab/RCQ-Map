import crypto from "node:crypto";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS, TAXONOMY_KEYS, validateAnnotation } from "./taxonomy.js";

export const MAX_LLM_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_LLM_IMPORT_RECORDS = 10_000;
export const LLM_BUNDLE_FORMAT = "rcq_llm_evaluation";
export const LLM_BUNDLE_VERSION = 1;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireText(value, label, { pattern } = {}) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (pattern && !pattern.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function parseCount(value, label, { minimum = 0 } = {}) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
  return count;
}

export function parseJsonLines(text) {
  const records = [];
  for (const [index, line] of String(text || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`Predictions line ${index + 1} is not valid JSON.`);
    }
  }
  if (!records.length) throw new Error("The predictions file contains no records.");
  if (records.length > MAX_LLM_IMPORT_RECORDS) {
    throw new Error(`The predictions file exceeds ${MAX_LLM_IMPORT_RECORDS.toLocaleString()} records.`);
  }
  return records;
}

export function parseEvaluationBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The evaluation bundle must be a JSON object.");
  }
  if (value.bundle_format !== LLM_BUNDLE_FORMAT) {
    throw new Error("The file is not an RCQ LLM evaluation bundle.");
  }
  if (value.bundle_version !== LLM_BUNDLE_VERSION) {
    throw new Error(`Unsupported evaluation bundle version: ${String(value.bundle_version)}.`);
  }
  if (!value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest)) {
    throw new Error("The evaluation bundle is missing its run manifest.");
  }
  if (!Array.isArray(value.predictions) || !value.predictions.length) {
    throw new Error("The evaluation bundle contains no predictions.");
  }
  return { manifest: value.manifest, records: value.predictions };
}

export function validateLlmImport({ manifest, records, dataset }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The run manifest must be a JSON object.");
  }
  if (!Array.isArray(records) || !records.length) {
    throw new Error("At least one prediction record is required.");
  }
  if (records.length > MAX_LLM_IMPORT_RECORDS) {
    throw new Error(`The predictions file exceeds ${MAX_LLM_IMPORT_RECORDS.toLocaleString()} records.`);
  }

  const runId = requireText(manifest.run_fingerprint, "Run fingerprint", {
    pattern: /^[a-f0-9]{64}$/i,
  });
  const provider = requireText(manifest.provider, "Provider");
  const model = requireText(manifest.model, "Model");
  const promptSha256 = requireText(manifest.prompt_sha256, "Prompt SHA-256", {
    pattern: /^[a-f0-9]{64}$/i,
  });
  const schemaSha256 = requireText(manifest.schema_sha256, "Schema SHA-256", {
    pattern: /^[a-f0-9]{64}$/i,
  });
  const codebookVersion = requireText(manifest.schema_version, "Schema version");
  if (codebookVersion !== CODEBOOK_VERSION || codebookVersion !== dataset.codebookVersion) {
    throw new Error(
      `The LLM run uses codebook ${codebookVersion}; the active study uses ${dataset.codebookVersion}.`,
    );
  }

  const selectedIds = manifest.selected_query_ids;
  if (!Array.isArray(selectedIds) || !selectedIds.length) {
    throw new Error("The manifest must list selected_query_ids.");
  }
  const selectedIdSet = new Set(selectedIds.map((value) => String(value)));
  if (selectedIdSet.size !== selectedIds.length) {
    throw new Error("The manifest contains duplicate selected query IDs.");
  }

  const questions = new Map(
    dataset.questions.map((question) => [String(question.id), String(question.question || "")]),
  );
  const seenIds = new Set();
  const cleanRecords = records.map((record, index) => {
    const line = index + 1;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Prediction ${line} must be a JSON object.`);
    }
    if (["question", "query", "query_text"].some((key) => Object.hasOwn(record, key))) {
      throw new Error(`Prediction ${line} contains query text; import the privacy-preserving output instead.`);
    }
    if (record.status !== "ok") {
      throw new Error(`Prediction ${line} is not a successful annotation.`);
    }

    const questionId = requireText(record.query_id, `Prediction ${line} query_id`);
    if (seenIds.has(questionId)) throw new Error(`Duplicate prediction for query ${questionId}.`);
    seenIds.add(questionId);
    if (!selectedIdSet.has(questionId)) {
      throw new Error(`Query ${questionId} is absent from the manifest selection.`);
    }
    const question = questions.get(questionId);
    if (question == null) throw new Error(`Query ${questionId} is not in the active dataset.`);
    if (record.query_sha256 !== sha256(question)) {
      throw new Error(`Query ${questionId} does not match the active dataset.`);
    }
    if (record.provider !== provider || record.model !== model) {
      throw new Error(`Prediction ${questionId} does not match the manifest provider and model.`);
    }
    if (record.prompt_sha256 !== promptSha256) {
      throw new Error(`Prediction ${questionId} does not match the manifest prompt.`);
    }

    const validation = validateAnnotation(record.annotation, { partial: false });
    if (!validation.ok) {
      throw new Error(`Prediction ${questionId} is invalid: ${validation.errors.join(" ")}`);
    }
    if (
      Object.keys(record.annotation).length !== TAXONOMY_KEYS.length ||
      TAXONOMY_KEYS.some((key) => !Object.is(record.annotation[key], validation.annotation[key]))
    ) {
      throw new Error(`Prediction ${questionId} does not contain the exact normalized 24-field schema.`);
    }

    return {
      questionId,
      querySha256: record.query_sha256,
      labels: validation.annotation,
      attempts: parseCount(record.attempts ?? 1, `Prediction ${questionId} attempts`, { minimum: 1 }),
      usage:
        record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
          ? record.usage
          : {},
      responseId: String(record.response_id || ""),
    };
  });

  if (seenIds.size !== selectedIdSet.size) {
    throw new Error(
      `The manifest selects ${selectedIdSet.size} queries, but the predictions file contains ${seenIds.size}.`,
    );
  }
  return {
    run: {
      runId,
      datasetId: dataset.datasetId,
      provider,
      model,
      codebookVersion,
      promptSha256,
      schemaSha256,
      recordCount: cleanRecords.length,
      manifest: {
        format_version: manifest.format_version ?? null,
        run_fingerprint: runId,
        provider,
        model,
        schema_version: codebookVersion,
        dataset_sha256: String(manifest.dataset_sha256 || ""),
        prompt_sha256: promptSha256,
        schema_sha256: schemaSha256,
        selected_query_ids: [...selectedIdSet],
        response_format: String(manifest.response_format || ""),
        thinking: String(manifest.thinking || ""),
        prompt_cache: String(manifest.prompt_cache || ""),
        max_tokens: manifest.max_tokens ?? null,
        temperature: manifest.temperature ?? null,
        input_records: manifest.input_records ?? cleanRecords.length,
        last_run: manifest.last_run && typeof manifest.last_run === "object"
          ? {
              requested: manifest.last_run.requested ?? null,
              succeeded: manifest.last_run.succeeded ?? cleanRecords.length,
              failed: manifest.last_run.failed ?? 0,
              started_at: manifest.last_run.started_at ?? null,
              finished_at: manifest.last_run.finished_at ?? null,
              usage:
                manifest.last_run.usage && typeof manifest.last_run.usage === "object"
                  ? manifest.last_run.usage
                  : {},
            }
          : null,
        created_at: manifest.created_at ?? null,
        updated_at: manifest.updated_at ?? null,
      },
    },
    records: cleanRecords,
  };
}

export function calculateLlmAgreement(pairs, fields = TAXONOMY_FIELDS) {
  const scoredFields = fields.filter((field) => field.type !== "derived");
  const fieldTotals = new Map(
    scoredFields.map((field) => [field.key, { comparisons: 0, agreements: 0 }]),
  );
  const queryTotals = new Map();

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const questionId = String(pair.question_id || pair.questionId || "");
    const human = pair.human_labels || pair.humanLabels || {};
    const llm = pair.llm_labels || pair.llmLabels || {};
    if (!questionId) continue;
    const query = queryTotals.get(questionId) || {
      questionId,
      humanReviews: 0,
      comparisons: 0,
      agreements: 0,
    };
    query.humanReviews += 1;

    for (const field of scoredFields) {
      if (human[field.key] == null || llm[field.key] == null) continue;
      const agrees = Object.is(human[field.key], llm[field.key]);
      const fieldTotal = fieldTotals.get(field.key);
      fieldTotal.comparisons += 1;
      fieldTotal.agreements += agrees ? 1 : 0;
      query.comparisons += 1;
      query.agreements += agrees ? 1 : 0;
    }
    queryTotals.set(questionId, query);
  }

  const fieldResults = scoredFields.map((field) => {
    const counts = fieldTotals.get(field.key);
    return {
      key: field.key,
      number: field.number,
      label: field.label,
      comparisons: counts.comparisons,
      agreements: counts.agreements,
      agreement: counts.comparisons ? counts.agreements / counts.comparisons : null,
    };
  });
  const comparisons = fieldResults.reduce((sum, field) => sum + field.comparisons, 0);
  const agreements = fieldResults.reduce((sum, field) => sum + field.agreements, 0);
  const queries = [...queryTotals.values()].map((query) => ({
    ...query,
    agreement: query.comparisons ? query.agreements / query.comparisons : null,
  }));

  return {
    pairedReviews: Array.isArray(pairs) ? pairs.length : 0,
    pairedQueries: queryTotals.size,
    comparisons,
    agreements,
    overallAgreement: comparisons ? agreements / comparisons : null,
    fields: fieldResults,
    queries,
  };
}
