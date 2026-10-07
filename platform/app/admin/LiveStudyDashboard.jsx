"use client";

import { useCallback, useEffect, useState } from "react";
import LLMEvaluationClient from "./LLMEvaluationClient";
import QueryInventory from "./QueryInventory";
import ReliabilityClient from "./ReliabilityClient";

const REFRESH_INTERVAL_MS = 15_000;

function formatActivity(value) {
  if (!value) return "Not started";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
}

export default function LiveStudyDashboard({ datasetId, totalQueries, requiredReviews, initialMetrics }) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    try {
      const query = new URLSearchParams({ datasetId });
      const response = await fetch(`/api/admin/metrics?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Administrative metrics could not be refreshed.");
      setMetrics(data);
      setUpdatedAt(data.generatedAt || new Date().toISOString());
      setError("");
    } catch (caught) {
      setError(caught?.message || "Administrative metrics could not be refreshed.");
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [datasetId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh({ quiet: true });
    }, REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const summary = metrics.summary || {};
  const completionPercent = summary.total_slots
    ? Math.round((summary.complete / summary.total_slots) * 100)
    : 0;
  const llmEvaluation = metrics.llmEvaluation || {};
  const concordanceAvailable =
    llmEvaluation.available &&
    llmEvaluation.pairedReviews > 0 &&
    llmEvaluation.overallAgreement != null;
  const concordanceNote = !llmEvaluation.available
    ? "Import the Claude run to calculate"
    : !llmEvaluation.pairedReviews
      ? "Awaiting the first completed clinician review"
      : `Across ${llmEvaluation.pairedReviews} completed clinician ${llmEvaluation.pairedReviews === 1 ? "review" : "reviews"} · live`;

  return (
    <>
      <div className="admin-live-banner" aria-live="polite"><span><i />Live study data{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : " · refreshes every 15 seconds"}</span><button className="button button--quiet button--compact" disabled={refreshing} onClick={() => refresh()}>{refreshing ? "Refreshing…" : "Refresh now"}</button></div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <section className="admin-stats" aria-label="Study statistics">
        <div><span>Queries</span><strong>{totalQueries}</strong><small>in active dataset</small></div>
        <div><span>Annotators</span><strong>{summary.annotators || 0}</strong><small>with saved work</small></div>
        <div><span>Assigned slots</span><strong>{summary.assigned_slots || 0}<em> / {summary.total_slots || 0}</em></strong><small>{requiredReviews} reviews per query</small></div>
        <div><span>Completed reviews</span><strong>{summary.complete || 0}<em> / {summary.total_slots || 0}</em></strong><small>{completionPercent}% complete</small></div>
        <div className="admin-stat--concordance"><span>Clinician–Claude concordance</span><strong>{concordanceAvailable ? `${Math.round(llmEvaluation.overallAgreement * 100)}%` : "—"}</strong><small>{concordanceNote}</small></div>
      </section>

      <div className="admin-grid">
        <section className="admin-card admin-card--wide">
          <div className="admin-card__heading"><div><p className="eyebrow">Annotators</p><h2>Progress by reviewer</h2></div><span>{metrics.raters?.length || 0} active</span></div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Annotator</th><th>Assigned</th><th>Started</th><th>Complete</th><th>Last activity</th></tr></thead>
              <tbody>
                {(metrics.raters || []).map((rater) => (
                  <tr key={rater.rater_id}>
                    <td><strong>{rater.name}</strong><small>{rater.rater_id.slice(0, 8)}</small></td>
                    <td>{rater.assigned}</td><td>{rater.started}</td><td><span className="table-complete">{rater.complete}</span></td>
                    <td>{formatActivity(rater.last_activity)}</td>
                  </tr>
                ))}
                {!metrics.raters?.length ? <tr><td colSpan="5" className="table-empty">No annotators have been assigned yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-card">
          <div className="admin-card__heading"><div><p className="eyebrow">Reliability</p><h2>Query coverage</h2></div></div>
          <div className="coverage-list">
            {Array.from({ length: requiredReviews + 1 }, (_, reviewCount) => reviewCount).map((reviewCount) => {
              const found = metrics.coverage?.find((row) => row.completed_reviews === reviewCount);
              const count = found?.queries || 0;
              return <div key={reviewCount}><span>{reviewCount} completed {reviewCount === 1 ? "review" : "reviews"}</span><strong>{count}</strong><div><i style={{ width: totalQueries ? `${(count / totalQueries) * 100}%` : "0%" }} /></div></div>;
            })}
          </div>
          <p className="admin-card__note">Each query has {requiredReviews} independent review slots. Export includes partial rows but marks completion explicitly.</p>
        </section>
      </div>

      <QueryInventory queries={metrics.queryInventory || []} requiredReviews={requiredReviews} llmAvailable={metrics.llmEvaluation?.available} />

      <ReliabilityClient reliability={metrics.reliability} updatedAt={updatedAt} error="" refreshing={refreshing} onRefresh={() => refresh()} />

      <LLMEvaluationClient datasetId={datasetId} evaluation={metrics.llmEvaluation} queries={metrics.queryInventory || []} onImported={() => refresh()} />
    </>
  );
}
