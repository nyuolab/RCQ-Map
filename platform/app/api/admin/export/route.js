import { TAXONOMY_KEYS } from "../../../../lib/taxonomy";
import { getDataset } from "../../../../lib/server/dataset";
import { ensureSchema } from "../../../../lib/server/schema";
import { getSql } from "../../../../lib/server/db";
import { REQUIRED_REVIEWS_PER_QUERY } from "../../../../lib/study-config";

export const runtime = "nodejs";

function csvValue(value) {
  if (value == null) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedId = searchParams.get("datasetId");
    const dataset = await getDataset();
    if (requestedId && requestedId !== dataset.datasetId) {
      return Response.json({ error: "Unknown dataset." }, { status: 404 });
    }
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`
      SELECT
        a.rater_id::text, r.name AS rater_name, a.dataset_id, a.question_id,
        a.codebook_version, a.labels, a.notes, a.is_complete, a.created_at, a.updated_at
      FROM annotations a
      JOIN raters r ON r.id = a.rater_id
      WHERE a.dataset_id = ${dataset.datasetId}
        AND EXISTS (
          SELECT 1 FROM question_review_slots s
          WHERE s.benchmark_id = a.dataset_id
            AND s.question_id = a.question_id
            AND s.rater_id = a.rater_id
            AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
        )
      ORDER BY a.question_id, r.name
    `;
    const questions = new Map(dataset.questions.map((question) => [String(question.id), question]));
    const headers = [
      "rater_id", "rater_name", "dataset_id", "question_id", "specialty", "question",
      "codebook_version", ...TAXONOMY_KEYS, "notes", "is_complete", "created_at", "updated_at",
    ];
    const lines = [headers.join(",")];
    for (const row of rows) {
      const question = questions.get(String(row.question_id)) || {};
      const record = {
        ...row,
        specialty: question.specialty || "",
        question: question.question || "",
        ...(row.labels || {}),
      };
      lines.push(headers.map((header) => csvValue(record[header])).join(","));
    }
    return new Response(`\uFEFF${lines.join("\r\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="clinical_query_annotations_${dataset.datasetId}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Export failed." }, { status: 500 });
  }
}
