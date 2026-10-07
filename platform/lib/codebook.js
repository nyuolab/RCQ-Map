import crypto from "node:crypto";

export function buildCodebookArtifact(text, version) {
  if (typeof text !== "string" || !text.includes("Clinician Query Annotation Codebook")) {
    throw new Error("Canonical codebook text is missing or invalid.");
  }
  return {
    version,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    text,
  };
}
