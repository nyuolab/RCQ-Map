import { annotationProgress, CODEBOOK_VERSION, normalizeAnnotation, validateAnnotation } from "../../../lib/taxonomy";
import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";
import { checkAccessCode, isUuid, json, publicError } from "../../../lib/server/request";
import { REQUIRED_REVIEWS_PER_QUERY } from "../../../lib/study-config";

export const runtime = "nodejs";

async function requireRater(sql, sessionId) {
  const rows = await sql`SELECT 1 AS ok FROM raters WHERE id = ${sessionId}::uuid LIMIT 1`;
  return rows.length > 0;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  const datasetId = searchParams.get("datasetId");
  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  if (!datasetId) return json(400, { error: "datasetId is required." });
  const access = checkAccessCode(request);
  if (!access.ok) return json(access.status, { error: access.error });

  try {
    await ensureSchema();
    const sql = getSql();
    if (!(await requireRater(sql, sessionId))) {
      return json(401, { error: "Session not found. Please sign in again." });
    }

    const rows = await sql`
      SELECT question_id, codebook_version, labels, notes, is_complete, updated_at
      FROM annotations
      WHERE rater_id = ${sessionId}::uuid AND dataset_id = ${datasetId}
      ORDER BY question_id
    `;
    return json(200, {
      codebookVersion: CODEBOOK_VERSION,
      annotations: rows.map((row) => ({
        ...row,
        labels: normalizeAnnotation(row.labels),
      })),
    });
  } catch (error) {
    return publicError(error, "Failed to load annotations.");
  }
}

export async function PUT(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  const access = checkAccessCode(request, payload);
  if (!access.ok) return json(access.status, { error: access.error });
  const sessionId = payload?.sessionId;
  const datasetId = payload?.datasetId;
  const questionId = payload?.questionId;
  const notes = typeof payload?.notes === "string" ? payload.notes : "";
  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  if (!datasetId) return json(400, { error: "datasetId is required." });
  if (!questionId) return json(400, { error: "questionId is required." });
  if (notes.length > 4000) return json(400, { error: "Notes are limited to 4,000 characters." });

  const validation = validateAnnotation(payload?.labels, { partial: true });
  if (!validation.ok) return json(400, { error: validation.errors.join(" ") });
  const progress = annotationProgress(validation.annotation);

  try {
    await ensureSchema();
    const sql = getSql();
    if (!(await requireRater(sql, sessionId))) {
      return json(401, { error: "Session not found. Please sign in again." });
    }

    const written = await sql.begin(async (transaction) => {
      // Same per-query lock as the admin release/move transaction, so a save
      // cannot slip in between the admin's "has saved work?" check and its
      // reassignment (which would leave an orphaned annotation that no export
      // or metric can see). Held only for the duration of this transaction.
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${datasetId}:${questionId}`}, 0))
      `;

      const rows = await transaction`
        WITH allowed AS (
          SELECT 1 AS ok
          FROM question_review_slots
          WHERE benchmark_id = ${datasetId}
            AND question_id = ${questionId}
            AND rater_id = ${sessionId}::uuid
            AND slot < ${REQUIRED_REVIEWS_PER_QUERY}
          LIMIT 1
        )
        INSERT INTO annotations (
          rater_id, dataset_id, question_id, codebook_version,
          labels, notes, is_complete, updated_at
        )
        SELECT
          ${sessionId}::uuid, ${datasetId}, ${questionId}, ${CODEBOOK_VERSION},
          ${transaction.json(validation.annotation)}, ${notes}, ${progress.isComplete}, now()
        FROM allowed
        ON CONFLICT (rater_id, dataset_id, question_id)
        DO UPDATE SET
          codebook_version = EXCLUDED.codebook_version,
          labels = EXCLUDED.labels,
          notes = EXCLUDED.notes,
          is_complete = EXCLUDED.is_complete,
          updated_at = now()
        RETURNING updated_at
      `;
      if (!rows.length) return rows;

      await transaction`
        UPDATE question_review_slots
        SET last_activity_at = now(), updated_at = now()
        WHERE benchmark_id = ${datasetId}
          AND question_id = ${questionId}
          AND rater_id = ${sessionId}::uuid
          AND slot < ${REQUIRED_REVIEWS_PER_QUERY}
      `;
      return rows;
    });

    if (!written.length) {
      return json(403, { error: "This query is not assigned to this annotator." });
    }

    return json(200, {
      ok: true,
      isComplete: progress.isComplete,
      completedFields: progress.completed,
      labels: validation.annotation,
      updatedAt: written[0].updated_at,
    });
  } catch (error) {
    return publicError(error, "Failed to save annotation.");
  }
}
