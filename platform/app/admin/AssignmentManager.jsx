"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function assignmentStatus(assignment) {
  if (assignment.is_complete) return "Complete";
  if (assignment.has_annotation) return "In progress";
  return "Not started";
}

function formatActivity(value) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
}

export default function AssignmentManager({ datasetId, raters }) {
  const router = useRouter();
  const [raterId, setRaterId] = useState(raters[0]?.rater_id || "");
  const [assignments, setAssignments] = useState([]);
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadAssignments = useCallback(async () => {
    if (!raterId) {
      setAssignments([]);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({ datasetId, raterId });
      const response = await fetch(`/api/admin/assignments?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Assignments could not be loaded.");
      setAssignments(data.assignments || []);
      setError("");
    } catch (caught) {
      setError(caught?.message || "Assignments could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [datasetId, raterId]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  async function changeAssignment(assignment, action) {
    const key = `${assignment.question_id}:${assignment.slot}`;
    const targetRaterId = action === "move" ? targets[key] : null;
    if (action === "move" && !targetRaterId) {
      setError("Choose a destination reviewer first.");
      return;
    }

    let deleteAnnotation = false;
    if (assignment.has_annotation) {
      const status = assignment.is_complete ? "completed annotation" : "saved partial annotation";
      deleteAnnotation = window.confirm(`This query has a ${status}. Changing the assignment will permanently delete that work. Continue?`);
      if (!deleteAnnotation) return;
    } else if (!window.confirm(`${action === "move" ? "Move" : "Release"} query ${assignment.question_id}?`)) {
      return;
    }

    setBusyKey(key);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/admin/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetId,
          questionId: assignment.question_id,
          slot: assignment.slot,
          sourceRaterId: raterId,
          targetRaterId,
          action,
          deleteAnnotation,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Assignment could not be changed.");
      setMessage(`${assignment.question_id} ${action === "move" ? "moved" : "released"}${data.deletedAnnotation ? "; saved work was deleted" : ""}.`);
      await loadAssignments();
      router.refresh();
    } catch (caught) {
      setError(caught?.message || "Assignment could not be changed.");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section className="admin-card admin-card--full">
      <div className="admin-card__heading">
        <div><p className="eyebrow">Assignment control</p><h2>Move or release reviewer assignments</h2></div>
        <span>{assignments.length} assigned</span>
      </div>

      <div className="assignment-toolbar">
        <label><span>Reviewer</span><select value={raterId} onChange={(event) => { setRaterId(event.target.value); setMessage(""); setError(""); }}><option value="">Select reviewer</option>{raters.map((rater) => <option key={rater.rater_id} value={rater.rater_id}>{rater.name}</option>)}</select></label>
        <p>Releasing returns an untouched slot to the shared pool. Moving assigns that same review slot to another registered reviewer.</p>
      </div>

      {message ? <p className="inline-success" role="status">{message}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="admin-table-wrap assignment-table-wrap">
        <table className="admin-table assignment-table">
          <thead><tr><th>Query</th><th>Review slot</th><th>Status</th><th>Last activity</th><th>Move to</th><th>Actions</th></tr></thead>
          <tbody>
            {assignments.map((assignment) => {
              const key = `${assignment.question_id}:${assignment.slot}`;
              const busy = busyKey === key;
              return (
                <tr key={key}>
                  <td><strong>{assignment.question_id}</strong><small>{assignment.preview || "No preview"}</small></td>
                  <td>{assignment.slot + 1}</td>
                  <td><span className={`assignment-status assignment-status--${assignmentStatus(assignment).toLowerCase().replace(" ", "-")}`}>{assignmentStatus(assignment)}</span></td>
                  <td>{assignment.annotation_updated_at || assignment.last_activity_at ? formatActivity(assignment.annotation_updated_at || assignment.last_activity_at) : "—"}</td>
                  <td><select aria-label={`Move query ${assignment.question_id} to`} value={targets[key] || ""} onChange={(event) => setTargets((current) => ({ ...current, [key]: event.target.value }))}><option value="">Choose reviewer</option>{raters.filter((rater) => rater.rater_id !== raterId).map((rater) => <option key={rater.rater_id} value={rater.rater_id}>{rater.name}</option>)}</select></td>
                  <td><div className="assignment-actions"><button className="button button--secondary button--compact" disabled={busy || !targets[key]} onClick={() => changeAssignment(assignment, "move")}>Move</button><button className="button button--quiet button--compact" disabled={busy} onClick={() => changeAssignment(assignment, "release")}>{busy ? "Working…" : "Release"}</button></div></td>
                </tr>
              );
            })}
            {!loading && !assignments.length ? <tr><td colSpan="6" className="table-empty">{raterId ? "This reviewer has no assignments." : "Select a reviewer."}</td></tr> : null}
            {loading ? <tr><td colSpan="6" className="table-empty">Loading assignments…</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="admin-card__note">Saved partial or completed annotations are never moved between reviewer identities. Changing those assignments requires confirmation and permanently deletes the source annotation. Every release or move is recorded in the database audit log. Open reviewer workspaces synchronize assignment changes within 30 seconds, and the server rejects saves to a removed assignment immediately. Reviewers with all assignments removed will not automatically receive another initial batch; they must explicitly request the next 10.</p>
    </section>
  );
}
