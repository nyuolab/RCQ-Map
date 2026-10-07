import { getDataset } from "../../../lib/server/dataset";
import { toRaterDataset } from "../../../lib/rater-dataset";
import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";
import { checkAccessCode, isUuid, json, publicError } from "../../../lib/server/request";

export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  const access = checkAccessCode(request);
  if (!access.ok) return json(access.status, { error: access.error });

  const localDevelopment =
    process.env.NODE_ENV !== "production" && request.headers.get("x-local-session") === "1";
  try {
    if (!localDevelopment) {
      await ensureSchema();
      const sql = getSql();
      const rater = await sql`SELECT 1 AS ok FROM raters WHERE id = ${sessionId}::uuid LIMIT 1`;
      if (!rater.length) return json(401, { error: "Session not found. Please sign in again." });
    }
    return json(200, toRaterDataset(await getDataset()));
  } catch (error) {
    return publicError(error, "The annotation dataset could not be loaded.");
  }
}
