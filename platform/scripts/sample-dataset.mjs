import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseCsv } from "../lib/csv.js";
import { sampleRows } from "../lib/sampling.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/sample-dataset.mjs --input <csv> --output <csv> --count <n> --seed <integer> [--replace]",
    "",
    "Use --replace only when input and output refer to the same file.",
  ].join("\n");
}

function parseArguments(values) {
  const options = { replace: false };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    if (!["--input", "--output", "--count", "--seed"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
    if (index + 1 >= values.length) throw new Error(`Missing value for ${argument}.`);
    options[argument.slice(2)] = values[index + 1];
    index += 1;
  }

  for (const required of ["input", "output", "count", "seed"]) {
    if (options[required] === undefined) throw new Error(`Missing --${required}.\n\n${usage()}`);
  }

  options.count = Number(options.count);
  options.seed = Number(options.seed);
  if (!Number.isSafeInteger(options.count) || options.count < 1) {
    throw new Error("--count must be a positive integer.");
  }
  if (!Number.isSafeInteger(options.seed)) throw new Error("--seed must be an integer.");
  return options;
}

function encodeField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsv(rows, { bom = false } = {}) {
  const contents = rows.map((row) => row.map(encodeField).join(",")).join("\r\n");
  return `${bom ? "\uFEFF" : ""}${contents}\r\n`;
}

function writeAtomically(destination, contents) {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, destination);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  if (inputPath === outputPath && !options.replace) {
    throw new Error("Input and output are the same file; pass --replace to confirm replacement.");
  }

  const source = fs.readFileSync(inputPath, "utf8");
  const rows = parseCsv(source);
  if (rows.length < 2) throw new Error("The input CSV must contain a header and at least one record.");

  const [header, ...records] = rows;
  const sampledRecords = sampleRows(records, options.count, options.seed);
  writeAtomically(outputPath, serializeCsv([header, ...sampledRecords], { bom: source.startsWith("\uFEFF") }));

  console.log(
    `Sampled ${sampledRecords.length} of ${records.length} records without replacement ` +
      `(seed=${options.seed}); wrote ${outputPath}.`,
  );
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}
