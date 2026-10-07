"use client";

import { useEffect, useMemo, useState } from "react";
import { TAXONOMY_FIELDS } from "../../lib/taxonomy";

const PAGE_SIZE = 20;

function formatPercent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function displayValue(value) {
  if (value === 1) return "Yes";
  if (value === 0) return "No";
  return value == null ? "—" : String(value);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
}

export default function LLMEvaluationClient({ datasetId, evaluation, queries, onImported }) {
  const [bundle, setBundle] = useState(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const questionById = useMemo(
    () => new Map(queries.map((query) => [String(query.id), query])),
    [queries],
  );
  const fieldRows = useMemo(
    () => [...(evaluation?.fields || [])].sort((left, right) => {
      if (left.agreement == null && right.agreement != null) return 1;
      if (left.agreement != null && right.agreement == null) return -1;
      return (left.agreement ?? 0) - (right.agreement ?? 0);
    }),
    [evaluation],
  );
  const filteredResults = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (results?.annotations || []).filter((annotation) => {
      const query = questionById.get(String(annotation.questionId));
      return (
        !needle ||
        String(annotation.questionId).toLocaleLowerCase().includes(needle) ||
        String(query?.question || "").toLocaleLowerCase().includes(needle)
      );
    });
  }, [questionById, results, search]);

  useEffect(() => {
    setResults(null);
    setSearch("");
    setVisibleCount(PAGE_SIZE);
  }, [evaluation?.run?.runId]);

  async function loadResults() {
    setLoadingResults(true);
    setError("");
    try {
      const query = new URLSearchParams({ datasetId });
      const response = await fetch(`/api/admin/llm-evaluations?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "LLM annotations could not be loaded.");
      setResults(data);
      setVisibleCount(PAGE_SIZE);
    } catch (caught) {
      setError(caught?.message || "LLM annotations could not be loaded.");
    } finally {
      setLoadingResults(false);
    }
  }

  async function importRun(event) {
    event.preventDefault();
    if (!bundle) {
      setError("Choose the evaluation import bundle.");
      return;
    }
    const body = new FormData();
    body.append("bundle", bundle);
    setImporting(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/admin/llm-evaluations", { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "The LLM run could not be imported.");
      setMessage(`${data.imported} ${data.model} annotations imported and matched to the active dataset.`);
      setResults(null);
      await onImported();
    } catch (caught) {
      setError(caught?.message || "The LLM run could not be imported.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="admin-card admin-card--full llm-evaluation">
      <div className="admin-card__heading">
        <div><p className="eyebrow">Model evaluation</p><h2>Claude annotations and clinician concordance</h2></div>
        <span>{evaluation?.available ? `${evaluation.annotatedQueries} model labels` : "Not imported"}</span>
      </div>

      {evaluation?.available ? (
        <>
          <div className="llm-run-strip">
            <div><span>Model</span><strong>{evaluation.run?.model}</strong></div>
            <div><span>Coverage</span><strong>{evaluation.annotatedQueries}/{queries.length} queries</strong></div>
            <div><span>Imported</span><strong>{formatDate(evaluation.run?.importedAt)}</strong></div>
            <div><span>Codebook</span><strong>{evaluation.run?.codebookVersion}</strong></div>
          </div>

          <div className="reliability-summary llm-summary" aria-live="polite">
            <div><span>Completed clinician reviews paired</span><strong>{evaluation.pairedReviews || 0}</strong></div>
            <div><span>Queries with a clinician comparison</span><strong>{evaluation.pairedQueries || 0}</strong></div>
            <div><span>Human–LLM field agreement</span><strong>{formatPercent(evaluation.overallAgreement)}</strong></div>
          </div>

          <div className="admin-table-wrap reliability-table-wrap">
            <table className="admin-table reliability-table">
              <thead><tr><th>Field</th><th>Paired decisions</th><th>Human–LLM agreement</th></tr></thead>
              <tbody>
                {fieldRows.map((field) => (
                  <tr key={field.key}>
                    <td><strong>{field.number}. {field.label}</strong><small>{field.key}</small></td>
                    <td>{field.comparisons}</td>
                    <td>{formatPercent(field.agreement)}</td>
                  </tr>
                ))}
                {!fieldRows.length ? <tr><td colSpan="3" className="table-empty">Complete a clinician review to begin the live comparison.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="llm-results-controls">
            <div><strong>Query-level model output</strong><span>Labels are loaded only when requested.</span></div>
            <button className="button button--secondary button--compact" type="button" disabled={loadingResults} onClick={loadResults}>{loadingResults ? "Loading…" : results ? "Reload annotations" : "View annotations"}</button>
          </div>

          {results ? (
            <div className="llm-results">
              <label className="llm-results__search"><span>Search model annotations</span><input className="text-input" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(PAGE_SIZE); }} placeholder="Search query text or ID" /></label>
              <div className="llm-results__list">
                {filteredResults.slice(0, visibleCount).map((annotation) => {
                  const query = questionById.get(String(annotation.questionId));
                  return (
                    <details key={annotation.questionId} className="llm-result">
                      <summary>
                        <span><strong>Query {annotation.questionId}</strong><small>{query?.question || "Query text unavailable"}</small></span>
                        <span>{displayValue(annotation.labels.task_category)}</span>
                      </summary>
                      <div className="llm-result__labels">
                        {TAXONOMY_FIELDS.map((field) => <div key={field.key}><span>{field.number}. {field.label}</span><strong>{displayValue(annotation.labels[field.key])}</strong></div>)}
                      </div>
                    </details>
                  );
                })}
              </div>
              {visibleCount < filteredResults.length ? <button className="button button--secondary button--compact query-inventory__more" type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, filteredResults.length - visibleCount)} more</button> : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="llm-empty-state"><strong>No model run is attached to this dataset.</strong><span>Import the single privacy-preserving evaluation bundle below. Query text is rejected by the server and is never duplicated into the model-results tables.</span></div>
      )}

      {message ? <p className="inline-success" role="status">{message}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <details className="llm-import" open={!evaluation?.available}>
        <summary>{evaluation?.available ? "Replace imported model run" : "Import model run"}</summary>
        <form onSubmit={importRun}>
          <label><span>Evaluation bundle (.import.json)</span><input type="file" accept="application/json,.json" onChange={(event) => setBundle(event.target.files?.[0] || null)} /></label>
          <button className="button button--primary button--compact" type="submit" disabled={importing || !bundle}>{importing ? "Validating and importing…" : "Validate and import"}</button>
        </form>
      </details>

      <p className="admin-card__note">This is descriptive concordance between each completed clinician annotation and the fixed model annotation for the same query. It updates from completed reviews every 15 seconds. It is not included in human inter-rater reliability, and the derived “Needs context” field is excluded from the agreement percentage.</p>
    </section>
  );
}
