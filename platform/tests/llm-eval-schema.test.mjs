import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { buildCodebookArtifact } from "../lib/codebook.js";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../lib/taxonomy.js";

const schemaPath = new URL("../../schema/annotation_schema.json", import.meta.url);
const canonicalPromptPath = new URL("../../guidelines/annotation_guidelines.txt", import.meta.url);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("LLM evaluation schema stays identical to the clinician annotation schema", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const expected = TAXONOMY_FIELDS.map((field) => ({
    key: field.key,
    type: field.type === "binary" || field.type === "derived" ? "integer" : "string",
    allowed: field.options.map((option) => option.value),
  }));

  assert.equal(schema.schema_version, CODEBOOK_VERSION);
  assert.deepEqual(schema.fields, expected);
});

test("model prompt and clinician codebook are byte-for-byte identical", () => {
  const canonical = fs.readFileSync(canonicalPromptPath, "utf8");
  const clinicianCodebook = buildCodebookArtifact(canonical, CODEBOOK_VERSION);

  assert.equal(clinicianCodebook.version, CODEBOOK_VERSION);
  assert.equal(clinicianCodebook.text, canonical);
  assert.equal(clinicianCodebook.sha256, sha256(canonical));

  for (const field of TAXONOMY_FIELDS) {
    assert.ok(canonical.includes(field.key), `canonical prompt is missing ${field.key}`);
    for (const option of field.options) {
      if (typeof option.value === "string") {
        assert.ok(canonical.includes(option.value), `canonical prompt is missing ${option.value}`);
      }
    }
  }
});
