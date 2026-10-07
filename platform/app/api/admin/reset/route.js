import { ensureSchema } from "../../../../lib/server/schema";
import { getSql } from "../../../../lib/server/db";
import { json, publicError } from "../../../../lib/server/request";

export const runtime = "nodejs";

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON." });
  }
  const datasetId = String(payload?.datasetId || "").trim();
  if (!datasetId) return json(400, { error: "datasetId is required." });
  if (payload?.confirm !== `RESET ${datasetId}`) {
    return json(400, { error: `Type RESET ${datasetId} exactly to confirm.` });
  }

  try {
    await ensureSchema();
    const sql = getSql();
    const result = await sql.begin(async (transaction) => {
      const deleted = await transaction`
        WITH removed AS (
          DELETE FROM annotations WHERE dataset_id = ${datasetId} RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM removed
      `;
      const cleared = await transaction`
        WITH released AS (
          UPDATE question_review_slots
          SET rater_id = NULL, assigned_at = NULL, last_activity_at = NULL, updated_at = now()
          WHERE benchmark_id = ${datasetId} AND rater_id IS NOT NULL
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM released
      `;
      const states = await transaction`
        WITH removed AS (
          DELETE FROM rater_dataset_state
          WHERE dataset_id = ${datasetId}
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM removed
      `;
      await transaction`
        INSERT INTO benchmark_state (benchmark_id, run_version, reset_at, updated_at)
        VALUES (${datasetId}, 2, now(), now())
        ON CONFLICT (benchmark_id) DO UPDATE SET
          run_version = benchmark_state.run_version + 1,
          reset_at = now(),
          updated_at = now()
      `;
      return {
        deletedAnnotations: deleted[0]?.count || 0,
        clearedAssignments: cleared[0]?.count || 0,
        clearedRaterStates: states[0]?.count || 0,
      };
    });
    return json(200, { ok: true, datasetId, ...result });
  } catch (error) {
    return publicError(error, "Dataset reset failed.");
  }
}
