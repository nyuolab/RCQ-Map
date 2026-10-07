"use client";

import { useMemo } from "react";

function formatPercent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatKappa(value) {
  return value == null ? "—" : value.toFixed(2);
}

export default function ReliabilityClient({ reliability, updatedAt, error, refreshing, onRefresh }) {
  const rows = useMemo(
    () => [...(reliability?.fields || [])].sort((left, right) => {
      if (left.kappa == null && right.kappa != null) return 1;
      if (left.kappa != null && right.kappa == null) return -1;
      if (left.kappa !== right.kappa) return (left.kappa ?? 0) - (right.kappa ?? 0);
      return (left.agreement ?? 0) - (right.agreement ?? 0);
    }),
    [reliability],
  );

  return (
    <section className="admin-card admin-card--full">
      <div className="admin-card__heading">
        <div><p className="eyebrow">Inter-rater reliability</p><h2>Agreement by codebook field</h2></div>
        <div className="admin-live-controls">
          <span><i />Live{updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : ""}</span>
          <button className="button button--quiet button--compact" disabled={refreshing} onClick={onRefresh}>{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      <div className="reliability-summary" aria-live="polite">
        <div><span>Comparable query trios</span><strong>{reliability?.comparableQueries || 0}</strong></div>
        <div><span>Unanimous agreement</span><strong>{formatPercent(reliability?.overallAgreement)}</strong></div>
        <div><span>Mean Fleiss’ κ</span><strong>{formatKappa(reliability?.meanKappa)}</strong></div>
      </div>

      {error ? <p className="inline-error">{error}</p> : null}
      {reliability?.excludedForCodebookVersion ? (
        <p className="inline-warning">{reliability.excludedForCodebookVersion} fully reviewed query or queries were excluded because all three reviews were not saved under the active codebook version.</p>
      ) : null}

      <div className="admin-table-wrap reliability-table-wrap">
        <table className="admin-table reliability-table">
          <thead><tr><th>Field</th><th>Queries</th><th>Unanimous agreement</th><th>Fleiss’ κ</th></tr></thead>
          <tbody>
            {rows.map((field) => (
              <tr key={field.key}>
                <td><strong>{field.number}. {field.label}</strong><small>{field.key}{field.isDerived ? " · derived (excluded from summary)" : ""}</small></td>
                <td>{field.queries}</td>
                <td>{formatPercent(field.agreement)}</td>
                <td>{field.kappa == null ? <span title={field.kappaStatus === "no_variation" ? "Kappa is undefined when every reviewer uses only one category." : "No fully reviewed queries yet."}>—</span> : field.kappa.toFixed(2)}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan="4" className="table-empty">Complete all three reviews of a query to begin calculating reliability.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="admin-card__note">Calculated only from queries with three complete reviews under the active codebook. Unanimous agreement is pooled across independently annotated forced-choice fields; derived fields are displayed but excluded from both summary measures. Fleiss’ κ is unweighted and adjusts each field for chance agreement across three raters. A dash means there are no comparable query trios or no category variation yet. Early estimates are unstable, so interpret them alongside the query count.</p>
    </section>
  );
}
