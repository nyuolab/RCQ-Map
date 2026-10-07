import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";
import { checkAccessCode, isUuid, json, publicError } from "../../../lib/server/request";
import {
  allowedAssignmentBatchSize,
  remainingAssignmentCapacity,
  requestedAssignmentBatchSize,
} from "../../../lib/assignment-policy";
import {
  ADDITIONAL_ASSIGNMENT_COUNT,
  ASSIGNMENT_RANDOM_SEED,
  INITIAL_ASSIGNMENT_COUNT,
  MAX_ASSIGNMENTS_PER_RATER,
  REQUIRED_REVIEWS_PER_QUERY,
} from "../../../lib/study-config";

export const runtime = "nodejs";

function parseCount(value) {
  if (value == null || value === "") return null;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

async function getRunVersion(sql, datasetId) {
  await sql`
    INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
    VALUES (${datasetId}, 1, now())
    ON CONFLICT (benchmark_id) DO NOTHING
  `;
  const rows = await sql`
    SELECT run_version::int AS run_version
    FROM benchmark_state
    WHERE benchmark_id = ${datasetId}
    LIMIT 1
  `;
  return rows?.[0]?.run_version ?? 1;
}

async function getAvailability(sql, datasetId, sessionId, runVersion) {
  const rows = await sql`
    SELECT
      COUNT(*)::int AS remaining_slots,
      COUNT(DISTINCT s.question_id)::int AS remaining_queries,
      (
        SELECT COUNT(*)::int
        FROM rater_query_assignment_history history
        WHERE history.benchmark_id = ${datasetId}
          AND history.run_version = ${runVersion}
          AND history.rater_id = ${sessionId}::uuid
      ) AS previously_assigned
    FROM question_review_slots s
    WHERE s.benchmark_id = ${datasetId}
      AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      AND s.rater_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM question_review_slots mine
        WHERE mine.benchmark_id = s.benchmark_id
          AND mine.question_id = s.question_id
          AND mine.rater_id = ${sessionId}::uuid
          AND mine.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      )
      AND NOT EXISTS (
        SELECT 1 FROM annotations a
        WHERE a.dataset_id = s.benchmark_id
          AND a.question_id = s.question_id
          AND a.rater_id = ${sessionId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1 FROM rater_query_assignment_history history
        WHERE history.benchmark_id = s.benchmark_id
          AND history.run_version = ${runVersion}
          AND history.question_id = s.question_id
          AND history.rater_id = ${sessionId}::uuid
      )
  `;
  const capacity = remainingAssignmentCapacity(rows?.[0]?.previously_assigned ?? 0);
  return {
    remainingSlots: Math.min(rows?.[0]?.remaining_slots ?? 0, capacity),
    remainingQueries: Math.min(rows?.[0]?.remaining_queries ?? 0, capacity),
    assignmentCount: rows?.[0]?.previously_assigned ?? 0,
    assignmentLimit: MAX_ASSIGNMENTS_PER_RATER,
  };
}

async function requireRater(sql, sessionId) {
  const rater = await sql`
    SELECT 1 AS ok FROM raters WHERE id = ${sessionId}::uuid LIMIT 1
  `;
  return rater.length > 0;
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
    const runVersion = await getRunVersion(sql, datasetId);

    const assigned = await sql`
      SELECT question_id
      FROM question_review_slots
      WHERE rater_id = ${sessionId}::uuid
        AND benchmark_id = ${datasetId}
        AND slot < ${REQUIRED_REVIEWS_PER_QUERY}
      ORDER BY assigned_at ASC, question_id ASC
    `;
    const state = await sql`
      SELECT 1 AS claimed
      FROM rater_dataset_state
      WHERE rater_id = ${sessionId}::uuid
        AND dataset_id = ${datasetId}
      LIMIT 1
    `;

    return json(200, {
      runVersion,
      questionIds: assigned.map((row) => row.question_id),
      hasClaimedInitial: state.length > 0 || assigned.length > 0,
      ...(await getAvailability(sql, datasetId, sessionId, runVersion)),
    });
  } catch (error) {
    return publicError(error, "Failed to load assignments.");
  }
}

export async function POST(request) {
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
  const requestedCount = parseCount(payload?.count);
  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  if (!datasetId) return json(400, { error: "datasetId is required." });
  if (requestedCount === undefined) return json(400, { error: "count must be a positive integer." });

  try {
    await ensureSchema();
    const sql = getSql();
    if (!(await requireRater(sql, sessionId))) {
      return json(401, { error: "Session not found. Please sign in again." });
    }

    const result = await sql.begin(async (transaction) => {
      // Serializes repeated button presses for one rater without blocking other raters.
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${datasetId}:${sessionId}`}, 0)
        )
      `;
      const runVersion = await getRunVersion(transaction, datasetId);

      const stateRows = await transaction`
        SELECT
          COUNT(*)::int AS assigned,
          COUNT(*) FILTER (WHERE COALESCE(a.is_complete, false) = false)::int AS incomplete,
          (
            SELECT COUNT(*)::int
            FROM rater_query_assignment_history history
            WHERE history.benchmark_id = ${datasetId}
              AND history.run_version = ${runVersion}
              AND history.rater_id = ${sessionId}::uuid
          ) AS previously_assigned,
          EXISTS (
            SELECT 1
            FROM rater_dataset_state state
            WHERE state.rater_id = ${sessionId}::uuid
              AND state.dataset_id = ${datasetId}
          ) AS has_claimed_initial
        FROM question_review_slots s
        LEFT JOIN annotations a
          ON a.dataset_id = s.benchmark_id
          AND a.question_id = s.question_id
          AND a.rater_id = s.rater_id
        WHERE s.benchmark_id = ${datasetId}
          AND s.rater_id = ${sessionId}::uuid
          AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      `;
      const existingCount = stateRows[0]?.assigned || 0;
      const incompleteCount = stateRows[0]?.incomplete || 0;
      const previouslyAssignedCount = stateRows[0]?.previously_assigned || 0;
      const hasClaimedInitial = Boolean(stateRows[0]?.has_claimed_initial)
        || existingCount > 0
        || previouslyAssignedCount > 0;
      const requestedBatchSize = requestedAssignmentBatchSize(hasClaimedInitial);
      const claimCount = allowedAssignmentBatchSize(hasClaimedInitial, previouslyAssignedCount);

      if (requestedCount != null && requestedCount !== requestedBatchSize) {
        return {
          error: `This study assigns ${INITIAL_ASSIGNMENT_COUNT} queries initially and ${ADDITIONAL_ASSIGNMENT_COUNT} per optional add-on batch.`,
          status: 400,
        };
      }
      if (existingCount && incompleteCount) {
        return {
          error: `Complete the current assigned queries before requesting ${ADDITIONAL_ASSIGNMENT_COUNT} more.`,
          status: 409,
        };
      }
      if (!claimCount) {
        return {
          error: `A clinician cannot be assigned more than ${MAX_ASSIGNMENTS_PER_RATER} queries.`,
          status: 409,
        };
      }

      const claimed = await transaction`
        WITH coverage AS (
          SELECT
            question_id,
            COUNT(*) FILTER (WHERE rater_id IS NOT NULL)::int AS assigned_reviews
          FROM question_review_slots
          WHERE benchmark_id = ${datasetId}
            AND slot < ${REQUIRED_REVIEWS_PER_QUERY}
          GROUP BY question_id
        ), ranked_candidates AS (
          SELECT
            s.benchmark_id,
            s.question_id,
            s.slot,
            coverage.assigned_reviews,
            ROW_NUMBER() OVER (PARTITION BY s.question_id ORDER BY s.slot) AS candidate_rank
          FROM question_review_slots s
          JOIN coverage ON coverage.question_id = s.question_id
          WHERE s.benchmark_id = ${datasetId}
            AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
            AND s.rater_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM question_review_slots mine
              WHERE mine.benchmark_id = s.benchmark_id
                AND mine.question_id = s.question_id
                AND mine.rater_id = ${sessionId}::uuid
                AND mine.slot < ${REQUIRED_REVIEWS_PER_QUERY}
            )
            AND NOT EXISTS (
              SELECT 1 FROM annotations a
              WHERE a.dataset_id = s.benchmark_id
                AND a.question_id = s.question_id
                AND a.rater_id = ${sessionId}::uuid
            )
            AND NOT EXISTS (
              SELECT 1 FROM rater_query_assignment_history history
              WHERE history.benchmark_id = s.benchmark_id
                AND history.run_version = ${runVersion}
                AND history.question_id = s.question_id
                AND history.rater_id = ${sessionId}::uuid
            )
        ), picked AS (
          SELECT slots.benchmark_id, slots.question_id, slots.slot
          FROM question_review_slots slots
          JOIN ranked_candidates candidate
            ON candidate.benchmark_id = slots.benchmark_id
            AND candidate.question_id = slots.question_id
            AND candidate.slot = slots.slot
          WHERE candidate.candidate_rank = 1
            AND slots.rater_id IS NULL
          ORDER BY
            candidate.assigned_reviews ASC,
            md5(concat_ws(':', ${ASSIGNMENT_RANDOM_SEED}::text, candidate.benchmark_id, candidate.question_id)),
            candidate.question_id ASC
          LIMIT ${claimCount}
          FOR UPDATE OF slots SKIP LOCKED
        ), recorded AS (
          INSERT INTO rater_query_assignment_history (
            benchmark_id, run_version, question_id, rater_id, assigned_at
          )
          SELECT
            picked.benchmark_id,
            ${runVersion},
            picked.question_id,
            ${sessionId}::uuid,
            now()
          FROM picked
          ON CONFLICT (benchmark_id, run_version, question_id, rater_id) DO NOTHING
          RETURNING benchmark_id, question_id
        ), updated AS (
          UPDATE question_review_slots slots
          SET rater_id = ${sessionId}::uuid,
              assigned_at = now(),
              last_activity_at = now(),
              updated_at = now()
          FROM picked
          JOIN recorded
            ON recorded.benchmark_id = picked.benchmark_id
            AND recorded.question_id = picked.question_id
          WHERE slots.benchmark_id = picked.benchmark_id
            AND slots.question_id = picked.question_id
            AND slots.slot = picked.slot
            AND slots.rater_id IS NULL
          RETURNING slots.question_id
        )
        SELECT question_id FROM updated
      `;

      if (claimed.length) {
        await transaction`
          INSERT INTO rater_dataset_state (
            rater_id, dataset_id, initial_batch_claimed_at, updated_at
          )
          VALUES (${sessionId}::uuid, ${datasetId}, now(), now())
          ON CONFLICT (rater_id, dataset_id) DO UPDATE SET updated_at = now()
        `;
      }

      const assigned = await transaction`
        SELECT question_id
        FROM question_review_slots
        WHERE rater_id = ${sessionId}::uuid
          AND benchmark_id = ${datasetId}
          AND slot < ${REQUIRED_REVIEWS_PER_QUERY}
        ORDER BY assigned_at ASC, question_id ASC
      `;

      return {
        runVersion,
        claimedQuestionIds: claimed.map((row) => row.question_id),
        questionIds: assigned.map((row) => row.question_id),
        hasClaimedInitial: hasClaimedInitial || claimed.length > 0,
        ...(await getAvailability(transaction, datasetId, sessionId, runVersion)),
      };
    });

    if (result.error) return json(result.status, { error: result.error });
    return json(200, result);
  } catch (error) {
    return publicError(error, "Failed to claim assignments.");
  }
}
