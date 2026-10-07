import { getDataset } from "../../../../lib/server/dataset";
import { getSql } from "../../../../lib/server/db";
import { isUuid, json, publicError } from "../../../../lib/server/request";
import { ensureSchema } from "../../../../lib/server/schema";
import {
  MAX_ASSIGNMENTS_PER_RATER,
  REQUIRED_REVIEWS_PER_QUERY,
} from "../../../../lib/study-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireActiveDataset(datasetId) {
  const dataset = await getDataset();
  return dataset.datasetId === datasetId ? dataset : null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const datasetId = searchParams.get("datasetId");
  const raterId = searchParams.get("raterId");
  if (!datasetId) return json(400, { error: "datasetId is required." });
  if (!isUuid(raterId || "")) return json(400, { error: "Invalid raterId." });

  try {
    const dataset = await requireActiveDataset(datasetId);
    if (!dataset) {
      return json(404, { error: "The requested dataset is not active." });
    }
    await ensureSchema();
    const rows = await getSql()`
      SELECT
        slots.question_id,
        slots.slot::int,
        slots.assigned_at,
        slots.last_activity_at,
        annotations.rater_id IS NOT NULL AS has_annotation,
        COALESCE(annotations.is_complete, false) AS is_complete,
        annotations.updated_at AS annotation_updated_at
      FROM question_review_slots slots
      LEFT JOIN annotations
        ON annotations.dataset_id = slots.benchmark_id
        AND annotations.question_id = slots.question_id
        AND annotations.rater_id = slots.rater_id
      WHERE slots.benchmark_id = ${datasetId}
        AND slots.rater_id = ${raterId}::uuid
        AND slots.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      ORDER BY slots.assigned_at ASC, slots.question_id ASC
    `;
    const questions = new Map(
      dataset.questions.map((question) => [String(question.id), question.question]),
    );
    return json(200, {
      assignments: rows.map((row) => ({
        ...row,
        preview: String(questions.get(String(row.question_id)) || "").slice(0, 180),
      })),
    });
  } catch (error) {
    return publicError(error, "Assignments could not be loaded.");
  }
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  const datasetId = String(payload?.datasetId || "").trim();
  const questionId = String(payload?.questionId || "").trim();
  const sourceRaterId = payload?.sourceRaterId;
  const targetRaterId = payload?.targetRaterId || null;
  const slot = Number(payload?.slot);
  const action = payload?.action;
  const deleteAnnotation = payload?.deleteAnnotation === true;

  if (!datasetId || !questionId) {
    return json(400, { error: "datasetId and questionId are required." });
  }
  if (!isUuid(sourceRaterId || "")) return json(400, { error: "Invalid sourceRaterId." });
  if (!Number.isInteger(slot) || slot < 0 || slot >= REQUIRED_REVIEWS_PER_QUERY) {
    return json(400, { error: "Invalid review slot." });
  }
  if (!['release', 'move'].includes(action)) return json(400, { error: "Invalid action." });
  if (action === "move" && !isUuid(targetRaterId || "")) {
    return json(400, { error: "Select a valid destination reviewer." });
  }
  if (action === "release" && targetRaterId) {
    return json(400, { error: "Release actions cannot specify a destination reviewer." });
  }
  if (targetRaterId === sourceRaterId) {
    return json(400, { error: "Select a different destination reviewer." });
  }

  try {
    const dataset = await requireActiveDataset(datasetId);
    if (!dataset || !dataset.questions.some((question) => String(question.id) === questionId)) {
      return json(404, { error: "The requested query is not in the active dataset." });
    }
    await ensureSchema();
    const sql = getSql();
    const result = await sql.begin(async (transaction) => {
      if (targetRaterId) {
        // Uses the same lock as self-service claims so the 100-query cap
        // remains safe when an admin move and a claim happen concurrently.
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${datasetId}:${targetRaterId}`}, 0)
          )
        `;
      }
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${datasetId}:${questionId}`}, 0))
      `;
      const state = await transaction`
        SELECT run_version::int AS run_version
        FROM benchmark_state
        WHERE benchmark_id = ${datasetId}
        LIMIT 1
      `;
      const runVersion = state[0]?.run_version ?? 1;
      const current = await transaction`
        SELECT rater_id::text
        FROM question_review_slots
        WHERE benchmark_id = ${datasetId}
          AND question_id = ${questionId}
          AND slot = ${slot}
        FOR UPDATE
      `;
      if (!current.length || current[0].rater_id !== sourceRaterId) {
        return { status: 409, error: "This assignment changed. Refresh and try again." };
      }

      const saved = await transaction`
        SELECT is_complete
        FROM annotations
        WHERE dataset_id = ${datasetId}
          AND question_id = ${questionId}
          AND rater_id = ${sourceRaterId}::uuid
        LIMIT 1
      `;
      if (saved.length && !deleteAnnotation) {
        return {
          status: 409,
          error: "This assignment has saved work. Confirm permanent deletion before changing it.",
          requiresDeleteConfirmation: true,
          isComplete: Boolean(saved[0].is_complete),
        };
      }

      if (action === "move") {
        const target = await transaction`
          SELECT 1 AS exists FROM raters WHERE id = ${targetRaterId}::uuid LIMIT 1
        `;
        if (!target.length) return { status: 404, error: "Destination reviewer not found." };

        const conflict = await transaction`
          SELECT 1 AS conflict
          FROM question_review_slots
          WHERE benchmark_id = ${datasetId}
            AND question_id = ${questionId}
            AND rater_id = ${targetRaterId}::uuid
          UNION ALL
          SELECT 1 AS conflict
          FROM annotations
          WHERE dataset_id = ${datasetId}
            AND question_id = ${questionId}
            AND rater_id = ${targetRaterId}::uuid
          UNION ALL
          SELECT 1 AS conflict
          FROM rater_query_assignment_history
          WHERE benchmark_id = ${datasetId}
            AND run_version = ${runVersion}
            AND question_id = ${questionId}
            AND rater_id = ${targetRaterId}::uuid
          LIMIT 1
        `;
        if (conflict.length) {
          return { status: 409, error: "The destination reviewer has already been assigned this query in the current study run." };
        }

        const targetHistory = await transaction`
          SELECT COUNT(*)::int AS assigned
          FROM rater_query_assignment_history
          WHERE benchmark_id = ${datasetId}
            AND run_version = ${runVersion}
            AND rater_id = ${targetRaterId}::uuid
        `;
        if ((targetHistory[0]?.assigned || 0) >= MAX_ASSIGNMENTS_PER_RATER) {
          return {
            status: 409,
            error: `The destination reviewer has reached the ${MAX_ASSIGNMENTS_PER_RATER}-query assignment limit.`,
          };
        }
      }

      if (saved.length) {
        await transaction`
          DELETE FROM annotations
          WHERE dataset_id = ${datasetId}
            AND question_id = ${questionId}
            AND rater_id = ${sourceRaterId}::uuid
        `;
      }

      if (targetRaterId) {
        await transaction`
          INSERT INTO rater_query_assignment_history (
            benchmark_id, run_version, question_id, rater_id, assigned_at
          ) VALUES (
            ${datasetId}, ${runVersion}, ${questionId}, ${targetRaterId}::uuid, now()
          )
        `;
      }

      await transaction`
        UPDATE question_review_slots
        SET
          rater_id = ${targetRaterId}::uuid,
          assigned_at = ${targetRaterId ? new Date() : null},
          last_activity_at = NULL,
          updated_at = now()
        WHERE benchmark_id = ${datasetId}
          AND question_id = ${questionId}
          AND slot = ${slot}
      `;

      if (targetRaterId) {
        await transaction`
          INSERT INTO rater_dataset_state (rater_id, dataset_id, initial_batch_claimed_at, updated_at)
          VALUES (${targetRaterId}::uuid, ${datasetId}, now(), now())
          ON CONFLICT (rater_id, dataset_id) DO UPDATE SET updated_at = now()
        `;
      }

      await transaction`
        INSERT INTO admin_assignment_events (
          dataset_id, question_id, slot, action,
          source_rater_id, target_rater_id, deleted_annotation, actor
        ) VALUES (
          ${datasetId}, ${questionId}, ${slot}, ${action},
          ${sourceRaterId}::uuid, ${targetRaterId}::uuid,
          ${saved.length > 0}, ${process.env.ADMIN_USER || "admin"}
        )
      `;

      return {
        ok: true,
        action,
        questionId,
        deletedAnnotation: saved.length > 0,
      };
    });

    if (result.error) return json(result.status, result);
    return json(200, result);
  } catch (error) {
    return publicError(error, "Assignment could not be changed.");
  }
}
