import { calculateReliability } from "../reliability";
import { calculateLlmAgreement } from "../llm-evaluation";
import { REQUIRED_REVIEWS_PER_QUERY } from "../study-config";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../taxonomy";

export const EMPTY_RELIABILITY = {
  raterCount: REQUIRED_REVIEWS_PER_QUERY,
  fullyReviewedQueries: 0,
  comparableQueries: 0,
  excludedForCodebookVersion: 0,
  overallAgreement: null,
  meanKappa: null,
  fields: [],
};

export const EMPTY_LLM_EVALUATION = {
  available: false,
  run: null,
  annotatedQueries: 0,
  pairedReviews: 0,
  pairedQueries: 0,
  comparisons: 0,
  agreements: 0,
  overallAgreement: null,
  fields: [],
  queries: [],
};

export async function loadReliabilityStats(sql, datasetId) {
  const rows = await sql`
    SELECT
      slots.question_id,
      jsonb_agg(
        jsonb_build_object(
          'labels', annotations.labels,
          'codebookVersion', annotations.codebook_version
        )
        ORDER BY slots.slot
      ) AS reviews
    FROM question_review_slots slots
    JOIN annotations
      ON annotations.dataset_id = slots.benchmark_id
      AND annotations.question_id = slots.question_id
      AND annotations.rater_id = slots.rater_id
      AND annotations.is_complete
    WHERE slots.benchmark_id = ${datasetId}
      AND slots.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      AND slots.rater_id IS NOT NULL
    GROUP BY slots.question_id
    HAVING COUNT(*) = ${REQUIRED_REVIEWS_PER_QUERY}
    ORDER BY slots.question_id
  `;

  return calculateReliability(
    rows,
    TAXONOMY_FIELDS,
    {
      codebookVersion: CODEBOOK_VERSION,
      raterCount: REQUIRED_REVIEWS_PER_QUERY,
    },
  );
}

export async function loadLlmEvaluationStats(sql, datasetId) {
  const runs = await sql`
    SELECT
      run_id, provider, model, codebook_version, prompt_sha256,
      schema_sha256, record_count, imported_at, updated_at
    FROM llm_annotation_runs
    WHERE dataset_id = ${datasetId}
      AND codebook_version = ${CODEBOOK_VERSION}
    ORDER BY imported_at DESC, run_id DESC
    LIMIT 1
  `;
  const run = runs[0];
  if (!run) return EMPTY_LLM_EVALUATION;

  const pairs = await sql`
    SELECT
      human.question_id,
      human.labels AS human_labels,
      model.labels AS llm_labels
    FROM llm_annotations model
    JOIN annotations human
      ON human.dataset_id = model.dataset_id
      AND human.question_id = model.question_id
      AND human.is_complete
      AND human.codebook_version = ${CODEBOOK_VERSION}
    WHERE model.run_id = ${run.run_id}
      AND model.dataset_id = ${datasetId}
      AND EXISTS (
        SELECT 1
        FROM question_review_slots slot
        WHERE slot.benchmark_id = human.dataset_id
          AND slot.question_id = human.question_id
          AND slot.rater_id = human.rater_id
          AND slot.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      )
    ORDER BY human.question_id, human.rater_id
  `;
  const comparison = calculateLlmAgreement(pairs, TAXONOMY_FIELDS);
  return {
    available: true,
    run: {
      runId: run.run_id,
      provider: run.provider,
      model: run.model,
      codebookVersion: run.codebook_version,
      promptSha256: run.prompt_sha256,
      schemaSha256: run.schema_sha256,
      recordCount: run.record_count,
      importedAt: run.imported_at,
      updatedAt: run.updated_at,
    },
    annotatedQueries: run.record_count,
    ...comparison,
  };
}

export async function loadLlmRunResults(sql, datasetId) {
  const runs = await sql`
    SELECT run_id, provider, model, codebook_version, record_count, imported_at
    FROM llm_annotation_runs
    WHERE dataset_id = ${datasetId}
      AND codebook_version = ${CODEBOOK_VERSION}
    ORDER BY imported_at DESC, run_id DESC
    LIMIT 1
  `;
  const run = runs[0];
  if (!run) return { run: null, annotations: [] };

  const annotations = await sql`
    SELECT question_id, labels, attempts
    FROM llm_annotations
    WHERE run_id = ${run.run_id}
      AND dataset_id = ${datasetId}
    ORDER BY question_id
  `;
  return {
    run: {
      runId: run.run_id,
      provider: run.provider,
      model: run.model,
      codebookVersion: run.codebook_version,
      recordCount: run.record_count,
      importedAt: run.imported_at,
    },
    annotations: annotations.map((annotation) => ({
      questionId: String(annotation.question_id),
      labels: annotation.labels,
      attempts: annotation.attempts,
    })),
  };
}

export async function loadAdminDashboardMetrics(sql, dataset) {
  const datasetId = dataset.datasetId;
  const summaryRows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM question_review_slots WHERE benchmark_id = ${datasetId} AND slot < ${REQUIRED_REVIEWS_PER_QUERY}) AS total_slots,
      (SELECT COUNT(*)::int FROM question_review_slots WHERE benchmark_id = ${datasetId} AND slot < ${REQUIRED_REVIEWS_PER_QUERY} AND rater_id IS NOT NULL) AS assigned_slots,
      (SELECT COUNT(*)::int FROM annotations a WHERE a.dataset_id = ${datasetId} AND EXISTS (
        SELECT 1 FROM question_review_slots s
        WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
          AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      )) AS started,
      (SELECT COUNT(*)::int FROM annotations a WHERE a.dataset_id = ${datasetId} AND a.is_complete AND EXISTS (
        SELECT 1 FROM question_review_slots s
        WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
          AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      )) AS complete,
      (SELECT COUNT(DISTINCT a.rater_id)::int FROM annotations a WHERE a.dataset_id = ${datasetId} AND EXISTS (
        SELECT 1 FROM question_review_slots s
        WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
          AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      )) AS annotators
  `;
  const summary = summaryRows[0] || {
    total_slots: 0,
    assigned_slots: 0,
    started: 0,
    complete: 0,
    annotators: 0,
  };

  const raters = await sql`
    SELECT
      r.id::text AS rater_id,
      r.name,
      COUNT(DISTINCT s.question_id)::int AS assigned,
      COUNT(DISTINCT a.question_id)::int AS started,
      COUNT(DISTINCT a.question_id) FILTER (WHERE a.is_complete)::int AS complete,
      MAX(a.updated_at) AS last_activity
    FROM raters r
    LEFT JOIN question_review_slots s
      ON s.rater_id = r.id AND s.benchmark_id = ${datasetId}
      AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
    LEFT JOIN annotations a
      ON a.rater_id = r.id AND a.dataset_id = ${datasetId}
      AND a.question_id = s.question_id
    GROUP BY r.id, r.name
    HAVING COUNT(DISTINCT s.question_id) > 0 OR COUNT(DISTINCT a.question_id) > 0
    ORDER BY MAX(a.updated_at) DESC NULLS LAST, r.name ASC
  `;

  const perQueryCoverage = await sql`
    SELECT
      s.question_id,
      COUNT(*) FILTER (WHERE s.rater_id IS NOT NULL)::int AS assigned_reviews,
      COUNT(a.rater_id) FILTER (WHERE a.is_complete)::int AS completed_reviews
    FROM question_review_slots s
    LEFT JOIN annotations a
      ON a.dataset_id = s.benchmark_id
      AND a.question_id = s.question_id
      AND a.rater_id = s.rater_id
    WHERE s.benchmark_id = ${datasetId}
      AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
    GROUP BY s.question_id
    ORDER BY s.question_id
  `;

  const [reliability, llmEvaluation] = await Promise.all([
    loadReliabilityStats(sql, datasetId),
    loadLlmEvaluationStats(sql, datasetId),
  ]);
  const coverageByQuestion = new Map(
    perQueryCoverage.map((row) => [String(row.question_id), row]),
  );
  const llmByQuestion = new Map(
    (llmEvaluation.queries || []).map((query) => [String(query.questionId), query]),
  );
  const queryInventory = dataset.questions.map((question, index) => {
    const status = coverageByQuestion.get(String(question.id));
    const llm = llmByQuestion.get(String(question.id));
    return {
      id: String(question.id),
      position: index + 1,
      question: String(question.question || ""),
      assignedReviews: status?.assigned_reviews || 0,
      completedReviews: status?.completed_reviews || 0,
      llmHumanReviews: llm?.humanReviews || 0,
      llmHumanAgreement: llm?.agreement ?? null,
    };
  });
  const coverage = Array.from(
    { length: REQUIRED_REVIEWS_PER_QUERY + 1 },
    (_, completedReviews) => ({
      completed_reviews: completedReviews,
      queries: queryInventory.filter((query) => query.completedReviews === completedReviews).length,
    }),
  );

  return {
    summary,
    raters,
    coverage,
    queryInventory,
    reliability,
    llmEvaluation,
  };
}
