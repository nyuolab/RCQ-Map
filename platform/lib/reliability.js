function categoryKey(value) {
  return `${typeof value}:${String(value)}`;
}

function fieldReliability(reviewSets, field, raterCount) {
  const observations = reviewSets
    .map((reviewSet) => reviewSet.reviews.map((review) => review.labels?.[field.key]))
    .filter(
      (ratings) =>
        ratings.length === raterCount && ratings.every((rating) => rating != null),
    );

  if (!observations.length) {
    return {
      key: field.key,
      number: field.number,
      label: field.label,
      queries: 0,
      unanimous: 0,
      agreement: null,
      kappa: null,
      kappaStatus: "no_queries",
      isDerived: field.type === "derived",
    };
  }

  let unanimous = 0;
  let observedAgreementTotal = 0;
  const categoryTotals = new Map();

  for (const ratings of observations) {
    const counts = new Map();
    for (const rating of ratings) {
      const key = categoryKey(rating);
      counts.set(key, (counts.get(key) || 0) + 1);
      categoryTotals.set(key, (categoryTotals.get(key) || 0) + 1);
    }

    if (counts.size === 1) unanimous += 1;
    observedAgreementTotal +=
      [...counts.values()].reduce((sum, count) => sum + count * (count - 1), 0) /
      (raterCount * (raterCount - 1));
  }

  const queryCount = observations.length;
  const ratingCount = queryCount * raterCount;
  const observedAgreement = observedAgreementTotal / queryCount;
  const expectedAgreement = [...categoryTotals.values()].reduce(
    (sum, count) => sum + (count / ratingCount) ** 2,
    0,
  );
  const denominator = 1 - expectedAgreement;
  const kappa = Math.abs(denominator) < Number.EPSILON
    ? null
    : (observedAgreement - expectedAgreement) / denominator;

  return {
    key: field.key,
    number: field.number,
    label: field.label,
    queries: queryCount,
    unanimous,
    agreement: unanimous / queryCount,
    kappa,
    kappaStatus: kappa == null ? "no_variation" : "available",
    isDerived: field.type === "derived",
  };
}

export function calculateReliability(
  reviewSets,
  fields,
  { codebookVersion, raterCount = 3 } = {},
) {
  if (!Number.isInteger(raterCount) || raterCount < 2) {
    throw new RangeError("raterCount must be an integer of at least 2.");
  }

  const completedSets = (Array.isArray(reviewSets) ? reviewSets : []).filter(
    (reviewSet) =>
      Array.isArray(reviewSet?.reviews) && reviewSet.reviews.length === raterCount,
  );
  const comparableSets = codebookVersion
    ? completedSets.filter((reviewSet) =>
        reviewSet.reviews.every((review) => review.codebookVersion === codebookVersion),
      )
    : completedSets;
  const fieldStats = fields.map((field) =>
    fieldReliability(comparableSets, field, raterCount),
  );
  const observedFields = fieldStats.filter((field) => field.queries > 0 && !field.isDerived);
  const kappaFields = observedFields.filter((field) => field.kappa != null);
  const totalDecisions = observedFields.reduce((sum, field) => sum + field.queries, 0);
  const totalUnanimous = observedFields.reduce((sum, field) => sum + field.unanimous, 0);

  return {
    raterCount,
    fullyReviewedQueries: completedSets.length,
    comparableQueries: comparableSets.length,
    excludedForCodebookVersion: completedSets.length - comparableSets.length,
    overallAgreement: totalDecisions ? totalUnanimous / totalDecisions : null,
    meanKappa: kappaFields.length
      ? kappaFields.reduce((sum, field) => sum + field.kappa, 0) / kappaFields.length
      : null,
    fields: fieldStats,
  };
}
