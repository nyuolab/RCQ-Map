"use client";

import { useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 20;

export default function QueryInventory({ queries, requiredReviews, llmAvailable = false }) {
  const [search, setSearch] = useState("");
  const [coverageFilter, setCoverageFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return queries.filter((query) => {
      const matchesSearch =
        !needle ||
        query.id.toLocaleLowerCase().includes(needle) ||
        query.question.toLocaleLowerCase().includes(needle);
      const matchesCoverage =
        coverageFilter === "all" ||
        (coverageFilter === "incomplete" && query.completedReviews < requiredReviews) ||
        (coverageFilter === "complete" && query.completedReviews === requiredReviews);
      return matchesSearch && matchesCoverage;
    });
  }, [coverageFilter, queries, requiredReviews, search]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [coverageFilter, search]);

  const visible = filtered.slice(0, visibleCount);

  return (
    <section className="admin-card admin-card--full query-inventory">
      <div className="admin-card__heading">
        <div><p className="eyebrow">Dataset</p><h2>Query inventory</h2></div>
        <span>{queries.length} total</span>
      </div>

      <div className="query-inventory__toolbar">
        <label>
          <span>Search queries</span>
          <input
            className="text-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search query text or ID"
          />
        </label>
        <label>
          <span>Coverage</span>
          <select value={coverageFilter} onChange={(event) => setCoverageFilter(event.target.value)}>
            <option value="all">All queries</option>
            <option value="incomplete">Fewer than {requiredReviews} complete</option>
            <option value="complete">All {requiredReviews} complete</option>
          </select>
        </label>
      </div>

      <div className="query-inventory__result-count" aria-live="polite">
        Showing {visible.length} of {filtered.length} matching {filtered.length === 1 ? "query" : "queries"}
      </div>

      <div className="query-inventory__list">
        {visible.map((query) => (
          <details key={query.id} className="query-inventory__item">
            <summary>
              <span className="query-inventory__index">{query.position}</span>
              <span className="query-inventory__preview">
                <strong>Query {query.id}</strong>
                <span>{query.question}</span>
              </span>
              <span className="query-inventory__coverage">
                <span>{query.assignedReviews}/{requiredReviews} assigned</span>
                <span className={query.completedReviews === requiredReviews ? "query-inventory__complete" : ""}>
                  {query.completedReviews}/{requiredReviews} complete
                </span>
                {llmAvailable ? <span className={query.llmHumanAgreement == null ? "" : "query-inventory__llm"}>{query.llmHumanAgreement == null ? "LLM awaiting review" : `LLM ${Math.round(query.llmHumanAgreement * 100)}% · n=${query.llmHumanReviews}`}</span> : null}
              </span>
            </summary>
            <div className="query-inventory__full-text">{query.question}</div>
          </details>
        ))}
        {!visible.length ? <div className="query-inventory__empty">No queries match these filters.</div> : null}
      </div>

      {visible.length < filtered.length ? (
        <button
          className="button button--secondary button--compact query-inventory__more"
          type="button"
          onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
        >
          Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
        </button>
      ) : null}
    </section>
  );
}
