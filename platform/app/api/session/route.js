import crypto from "node:crypto";
import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";
import { checkAccessCode, json, normalizeName, publicError } from "../../../lib/server/request";

export const runtime = "nodejs";

function isValidName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.length > 80) return false;
  return true;
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const nameRaw = payload?.name;
  const accessCode = payload?.accessCode;

  const name = normalizeName(nameRaw);
  if (!isValidName(name)) {
    return json(400, { error: "Name is required (max 80 chars)." });
  }

  const access = checkAccessCode(request, { accessCode });
  if (!access.ok) return json(access.status, { error: access.error });

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      // Prevent duplicate rows under concurrent logins for the same name.
      // (Uses PostgreSQL's transactional advisory locks.)
      await tx`SELECT pg_advisory_xact_lock(hashtext(${name.toLowerCase()}))`;

      // If this name already exists, reuse it (prefer the one with existing work if duplicates exist).
      const existing = await tx`
        SELECT
          r.id::text AS id,
          r.name,
          COUNT(a.rater_id)::int AS annotation_count
        FROM raters r
        LEFT JOIN annotations a ON a.rater_id = r.id
        WHERE lower(r.name) = lower(${name})
        GROUP BY r.id, r.name
        ORDER BY COUNT(a.rater_id) DESC, MAX(r.created_at) DESC
        LIMIT 1
      `;
      if (existing.length) {
        return { sessionId: existing[0].id, name: existing[0].name };
      }

      const sessionId = crypto.randomUUID();
      await tx`
        INSERT INTO raters (id, name)
        VALUES (${sessionId}::uuid, ${name})
      `;
      return { sessionId, name };
    });

    return json(200, result);
  } catch (error) {
    return publicError(error, "Failed to create session.");
  }
}
