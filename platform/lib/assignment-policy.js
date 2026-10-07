import {
  ADDITIONAL_ASSIGNMENT_COUNT,
  INITIAL_ASSIGNMENT_COUNT,
  MAX_ASSIGNMENTS_PER_RATER,
} from "./study-config.js";

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

export function requestedAssignmentBatchSize(hasClaimedInitial) {
  return hasClaimedInitial
    ? ADDITIONAL_ASSIGNMENT_COUNT
    : INITIAL_ASSIGNMENT_COUNT;
}

export function remainingAssignmentCapacity(previouslyAssignedCount) {
  requireNonNegativeInteger(previouslyAssignedCount, "Previously assigned count");
  return Math.max(0, MAX_ASSIGNMENTS_PER_RATER - previouslyAssignedCount);
}

export function allowedAssignmentBatchSize(hasClaimedInitial, previouslyAssignedCount) {
  return Math.min(
    requestedAssignmentBatchSize(hasClaimedInitial),
    remainingAssignmentCapacity(previouslyAssignedCount),
  );
}
