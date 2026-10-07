import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildCodebookArtifact } from "../lib/codebook.js";
import { parseAnnotationCsv } from "../lib/dataset-parser.js";
import { CODEBOOK_VERSION } from "../lib/taxonomy.js";

const projectRoot = process.cwd();
const configuredInput = String(process.env.ANNOTATION_INPUT || "").trim();
// Your private query file is never part of this repository: point ANNOTATION_INPUT at it (outside the repo),
// or the bundled invented example is used.
const candidates = [
  configuredInput,
]
  .filter(Boolean)
  .map((candidate) => (path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate)));

let sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
let isExample = false;
if (!sourcePath) {
  sourcePath = path.join(projectRoot, "examples", "demo_annotation_queries.csv");
  isExample = true;
} else if (/sample/i.test(path.basename(sourcePath))) {
  isExample = true;
}

if (!fs.existsSync(sourcePath)) {
  console.error(
    "No annotation input found. Set ANNOTATION_INPUT to your query CSV (columns id, specialty, question).",
  );
  process.exit(1);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

const sourceBuffer = fs.readFileSync(sourcePath);
let parsed;
try {
  parsed = parseAnnotationCsv(sourceBuffer.toString("utf8"));
} catch (error) {
  console.error(error?.message || "The annotation dataset could not be parsed.");
  process.exit(1);
}
const { questions, skippedEmptyRows } = parsed;

const datasetId = crypto
  .createHash("sha256")
  .update(sourceBuffer)
  .update("clinician-query-codebook-v1")
  .digest("hex")
  .slice(0, 16);

const generatedAt = new Date().toISOString();
const dataDirectory = path.join(projectRoot, "data");
ensureDir(dataDirectory);

const codebookPath = [
  process.env.CODEBOOK_INPUT,
  path.join(projectRoot, "..", "guidelines", "annotation_guidelines.txt"),
]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));
if (!codebookPath) {
  console.error("The verbatim guidelines (../guidelines/annotation_guidelines.txt) could not be found.");
  process.exit(1);
}
// Preserve the canonical file exactly so clinicians and models receive identical bytes.
const codebookText = fs.readFileSync(codebookPath, "utf8");
if (!codebookText.includes("Clinician Query Annotation Codebook") || !codebookText.includes("Output format")) {
  console.error("The guidelines file does not appear to contain the Clinician Query Annotation Codebook.");
  process.exit(1);
}

fs.writeFileSync(
  path.join(dataDirectory, "annotation_set.json"),
  JSON.stringify(
    {
      datasetId,
      generatedAt,
      codebookVersion: CODEBOOK_VERSION,
      isExample,
      sourceLabel: isExample ? "Example dataset" : path.basename(sourcePath),
      skippedEmptyRows,
      questions,
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(dataDirectory, "codebook.json"),
  JSON.stringify(buildCodebookArtifact(codebookText, CODEBOOK_VERSION), null, 2),
);

console.log(
  `Prepared ${questions.length} queries from ${isExample ? "the example dataset" : path.basename(sourcePath)}; skipped ${skippedEmptyRows} rows without query text (datasetId=${datasetId}).`,
);
