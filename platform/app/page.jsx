"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CODEBOOK_VERSION, TAXONOMY_KEYS } from "../lib/taxonomy";
import { STUDY_MARK } from "../lib/branding";

const STORAGE = {
  sessionId: "rcqTaxonomy.sessionId",
  name: "rcqTaxonomy.name",
  accessCode: "rcqTaxonomy.accessCode",
  mode: "rcqTaxonomy.mode",
};

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing can disable storage. The active page still remains usable.
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [existing, setExisting] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const sessionId = storageGet(STORAGE.sessionId);
    const savedName = storageGet(STORAGE.name);
    if (sessionId && savedName) setExisting({ sessionId, name: savedName });
    setAccessCode(storageGet(STORAGE.accessCode) || "");
  }, []);

  async function start(event) {
    event?.preventDefault();
    setError("");
    const normalizedName = name.trim().replace(/\s+/g, " ");
    if (!normalizedName) {
      setError("Enter your annotator name or study ID.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          accessCode: accessCode.trim() || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 503 && process.env.NODE_ENV !== "production") {
        const localSessionId = crypto.randomUUID();
        storageSet(STORAGE.sessionId, localSessionId);
        storageSet(STORAGE.name, normalizedName);
        storageSet(STORAGE.mode, "local");
        router.push("/eval");
        return;
      }
      if (!response.ok) throw new Error(data?.error || "Unable to start your session.");

      storageSet(STORAGE.sessionId, data.sessionId);
      storageSet(STORAGE.name, data.name);
      storageSet(STORAGE.mode, "server");
      if (accessCode.trim()) storageSet(STORAGE.accessCode, accessCode.trim());
      setExisting({ sessionId: data.sessionId, name: data.name });
      router.push("/eval");
    } catch (caught) {
      setError(caught?.message || "Unable to start your session.");
    } finally {
      setIsLoading(false);
    }
  }

  function switchAnnotator() {
    Object.values(STORAGE).forEach(storageRemove);
    setExisting(null);
    setName("");
    setAccessCode("");
    setError("");
  }

  return (
    <main className="welcome-shell">
      <section className="signin-panel" aria-label="Annotator sign in">
        <div className="signin-card">
          <div className="signin-brand">
            <div className="brand-lockup">
              <span className="brand-mark" aria-hidden="true">{STUDY_MARK}</span>
              <div><strong>Clinical Query Taxonomy</strong><span>Clinician annotation study</span></div>
            </div>
            <span className="codebook-chip">Codebook {CODEBOOK_VERSION}</span>
          </div>

          <div className="signin-heading">
            <p className="eyebrow">Annotation workspace</p>
            <h1>{existing ? "Welcome back" : "Begin a session"}</h1>
            <p>{existing ? "Continue exactly where you left off." : `Classify de-identified clinical queries across ${TAXONOMY_KEYS.length} fields. Use the identifier provided by the study team.`}</p>
          </div>

          {existing ? (
            <div className="resume-card">
              <span className="resume-label">Current annotator</span>
              <strong>{existing.name}</strong>
              <button className="button button--primary button--full" onClick={() => router.push("/eval")}>Resume annotation</button>
              <button className="button button--quiet button--full" onClick={switchAnnotator}>Use a different annotator</button>
            </div>
          ) : (
            <form onSubmit={start} noValidate>
              <label className="field-label" htmlFor="annotator-name">Annotator name or study ID</label>
              <input
                id="annotator-name"
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g., Rater 07"
                maxLength={80}
                autoComplete="name"
                autoFocus
              />

              <label className="field-label" htmlFor="access-code">Access code <span>if provided</span></label>
              <input
                id="access-code"
                className="text-input"
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                placeholder="Optional"
                autoComplete="current-password"
              />

              {error ? <div className="alert alert--error" role="alert">{error}</div> : null}

              <button className="button button--primary button--full button--large" disabled={isLoading}>
                {isLoading ? "Starting…" : "Enter workspace"}
              </button>
            </form>
          )}

          <details className="signin-guidance">
            <summary>Before you begin</summary>
            <ul>
              <li>Read each query literally; do not infer unstated clinical facts.</li>
              <li>Judge fields independently unless the codebook shows a hard rule.</li>
              <li>Your selections save automatically as you work.</li>
            </ul>
          </details>

          <p className="privacy-note">
            Do not enter patient information in notes. Query text is provided by the study dataset and should already be de-identified.
          </p>
        </div>
      </section>
    </main>
  );
}
