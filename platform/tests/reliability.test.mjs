import test from "node:test";
import assert from "node:assert/strict";
import { calculateReliability } from "../lib/reliability.js";

const fields = [
  { key: "domain", number: "1", label: "Domain" },
  { key: "flag", number: "2", label: "Flag" },
];

function review(labels, codebookVersion = "1.0") {
  return { labels, codebookVersion };
}

test("reliability reports unanimous agreement and Fleiss kappa for three raters", () => {
  const reviewSets = [
    { reviews: [review({ domain: "yes", flag: 1 }), review({ domain: "yes", flag: 1 }), review({ domain: "yes", flag: 1 })] },
    { reviews: [review({ domain: "yes", flag: 1 }), review({ domain: "yes", flag: 1 }), review({ domain: "no", flag: 1 })] },
    { reviews: [review({ domain: "no", flag: 1 }), review({ domain: "no", flag: 1 }), review({ domain: "no", flag: 1 })] },
    { reviews: [review({ domain: "no", flag: 1 }), review({ domain: "no", flag: 1 }), review({ domain: "no", flag: 1 })] },
  ];

  const result = calculateReliability(reviewSets, fields, { raterCount: 3 });
  assert.equal(result.raterCount, 3);
  assert.equal(result.fullyReviewedQueries, 4);
  assert.equal(result.overallAgreement, 0.875);
  assert.equal(result.fields[0].agreement, 0.75);
  assert.ok(Math.abs(result.fields[0].kappa - 46 / 70) < 1e-12);
  assert.equal(result.fields[1].agreement, 1);
  assert.equal(result.fields[1].kappa, null);
  assert.equal(result.fields[1].kappaStatus, "no_variation");
});

test("reliability excludes incomplete trios and mixed codebook versions", () => {
  const reviewSets = [
    {
      reviews: [
        review({ domain: "Medicine", flag: 1 }),
        review({ domain: "Medicine", flag: 1 }),
        review({ domain: "Medicine", flag: 1 }),
      ],
    },
    {
      reviews: [
        review({ domain: "Medicine", flag: 1 }),
        review({ domain: "Medicine", flag: 1 }, "v2"),
        review({ domain: "Medicine", flag: 1 }),
      ],
    },
    {
      reviews: [
        review({ domain: "Medicine", flag: 1 }),
        review({ domain: "Medicine", flag: 1 }),
      ],
    },
  ];

  const result = calculateReliability(reviewSets, fields, {
    codebookVersion: "1.0",
    raterCount: 3,
  });
  assert.equal(result.fullyReviewedQueries, 2);
  assert.equal(result.comparableQueries, 1);
  assert.equal(result.excludedForCodebookVersion, 1);
});

test("derived fields are shown but excluded from summary agreement", () => {
  const result = calculateReliability(
    [
      {
        reviews: [
          review({ coded: "A", derived: 1 }),
          review({ coded: "B", derived: 1 }),
          review({ coded: "B", derived: 1 }),
        ],
      },
    ],
    [
      { key: "coded", number: "1", label: "Coded" },
      { key: "derived", number: "2", label: "Derived", type: "derived" },
    ],
    { raterCount: 3 },
  );

  assert.equal(result.overallAgreement, 0);
  assert.equal(result.fields[1].agreement, 1);
  assert.equal(result.fields[1].isDerived, true);
});

test("reliability rejects invalid rater counts", () => {
  assert.throws(() => calculateReliability([], fields, { raterCount: 1 }), /at least 2/);
});
