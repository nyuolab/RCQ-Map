import { getDataset } from "../../../../lib/server/dataset";
import { getSql } from "../../../../lib/server/db";
import { loadAdminDashboardMetrics } from "../../../../lib/server/admin-metrics";
import { json, publicError } from "../../../../lib/server/request";
import { ensureSchema } from "../../../../lib/server/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const datasetId = new URL(request.url).searchParams.get("datasetId");
  if (!datasetId) return json(400, { error: "datasetId is required." });

  try {
    const dataset = await getDataset();
    if (dataset.datasetId !== datasetId) {
      return json(404, { error: "The requested dataset is not active." });
    }
    await ensureSchema();
    const metrics = await loadAdminDashboardMetrics(getSql(), dataset);
    return json(200, {
      ...metrics,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return publicError(error, "Administrative metrics could not be loaded.");
  }
}
