import test from "node:test";
import assert from "node:assert/strict";
import { optionForShortcut, optionShortcut } from "../lib/keyboard-shortcuts.js";
import { TAXONOMY_FIELDS } from "../lib/taxonomy.js";

test("binary shortcuts map N and Y to their semantic values", () => {
  const field = TAXONOMY_FIELDS.find((candidate) => candidate.key === "patient_specific");

  assert.equal(optionForShortcut(field, "n").value, 0);
  assert.equal(optionForShortcut(field, "Y").value, 1);
  assert.equal(optionForShortcut(field, "1"), null);
  assert.equal(optionShortcut(field, field.options[0], 0), "N");
  assert.equal(optionShortcut(field, field.options[1], 1), "Y");
});

test("choice shortcuts use 1 through 9 and 0 for the tenth option", () => {
  const field = TAXONOMY_FIELDS.find((candidate) => candidate.key === "task_category");

  assert.equal(optionForShortcut(field, "1"), field.options[0]);
  assert.equal(optionForShortcut(field, "9"), field.options[8]);
  assert.equal(optionForShortcut(field, "0"), field.options[9]);
  assert.equal(optionForShortcut(field, "y"), null);
  assert.equal(optionShortcut(field, field.options[9], 9), "0");
});

test("options beyond the tenth remain available by click without ambiguous shortcuts", () => {
  const field = TAXONOMY_FIELDS.find((candidate) => candidate.key === "question_intent");

  assert.equal(field.options.length, 12);
  assert.equal(optionShortcut(field, field.options[10], 10), null);
  assert.equal(optionShortcut(field, field.options[11], 11), null);
});
