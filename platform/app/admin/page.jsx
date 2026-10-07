import Link from "next/link";
import { getDataset } from "../../lib/server/dataset";
import { ensureSchema } from "../../lib/server/schema";
import { getSql } from "../../lib/server/db";
import {
  EMPTY_LLM_EVALUATION,
  EMPTY_RELIABILITY,
  loadAdminDashboardMetrics,
} from "../../lib/server/admin-metrics";
import { REQUIRED_REVIEWS_PER_QUERY } from "../../lib/study-config";
import AssignmentManager from "./AssignmentManager";
import LiveStudyDashboard from "./LiveStudyDashboard";
import ResetClient from "./ResetClient";
import { STUDY_MARK } from "../../lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY_METRICS = {
  summary: { total_slots: 0, assigned_slots: 0, started: 0, complete: 0, annotators: 0 },
  raters: [],
  coverage: [],
  queryInventory: [],
  reliability: EMPTY_RELIABILITY,
  llmEvaluation: EMPTY_LLM_EVALUATION,
};

export default async function AdminPage() {
  let dataset;
  let metrics = EMPTY_METRICS;
  let allRaters = [];
  let error = "";

  try {
    dataset = await getDataset();
    await ensureSchema();
    const sql = getSql();
    [metrics, allRaters] = await Promise.all([
      loadAdminDashboardMetrics(sql, dataset),
      sql`
        SELECT id::text AS rater_id, name
        FROM raters
        ORDER BY lower(name), created_at
      `,
    ]);
  } catch (caught) {
    error = caught?.message || "Administrative data could not be loaded.";
  }

  const totalQueries = dataset?.questions?.length || 0;

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="brand-lockup"><span className="brand-mark">{STUDY_MARK}</span><div><strong>Study administration</strong><span>Clinical Query Taxonomy</span></div></div>
        <div className="admin-header__actions">
          <Link className="button button--secondary button--compact" href="/">Annotator portal</Link>
          {dataset ? <a className="button button--primary button--compact" href={`/api/admin/export?datasetId=${encodeURIComponent(dataset.datasetId)}`}>Export CSV</a> : null}
        </div>
      </header>

      <div className="admin-content">
        <div className="admin-title">
          <div><p className="eyebrow">Operations</p><h1>Annotation study overview</h1><p>Monitor coverage, live agreement, reviewer progress, model concordance, and assignment operations.</p></div>
          {dataset ? <div className="dataset-chip"><span>{dataset.isExample ? "Example data" : "Active dataset"}</span><strong>{dataset.datasetId}</strong><small>{totalQueries} queries · {dataset.skippedEmptyRows || 0} empty rows skipped · codebook {dataset.codebookVersion}</small></div> : null}
        </div>

        {error ? <div className="admin-error"><strong>Setup required</strong><span>{error}</span></div> : null}

        {!error && dataset ? (
          <>
            {dataset.isExample ? <div className="admin-warning"><strong>Example dataset is active.</strong> Do not begin data collection until the approved private dataset is connected.</div> : null}

            <LiveStudyDashboard
              datasetId={dataset.datasetId}
              totalQueries={totalQueries}
              requiredReviews={REQUIRED_REVIEWS_PER_QUERY}
              initialMetrics={metrics}
            />

            <AssignmentManager datasetId={dataset.datasetId} raters={allRaters} />

            <section className="admin-card danger-card">
              <div className="admin-card__heading"><div><p className="eyebrow">Danger zone</p><h2>Reset active dataset</h2></div></div>
              <ResetClient datasetId={dataset.datasetId} />
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
