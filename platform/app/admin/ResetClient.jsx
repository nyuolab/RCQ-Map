"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ResetClient({ datasetId }) {
  const router = useRouter();
  const expected = `RESET ${datasetId}`;
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  async function reset() {
    setStatus("working");
    setMessage("");
    try {
      const response = await fetch("/api/admin/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId, confirm: confirmation }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Reset failed.");
      setStatus("done");
      setConfirmation("");
      setMessage(`Deleted ${data.deletedAnnotations} annotations, released ${data.clearedAssignments} assignments, and reset ${data.clearedRaterStates || 0} reviewer batch states.`);
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(error?.message || "Reset failed.");
    }
  }

  return (
    <div className="reset-control">
      <p>This permanently deletes every annotation for this dataset, releases all assignments, and invalidates browser caches.</p>
      <label className="field-label" htmlFor="reset-confirm">Type <code>{expected}</code> to continue</label>
      <div><input id="reset-confirm" className="text-input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button className="button button--danger" disabled={confirmation !== expected || status === "working"} onClick={reset}>{status === "working" ? "Resetting…" : "Reset dataset"}</button></div>
      {message ? <span className={`reset-message reset-message--${status}`}>{message}</span> : null}
    </div>
  );
}
