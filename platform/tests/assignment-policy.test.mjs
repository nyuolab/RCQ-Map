import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  allowedAssignmentBatchSize,
  remainingAssignmentCapacity,
  requestedAssignmentBatchSize,
} from "../lib/assignment-policy.js";

test("assignment batches respect the initial, add-on, and 100-query policies", () => {
  assert.equal(requestedAssignmentBatchSize(false), 40);
  assert.equal(requestedAssignmentBatchSize(true), 10);
  assert.equal(allowedAssignmentBatchSize(false, 0), 40);
  assert.equal(allowedAssignmentBatchSize(true, 90), 10);
  assert.equal(allowedAssignmentBatchSize(true, 95), 5);
  assert.equal(allowedAssignmentBatchSize(true, 100), 0);
  assert.equal(remainingAssignmentCapacity(101), 0);
});

test("assignment capacity rejects invalid historical counts", () => {
  assert.throws(() => remainingAssignmentCapacity(-1), /non-negative integer/);
  assert.throws(() => remainingAssignmentCapacity(1.5), /non-negative integer/);
});

test("database assignment selection is breadth-first and deterministically seeded", () => {
  const route = fs.readFileSync(
    new URL("../app/api/assignments/route.js", import.meta.url),
    "utf8",
  );

  assert.match(
    route,
    /ORDER BY\s+candidate\.assigned_reviews ASC,\s+md5\(concat_ws\(':', \$\{ASSIGNMENT_RANDOM_SEED\}/,
  );
  assert.doesNotMatch(route, /\brandom\s*\(/);
  assert.match(route, /NOT EXISTS \(\s+SELECT 1 FROM rater_query_assignment_history history/);
  assert.match(route, /LIMIT \$\{claimCount\}/);
});

test("assignment history closes duplicate and admin-limit loopholes", () => {
  const schema = fs.readFileSync(
    new URL("../lib/server/schema.js", import.meta.url),
    "utf8",
  );
  const adminRoute = fs.readFileSync(
    new URL("../app/api/admin/assignments/route.js", import.meta.url),
    "utf8",
  );

  assert.match(
    schema,
    /PRIMARY KEY \(benchmark_id, run_version, question_id, rater_id\)/,
  );
  assert.match(adminRoute, /FROM rater_query_assignment_history/);
  assert.match(adminRoute, />= MAX_ASSIGNMENTS_PER_RATER/);
  assert.match(adminRoute, /INSERT INTO rater_query_assignment_history/);
});
