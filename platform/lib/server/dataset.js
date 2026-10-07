import { CODEBOOK_VERSION } from "../taxonomy.js";
import crypto from "node:crypto";
import { get } from "@vercel/blob";
import bundledDataset from "../../data/annotation_set.json";
import { parseAnnotationCsv } from "../dataset-parser";

const MAX_DATASET_BYTES = 25 * 1024 * 1024;
let datasetPromise;

function parseDataset(buffer) {
  return parseAnnotationCsv(buffer.toString("utf8"));
}

function validatePrivateBlobUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ANNOTATION_BLOB_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".private.blob.vercel-storage.com")) {
    throw new Error("ANNOTATION_BLOB_URL must point to a Vercel Private Blob URL.");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("ANNOTATION_BLOB_URL must point to the uploaded CSV file, not the Blob store root.");
  }
  return url;
}

async function loadPrivateDataset() {
  const blobUrl = validatePrivateBlobUrl(process.env.ANNOTATION_BLOB_URL);
  // Resolve the file through the project's connected BLOB_STORE_ID. Using the
  // pathname prevents a copied URL from silently authenticating against a
  // different store hostname and returning an opaque 403.
  const blobPathname = blobUrl.pathname.replace(/^\/+/, "");
  const result = await get(blobPathname, {
    access: "private",
    useCache: false,
    abortSignal: AbortSignal.timeout(15_000),
  });
  if (!result || result.statusCode !== 200) {
    throw new Error("The private annotation dataset could not be retrieved.");
  }

  const declaredSize = Number(result.blob.size || 0);
  if (declaredSize > MAX_DATASET_BYTES) throw new Error("The private annotation dataset exceeds 25 MB.");
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
  if (buffer.length > MAX_DATASET_BYTES) throw new Error("The private annotation dataset exceeds 25 MB.");

  const { questions, skippedEmptyRows } = parseDataset(buffer);
  const datasetId = crypto
    .createHash("sha256")
    .update(buffer)
    .update("clinician-query-codebook-v1")
    .digest("hex")
    .slice(0, 16);
  return {
    datasetId,
    generatedAt: new Date().toISOString(),
    codebookVersion: CODEBOOK_VERSION,
    isExample: false,
    sourceLabel: "Private clinical query dataset",
    skippedEmptyRows,
    questions,
  };
}

export function getDataset() {
  if (!datasetPromise) {
    datasetPromise = (process.env.ANNOTATION_BLOB_URL
      ? loadPrivateDataset()
      : Promise.resolve(bundledDataset)
    ).catch((error) => {
      datasetPromise = undefined;
      throw error;
    });
  }
  return datasetPromise;
}
