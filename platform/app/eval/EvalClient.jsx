"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  annotationProgress,
  applyDerivedRules,
  CODEBOOK_VERSION,
  normalizeAnnotation,
  TAXONOMY_FIELDS,
  TAXONOMY_GROUPS,
} from "../../lib/taxonomy";
import { ADDITIONAL_ASSIGNMENT_COUNT, INITIAL_ASSIGNMENT_COUNT } from "../../lib/study-config";
import {
  isTypingTarget,
  optionForShortcut,
  optionShortcut,
} from "../../lib/keyboard-shortcuts";
import { createSaveQueue } from "../../lib/save-queue";
import { STUDY_MARK } from "../../lib/branding";

const STORAGE = {
  sessionId: "rcqTaxonomy.sessionId",
  name: "rcqTaxonomy.name",
  accessCode: "rcqTaxonomy.accessCode",
  mode: "rcqTaxonomy.mode",
};
const ASSIGNMENT_REFRESH_INTERVAL_MS = 30_000;
// A pending browser record only yields to the server copy when the server copy
// is clearly newer. The tolerance absorbs ordinary clock skew between the
// annotator's device and the database.
const SERVER_NEWER_TOLERANCE_MS = 5 * 60_000;

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
    // The server remains the source of truth if browser storage is unavailable.
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableShuffle(items, seedText) {
  const copy = items.slice();
  let seed = hashSeed(seedText);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const target = Math.floor((seed / 4294967296) * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function normalizeRecord(record = {}) {
  return {
    labels: normalizeAnnotation(record.labels),
    notes: typeof record.notes === "string" ? record.notes : "",
    updatedAt: record.updatedAt || null,
    pending: Boolean(record.pending),
  };
}

function recordProgress(record) {
  return annotationProgress(normalizeRecord(record).labels);
}

function localKey(datasetId, sessionId) {
  return `rcqTaxonomy.annotations.${datasetId}.${sessionId}`;
}

function parseTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

// True when the server copy was clearly written after the browser copy, e.g.
// the same annotator finished the query on another device.
function serverIsClearlyNewer(serverRecord, localRecord) {
  const serverTime = parseTime(serverRecord?.updatedAt);
  const localTime = parseTime(localRecord?.updatedAt);
  if (serverTime == null || localTime == null) return false;
  return serverTime - localTime > SERVER_NEWER_TOLERANCE_MS;
}

function authHeaders(session, includeJson = false) {
  return {
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
    ...(session?.accessCode ? { "x-access-code": session.accessCode } : {}),
    ...(session?.mode === "local" ? { "x-local-session": "1" } : {}),
  };
}

async function putAnnotation(session, datasetId, questionId, record) {
  const response = await fetch("/api/annotations", {
    method: "PUT",
    headers: authHeaders(session, true),
    // keepalive lets a save that is already in flight complete even if the
    // annotator closes the tab immediately afterwards.
    keepalive: true,
    body: JSON.stringify({
      sessionId: session.sessionId,
      datasetId,
      questionId,
      labels: record.labels,
      notes: record.notes,
      accessCode: session.accessCode || undefined,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || "Save failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function OptionDefinitions({ field }) {
  const definitions = field.options.filter((option) => option.description);
  if (!definitions.length) return null;

  return (
    <div className="option-definitions">
      <strong>Option definitions</strong>
      <dl>
        {definitions.map((option) => (
          <div key={String(option.value)}>
            <dt>{option.label}</dt>
            <dd>{option.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FieldControl({ field, value, labels, onChange, helpOpen, onToggleHelp }) {
  const departmentChosen = Boolean(labels.clinical_domain);
  const disabled =
    field.type === "derived" ||
    (field.key === "medicine_division" && labels.clinical_domain !== "Medicine");
  // "Not applicable" is assigned automatically when the department is not
  // Medicine; offering it while Medicine is selected would only be reset.
  const selectableOptions =
    field.key === "medicine_division" && labels.clinical_domain === "Medicine"
      ? field.options.filter((option) => option.value !== "Not applicable")
      : field.options;
  const useSelect = field.control === "select" || field.options.length > 12;
  const hasDefinitions = field.options.some((option) => option.description);
  const describedBy = helpOpen ? `${field.key}-help` : undefined;

  return (
    <fieldset
      id={`field-${field.key}`}
      data-field-key={field.key}
      tabIndex={-1}
      className={`taxonomy-field ${value != null ? "taxonomy-field--answered" : ""}`}
    >
      <legend className="sr-only">{field.label}</legend>
      <div className="taxonomy-field__heading">
        <span className="field-number">{field.number}</span>
        <div className="taxonomy-field__title">
          <span>{field.label}</span>
          <small>{field.prompt}</small>
        </div>
        <button
          type="button"
          className="help-button"
          aria-expanded={helpOpen}
          aria-controls={`${field.key}-help`}
          onClick={onToggleHelp}
        >
          {helpOpen ? "Hide details" : hasDefinitions ? "Rule & definitions" : "View rule"}
        </button>
      </div>

      {helpOpen ? (
        <div className="field-help" id={`${field.key}-help`}>
          <div className="field-help__rule">
            <strong>How to decide</strong>
            <span>{field.help}</span>
          </div>
          <OptionDefinitions field={field} />
        </div>
      ) : null}

      {field.key === "medicine_division" && !departmentChosen ? (
        <div className="derived-value">Choose the owning department first.</div>
      ) : field.type === "derived" || disabled ? (
        <div className="derived-value" aria-describedby={describedBy}>
          <span className="lock-dot" aria-hidden="true" />
          {value == null ? "Calculated after fields 8–10" : value === 1 ? "Yes · calculated" : value === 0 ? "No · calculated" : `${value} · calculated`}
        </div>
      ) : !useSelect ? (
        <div className={`choice-grid ${field.type === "binary" ? "choice-grid--binary" : "choice-grid--options"}`}>
          {field.options.map((option, index) => {
            const shortcut = optionShortcut(field, option, index);
            return (
              <button
                type="button"
                key={String(option.value)}
                className={`choice-button ${shortcut ? "choice-button--shortcut" : ""} ${Object.is(value, option.value) ? "choice-button--selected" : ""}`}
                aria-pressed={Object.is(value, option.value)}
                aria-describedby={describedBy}
                aria-keyshortcuts={shortcut || undefined}
                onClick={() => onChange(option.value)}
              >
                {field.type === "binary" ? <span aria-hidden="true">{option.value === 1 ? "✓" : "—"}</span> : null}
                {option.label}
                {shortcut ? <kbd className="choice-shortcut" aria-hidden="true">{shortcut}</kbd> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <select
          className="choice-select"
          value={value ?? ""}
          aria-label={field.label}
          aria-describedby={describedBy}
          title="Open the list, or type the first letters to jump to a value"
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="" disabled>Select one best value…</option>
          {selectableOptions.map((option) => (
            <option key={String(option.value)} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

function KeyboardShortcutsDialog({ open, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  function trapFocus(event) {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = Array.from(dialog.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.disabled);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const shortcuts = [
    { keys: ["J", "K"], label: "Focus the next or previous answer field" },
    { keys: ["1–9", "0"], label: "Choose the matching numbered option" },
    { keys: ["Y", "N"], label: "Answer Yes or No on a binary field" },
    { keys: ["[", "]"], label: "Move back or forward one section" },
    { keys: ["U"], label: "Jump to the first unanswered field" },
    { keys: ["C"], label: "Copy the current query" },
    { keys: ["B"], label: "Open the codebook" },
    { keys: ["?"], label: "Open this shortcut guide" },
    { keys: ["Esc"], label: "Close an open guide" },
  ];

  return (
    <>
      <button className="keyboard-dialog-scrim" aria-label="Close keyboard shortcuts" onClick={onClose} />
      <section
        className="keyboard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-dialog-title"
        aria-describedby="keyboard-dialog-description"
        onKeyDown={trapFocus}
      >
        <div className="keyboard-dialog__header">
          <div><p className="eyebrow">Faster annotation</p><h2 id="keyboard-dialog-title">Keyboard shortcuts</h2></div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close keyboard shortcuts">×</button>
        </div>
        <p id="keyboard-dialog-description" className="keyboard-dialog__intro">
          Press J or K to focus a field, then use the key shown on an answer. A keyboard answer advances to the next field automatically.
        </p>
        <dl className="keyboard-shortcut-list">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.label}>
              <dt>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
              <dd>{shortcut.label}</dd>
            </div>
          ))}
        </dl>
        <p className="keyboard-dialog__note">Shortcuts pause while you type in notes or search. In a dropdown, J/K still moves to adjacent fields.</p>
      </section>
    </>
  );
}

function interactiveFields(labels) {
  return TAXONOMY_FIELDS.filter(
    (field) => field.type !== "derived" &&
      (field.key !== "medicine_division" || labels.clinical_domain === "Medicine"),
  );
}

function CodebookDrawer({ open, onClose, session }) {
  const [search, setSearch] = useState("");
  const [fullCodebook, setFullCodebook] = useState("");
  const [fullView, setFullView] = useState(false);
  const [fullError, setFullError] = useState("");
  const [fullLoading, setFullLoading] = useState(false);
  const results = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return TAXONOMY_FIELDS;
    return TAXONOMY_FIELDS.filter((field) =>
      [
        field.number,
        field.label,
        field.prompt,
        field.help,
        ...field.options.flatMap((option) => [option.label, option.description || ""]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [search]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  async function showFullCodebook() {
    if (fullCodebook) {
      setFullView(true);
      return;
    }
    setFullLoading(true);
    setFullError("");
    try {
      const query = new URLSearchParams({ sessionId: session.sessionId });
      const response = await fetch(`/api/codebook?${query}`, { headers: authHeaders(session) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "The full codebook could not be loaded.");
      setFullCodebook(data.text || "");
      setFullView(true);
    } catch (error) {
      setFullError(error?.message || "The full codebook could not be loaded.");
    } finally {
      setFullLoading(false);
    }
  }

  return (
    <>
      <button className="drawer-scrim" aria-label="Close codebook" onClick={onClose} />
      <aside className="codebook-drawer" aria-label={`Codebook ${CODEBOOK_VERSION}`} aria-modal="true" role="dialog">
        <div className="drawer-header">
          <div><p className="eyebrow">Reference</p><h2>Codebook {CODEBOOK_VERSION}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close codebook">×</button>
        </div>
        <div className="drawer-body">
          {fullView ? (
            <div className="full-codebook">
              <button className="button button--secondary button--compact" onClick={() => setFullView(false)}>← Back to field guide</button>
              <p><strong>Verbatim study codebook</strong><span>Use this source when a condensed field rule does not resolve the case.</span></p>
              <pre>{fullCodebook}</pre>
            </div>
          ) : (
            <>
          <div className="codebook-rulebox">
            <strong>Always apply</strong>
            <ul>
              <li>Use only the query text.</li>
              <li>Choose one best value for every field.</li>
              <li>Judge fields independently except for hard consistency rules.</li>
              <li>Surface flags require a literal cue in the text.</li>
            </ul>
          </div>
          <div className="codebook-rulebox codebook-rulebox--hard">
            <strong>Hard consistency rules</strong>
            <ul>
              <li>Needs context is the OR of the three context fields.</li>
              <li>Current evidence retrieval implies evidence-dependent.</li>
              <li>Medicine division applies if and only if department is Medicine.</li>
            </ul>
          </div>
          <button className="button button--secondary button--full codebook-full-button" disabled={fullLoading} onClick={showFullCodebook}>{fullLoading ? "Loading codebook…" : "Open full verbatim codebook"}</button>
          {fullError ? <div className="alert alert--error">{fullError}</div> : null}
          <label className="field-label" htmlFor="codebook-search">Find a field or term</label>
          <input
            id="codebook-search"
            className="text-input codebook-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Try “dose”, “imaging”, or “route”"
          />
          <div className="codebook-results" aria-live="polite">
            {results.map((field) => (
              <details key={field.key}>
                <summary><span>{field.number}</span>{field.label}</summary>
                <p>{field.help}</p>
                <OptionDefinitions field={field} />
                {!field.options.some((option) => option.description) ? (
                  <div className="allowed-values"><strong>Allowed values</strong>{field.options.map((option) => option.label).join(" · ")}</div>
                ) : null}
              </details>
            ))}
            {!results.length ? <p className="empty-copy">No codebook fields match “{search}”.</p> : null}
          </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default function EvalClient() {
  const router = useRouter();
  const mainRef = useRef(null);
  const initializedNavigationRef = useRef(false);
  const [session, setSession] = useState(null);
  const [dataset, setDataset] = useState(null);
  const [questionIds, setQuestionIds] = useState(null);
  const [runVersion, setRunVersion] = useState(null);
  const [annotations, setAnnotations] = useState({});
  // The ref is the synchronous source of truth for annotation records; the
  // state mirrors it for rendering. Every write goes through commitAnnotations
  // so back-to-back edits (or an edit landing while a save response is being
  // applied) always build on the newest record.
  const annotationsRef = useRef({});
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [activeGroup, setActiveGroup] = useState(TAXONOMY_GROUPS[0].id);
  const [openHelp, setOpenHelp] = useState(null);
  const [codebookOpen, setCodebookOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [assignmentError, setAssignmentError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [remainingQueries, setRemainingQueries] = useState(0);
  const [hasClaimedInitial, setHasClaimedInitial] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  // idle → nothing saved yet · saving → request in flight or debounce pending ·
  // saved → last save succeeded · retrying → transient failure, retry scheduled ·
  // error → permanent failure for at least one record
  const [saveStatus, setSaveStatus] = useState("idle");
  const [copyStatus, setCopyStatus] = useState("");
  const shortcutTriggerRef = useRef(null);
  const shortcutReturnFocusRef = useRef(null);
  const sessionRef = useRef(null);
  const datasetRef = useRef(null);
  const persistLocalRef = useRef(() => {});
  const handleUnauthorizedRef = useRef(() => {});
  const questionIdsRef = useRef(null);
  const saveQueueRef = useRef(null);

  const endSession = useCallback(() => {
    Object.values(STORAGE).forEach(storageRemove);
    router.push("/");
  }, [router]);

  const handleUnauthorized = useCallback(() => {
    Object.values(STORAGE).forEach(storageRemove);
    router.replace("/");
  }, [router]);

  useEffect(() => {
    sessionRef.current = session;
    datasetRef.current = dataset;
    handleUnauthorizedRef.current = handleUnauthorized;
    questionIdsRef.current = questionIds;
  }, [dataset, handleUnauthorized, questionIds, session]);

  const commitAnnotations = useCallback((updater) => {
    const next = updater(annotationsRef.current);
    annotationsRef.current = next;
    setAnnotations(next);
    return next;
  }, []);

  if (!saveQueueRef.current) {
    saveQueueRef.current = createSaveQueue({
      save: (questionId, snapshot) => {
        const currentSession = sessionRef.current;
        const currentDataset = datasetRef.current;
        if (!currentSession || !currentDataset) {
          const error = new Error("The workspace is still loading.");
          error.status = 0;
          throw error;
        }
        return putAnnotation(currentSession, currentDataset.datasetId, questionId, snapshot);
      },
      onSaving: () => setSaveStatus("saving"),
      onSaved: (questionId, { data, isLatest }) => {
        // Only a response for the newest edit may mark the record clean. A
        // response for an older snapshot must never overwrite newer labels.
        if (isLatest) {
          const next = commitAnnotations((previous) => {
            const current = previous[questionId];
            if (!current) return previous;
            return {
              ...previous,
              [questionId]: {
                ...current,
                updatedAt: data?.updatedAt || current.updatedAt,
                pending: false,
              },
            };
          });
          persistLocalRef.current(next);
        }
        setSyncNotice("");
        setSaveStatus(saveQueueRef.current.inFlightCount() ? "saving" : "saved");
      },
      onError: (questionId, error, { retryable }) => {
        if (error?.status === 401) {
          handleUnauthorizedRef.current();
          return;
        }
        if (retryable) {
          setSaveStatus("retrying");
          return;
        }
        setSaveStatus("error");
        setSyncNotice(
          error?.status === 403
            ? "A query is no longer assigned to you; its unsaved changes will be discarded when the assignment list refreshes."
            : `A change could not be saved: ${error?.message || "unknown error"}`,
        );
      },
    });
  }

  useEffect(() => {
    const sessionId = storageGet(STORAGE.sessionId);
    const name = storageGet(STORAGE.name);
    if (!sessionId || !name) {
      router.replace("/");
      return;
    }
    setSession({
      sessionId,
      name,
      accessCode: storageGet(STORAGE.accessCode) || "",
      mode: storageGet(STORAGE.mode) || "server",
    });
  }, [router]);

  useEffect(() => {
    if (!session) return undefined;
    let cancelled = false;
    const query = new URLSearchParams({ sessionId: session.sessionId });
    fetch(`/api/dataset?${query}`, { cache: "no-store", headers: authHeaders(session) })
      .then(async (response) => {
        if (response.status === 401) {
          handleUnauthorized();
          return null;
        }
        if (!response.ok) throw new Error("The annotation dataset could not be loaded.");
        const data = await response.json();
        if (!Array.isArray(data?.questions) || !data.questions.length || !data.datasetId) {
          throw new Error("The annotation dataset is invalid or empty.");
        }
        if (data && !cancelled) setDataset(data);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error?.message || "The annotation dataset could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized, session]);

  const loadAssignments = useCallback(async () => {
    if (!session || !dataset) return;
    if (session.mode === "local") {
      setQuestionIds(dataset.questions.map((question) => String(question.id)));
      setRunVersion(1);
      setHasClaimedInitial(true);
      return;
    }

    try {
      const query = new URLSearchParams({ sessionId: session.sessionId, datasetId: dataset.datasetId });
      const response = await fetch(`/api/assignments?${query}`, { headers: authHeaders(session) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) return handleUnauthorized();
      if (!response.ok) throw new Error(data?.error || "Assignments could not be loaded.");
      setRunVersion(data.runVersion ?? 1);
      setRemainingQueries(data.remainingQueries ?? 0);
      setHasClaimedInitial(Boolean(data.hasClaimedInitial));

      if (Array.isArray(data.questionIds) && data.questionIds.length) {
        setQuestionIds(data.questionIds.map(String));
        return;
      }
      if (data.hasClaimedInitial) {
        setQuestionIds([]);
        return;
      }

      const claimResponse = await fetch("/api/assignments", {
        method: "POST",
        headers: authHeaders(session, true),
        body: JSON.stringify({
          sessionId: session.sessionId,
          datasetId: dataset.datasetId,
          count: INITIAL_ASSIGNMENT_COUNT,
          accessCode: session.accessCode || undefined,
        }),
      });
      const claimData = await claimResponse.json().catch(() => ({}));
      if (claimResponse.status === 401) return handleUnauthorized();
      if (!claimResponse.ok) throw new Error(claimData?.error || "Queries could not be assigned.");
      setQuestionIds((claimData.questionIds || []).map(String));
      setRunVersion(claimData.runVersion ?? 1);
      setRemainingQueries(claimData.remainingQueries ?? 0);
      setHasClaimedInitial(Boolean(claimData.hasClaimedInitial));
    } catch (error) {
      setAssignmentError(error?.message || "Assignments could not be loaded.");
      setQuestionIds([]);
    }
  }, [dataset, handleUnauthorized, session]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  useEffect(() => {
    if (!session || !dataset || session.mode === "local") return undefined;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const query = new URLSearchParams({ sessionId: session.sessionId, datasetId: dataset.datasetId });
        const response = await fetch(`/api/assignments?${query}`, { cache: "no-store", headers: authHeaders(session) });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) return handleUnauthorized();
        if (!response.ok) return;
        setQuestionIds((data.questionIds || []).map(String));
        setRunVersion(data.runVersion ?? 1);
        setRemainingQueries(data.remainingQueries ?? 0);
        setHasClaimedInitial(Boolean(data.hasClaimedInitial));
      } catch {
        // Keep the current workspace stable during a transient refresh failure.
      }
    }, ASSIGNMENT_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [dataset, handleUnauthorized, session]);

  const persistLocal = useCallback(
    (next) => {
      if (!session || !dataset || runVersion == null) return;
      storageSet(localKey(dataset.datasetId, session.sessionId), JSON.stringify({ runVersion, records: next }));
    },
    [dataset, runVersion, session],
  );

  useEffect(() => {
    persistLocalRef.current = persistLocal;
  }, [persistLocal]);

  useEffect(() => {
    if (!Array.isArray(questionIds)) return;
    const assigned = new Set(questionIds.map(String));
    const queue = saveQueueRef.current;
    let droppedPending = false;
    const before = annotationsRef.current;
    const next = commitAnnotations((previous) => {
      const kept = {};
      for (const [questionId, record] of Object.entries(previous)) {
        if (assigned.has(String(questionId))) {
          kept[questionId] = record;
          continue;
        }
        queue.cancel(questionId);
        if (record?.pending) droppedPending = true;
      }
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
    if (next !== before) persistLocal(next);
    if (droppedPending) {
      setSyncNotice("A query was reassigned by the study team; unsaved changes to it were discarded.");
      setSaveStatus((current) => (current === "error" ? "saved" : current));
    }
  }, [commitAnnotations, persistLocal, questionIds]);

  useEffect(() => {
    if (!session || !dataset || runVersion == null) return undefined;
    let cancelled = false;
    let retryTimer = null;
    const key = localKey(dataset.datasetId, session.sessionId);
    let localRecords = {};
    try {
      const parsed = JSON.parse(storageGet(key) || "null");
      if (parsed?.runVersion === runVersion && parsed?.records && typeof parsed.records === "object") {
        localRecords = Object.fromEntries(
          Object.entries(parsed.records).map(([questionId, record]) => [questionId, normalizeRecord(record)]),
        );
      } else if (parsed) {
        storageRemove(key);
      }
    } catch {
      storageRemove(key);
    }
    commitAnnotations(() => localRecords);
    setAnnotationsLoaded(false);

    if (session.mode === "local") {
      setAnnotationsLoaded(true);
      return undefined;
    }

    // The workspace stays in its loading state until the server copy has been
    // merged, so an annotator can never edit a query on top of a stale or empty
    // record. Failures are retried; nothing is editable until this succeeds.
    let attempt = 0;
    const load = async () => {
      try {
        const query = new URLSearchParams({ sessionId: session.sessionId, datasetId: dataset.datasetId });
        const response = await fetch(`/api/annotations?${query}`, { cache: "no-store", headers: authHeaders(session) });
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (response.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(data?.error || "Saved annotations could not be loaded.");

        const serverRecords = {};
        for (const row of data.annotations || []) {
          serverRecords[String(row.question_id)] = normalizeRecord({
            labels: row.labels,
            notes: row.notes,
            updatedAt: row.updated_at,
            pending: false,
          });
        }
        const merged = { ...serverRecords };
        for (const [questionId, localRecord] of Object.entries(localRecords)) {
          const serverRecord = merged[questionId];
          if (!serverRecord) {
            merged[questionId] = localRecord;
          } else if (localRecord.pending && !serverIsClearlyNewer(serverRecord, localRecord)) {
            // Unsynced browser work wins unless the server copy was clearly
            // written later (for example on another device).
            merged[questionId] = localRecord;
          }
        }
        const assigned = Array.isArray(questionIdsRef.current) ? new Set(questionIdsRef.current.map(String)) : null;
        const next = commitAnnotations(() => (
          assigned
            ? Object.fromEntries(Object.entries(merged).filter(([questionId]) => assigned.has(String(questionId))))
            : merged
        ));
        persistLocal(next);
        setSyncNotice("");
        setAnnotationsLoaded(true);

        const queue = saveQueueRef.current;
        for (const [questionId, record] of Object.entries(next)) {
          if (record.pending) queue.enqueue(questionId, record, { immediate: true });
        }
      } catch (error) {
        if (cancelled) return;
        attempt += 1;
        const delay = Math.min(30_000, 2000 * 2 ** (attempt - 1));
        setSyncNotice(`${error?.message || "Saved annotations could not be loaded."} Retrying…`);
        retryTimer = window.setTimeout(load, delay);
      }
    };
    load();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [commitAnnotations, dataset, handleUnauthorized, persistLocal, runVersion, session]);

  const questions = useMemo(() => {
    if (!dataset || !Array.isArray(questionIds)) return [];
    const questionsById = new Map(
      dataset.questions.map((question) => [String(question.id), question]),
    );
    const assigned = questionIds
      .map((questionId) => questionsById.get(String(questionId)))
      .filter(Boolean);
    return session?.mode === "local"
      ? stableShuffle(assigned, `${dataset.datasetId}:${session.sessionId}`)
      : assigned;
  }, [dataset, questionIds, session?.sessionId]);

  useEffect(() => {
    if (questions.length && questionIndex >= questions.length) {
      setQuestionIndex(questions.length - 1);
    }
  }, [questionIndex, questions.length]);

  useEffect(() => {
    // Wait for the server copy: on a fresh device the browser cache is empty,
    // so jumping before the load would always land on the first query.
    if (initializedNavigationRef.current || !questions.length || !annotationsLoaded) return;
    const firstIncomplete = questions.findIndex(
      (question) => !recordProgress(annotations[String(question.id)]).isComplete,
    );
    setQuestionIndex(firstIncomplete >= 0 ? firstIncomplete : 0);
    initializedNavigationRef.current = true;
  }, [annotations, annotationsLoaded, questions]);

  const currentQuestion = questions[questionIndex];
  const currentId = currentQuestion ? String(currentQuestion.id) : "";
  const currentRecord = normalizeRecord(annotations[currentId]);
  const currentProgress = recordProgress(currentRecord);
  const group = TAXONOMY_GROUPS.find((item) => item.id === activeGroup) || TAXONOMY_GROUPS[0];
  const groupFields = TAXONOMY_FIELDS.filter((field) => field.group === group.id);
  const groupCompleted = groupFields.filter((field) => currentRecord.labels[field.key] != null).length;

  const completedQueries = useMemo(
    () => questions.filter((question) => recordProgress(annotations[String(question.id)]).isComplete).length,
    [annotations, questions],
  );

  const pendingCount = useMemo(
    () => questions.filter((question) => annotations[String(question.id)]?.pending).length,
    [annotations, questions],
  );

  // Warn before the tab closes while any change is still unsynced, and push
  // pending saves as soon as connectivity or visibility returns.
  useEffect(() => {
    if (!pendingCount) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingCount]);

  useEffect(() => {
    const queue = saveQueueRef.current;
    const flush = () => queue.flushAll();
    // hidden → send anything pending now (keepalive keeps it alive);
    // visible → retry anything that failed while the tab was in the background.
    const onVisibility = () => queue.flushAll();
    window.addEventListener("online", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      // Do not dispose: a save scheduled just before leaving the workspace
      // (for example via End session) should still be sent.
      queue.flushAll();
    };
  }, []);

  const updateCurrent = useCallback(
    (updater) => {
      if (!currentId) return;
      const isLocalMode = session?.mode === "local";
      const next = commitAnnotations((previous) => {
        const existing = normalizeRecord(previous[currentId]);
        const updated = normalizeRecord(updater(existing));
        updated.updatedAt = new Date().toISOString();
        updated.pending = !isLocalMode;
        return { ...previous, [currentId]: updated };
      });
      persistLocal(next);
      if (isLocalMode) {
        setSaveStatus("local");
      } else {
        saveQueueRef.current.enqueue(currentId, next[currentId]);
      }
    },
    [commitAnnotations, currentId, persistLocal, session?.mode],
  );

  const updateLabel = useCallback(
    (key, value) => {
      updateCurrent((record) => ({
        ...record,
        labels: applyDerivedRules({ ...record.labels, [key]: value }),
      }));
    },
    [updateCurrent],
  );

  const openShortcuts = useCallback(() => {
    shortcutReturnFocusRef.current = document.activeElement;
    setShortcutsOpen(true);
  }, []);

  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    const returnTarget = shortcutReturnFocusRef.current;
    window.setTimeout(() => {
      if (returnTarget?.isConnected && returnTarget !== document.body) returnTarget.focus();
      else shortcutTriggerRef.current?.focus();
    }, 0);
  }, []);

  const focusField = useCallback((field) => {
    if (!field) return;
    if (field.group !== activeGroup) {
      setActiveGroup(field.group);
      setOpenHelp(null);
    }
    window.setTimeout(() => {
      const element = document.getElementById(`field-${field.key}`);
      const focusTarget = element?.querySelector("select") || element;
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusTarget?.focus({ preventScroll: true });
    }, 0);
  }, [activeGroup]);

  const focusAdjacentField = useCallback((direction, sourceTarget = null) => {
    const fields = interactiveFields(currentRecord.labels);
    const sourceKey = sourceTarget?.closest?.("[data-field-key]")?.dataset.fieldKey;
    if (!sourceKey) {
      const visibleFields = fields.filter((field) => field.group === activeGroup);
      const searchOrder = direction > 0 ? visibleFields : visibleFields.slice().reverse();
      const unanswered = searchOrder.find((field) => currentRecord.labels[field.key] == null);
      focusField(unanswered || (direction > 0 ? visibleFields[0] : visibleFields.at(-1)));
      return;
    }

    const index = fields.findIndex((field) => field.key === sourceKey);
    const target = fields[index + direction];
    if (target) focusField(target);
  }, [activeGroup, currentRecord.labels, focusField]);

  const selectQuestion = useCallback((index) => {
    setQuestionIndex(index);
    setActiveGroup(TAXONOMY_GROUPS[0].id);
    setOpenHelp(null);
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const stepBack = useCallback(() => {
    const groupIndex = TAXONOMY_GROUPS.findIndex((item) => item.id === activeGroup);
    if (groupIndex > 0) {
      setActiveGroup(TAXONOMY_GROUPS[groupIndex - 1].id);
    } else if (questionIndex > 0) {
      setQuestionIndex((index) => index - 1);
      setActiveGroup(TAXONOMY_GROUPS.at(-1).id);
    }
    setOpenHelp(null);
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeGroup, questionIndex]);

  const stepForward = useCallback(() => {
    const groupIndex = TAXONOMY_GROUPS.findIndex((item) => item.id === activeGroup);
    if (groupIndex < TAXONOMY_GROUPS.length - 1) {
      setActiveGroup(TAXONOMY_GROUPS[groupIndex + 1].id);
    } else if (questionIndex < questions.length - 1 && currentProgress.isComplete) {
      setQuestionIndex((index) => index + 1);
      setActiveGroup(TAXONOMY_GROUPS[0].id);
    }
    setOpenHelp(null);
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeGroup, currentProgress.isComplete, questionIndex, questions.length]);

  const goToFirstUnanswered = useCallback(() => {
    const field = interactiveFields(currentRecord.labels).find(
      (candidate) => currentRecord.labels[candidate.key] == null,
    );
    focusField(field);
  }, [currentRecord.labels, focusField]);

  const claimMore = useCallback(async () => {
    if (!session || !dataset || session.mode === "local") return;
    const requestCount = hasClaimedInitial
      ? ADDITIONAL_ASSIGNMENT_COUNT
      : INITIAL_ASSIGNMENT_COUNT;
    setIsClaiming(true);
    setAssignmentError("");
    try {
      const response = await fetch("/api/assignments", {
        method: "POST",
        headers: authHeaders(session, true),
        body: JSON.stringify({
          sessionId: session.sessionId,
          datasetId: dataset.datasetId,
          count: requestCount,
          accessCode: session.accessCode || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) return handleUnauthorized();
      if (!response.ok) throw new Error(data?.error || "More queries could not be assigned.");
      const nextQuestionIds = (data.questionIds || []).map(String);
      const firstNewId = (data.claimedQuestionIds || []).map(String)[0];
      setQuestionIds(nextQuestionIds);
      if (firstNewId) {
        const firstNewIndex = nextQuestionIds.indexOf(firstNewId);
        if (firstNewIndex >= 0) setQuestionIndex(firstNewIndex);
        setActiveGroup(TAXONOMY_GROUPS[0].id);
        setOpenHelp(null);
        mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
      setRemainingQueries(data.remainingQueries ?? 0);
      setHasClaimedInitial(Boolean(data.hasClaimedInitial));
      initializedNavigationRef.current = true;
    } catch (error) {
      setAssignmentError(error?.message || "More queries could not be assigned.");
    } finally {
      setIsClaiming(false);
    }
  }, [dataset, handleUnauthorized, hasClaimedInitial, session]);

  const copyQuery = useCallback(async () => {
    if (!currentQuestion) return;
    try {
      await navigator.clipboard.writeText(currentQuestion.question);
      setCopyStatus("Copied");
      setTimeout(() => setCopyStatus(""), 1600);
    } catch {
      setCopyStatus("Copy unavailable");
    }
  }, [currentQuestion]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

      if (shortcutsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeShortcuts();
        }
        return;
      }
      const key = event.key.toLowerCase();
      const selectNavigation = event.target?.tagName === "SELECT" && (key === "j" || key === "k");
      if (codebookOpen || (isTypingTarget(event.target) && !selectNavigation)) return;

      if (key === "?") {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setCodebookOpen(true);
        return;
      }
      if (key === "c") {
        event.preventDefault();
        copyQuery();
        return;
      }
      if (key === "u") {
        event.preventDefault();
        goToFirstUnanswered();
        return;
      }
      if (key === "j" || key === "k") {
        event.preventDefault();
        focusAdjacentField(key === "j" ? 1 : -1, event.target);
        return;
      }
      if (key === "[" || key === "]") {
        event.preventDefault();
        if (key === "[") stepBack();
        else stepForward();
        return;
      }

      const fieldKey = event.target?.closest?.("[data-field-key]")?.dataset.fieldKey;
      const field = TAXONOMY_FIELDS.find((candidate) => candidate.key === fieldKey);
      if (!field || !interactiveFields(currentRecord.labels).some((candidate) => candidate.key === field.key)) return;
      const option = optionForShortcut(field, key);
      if (!option) return;

      event.preventDefault();
      updateLabel(field.key, option.value);
      const nextLabels = applyDerivedRules({ ...currentRecord.labels, [field.key]: option.value });
      const fields = interactiveFields(nextLabels);
      const nextField = fields[fields.findIndex((candidate) => candidate.key === field.key) + 1];
      if (nextField) focusField(nextField);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    closeShortcuts,
    codebookOpen,
    copyQuery,
    currentRecord.labels,
    focusAdjacentField,
    focusField,
    goToFirstUnanswered,
    openShortcuts,
    shortcutsOpen,
    stepBack,
    stepForward,
    updateLabel,
  ]);

  if (loadError) {
    return <main className="status-page"><div className="status-card"><p className="eyebrow">Dataset error</p><h1>Annotation cannot start</h1><p>{loadError}</p><button className="button button--secondary" onClick={() => router.push("/")}>Return home</button></div></main>;
  }

  if (!session || !dataset || questionIds === null || runVersion == null || !annotationsLoaded) {
    return (
      <main className="status-page">
        <div className="loading-mark" aria-label="Loading annotation workspace"><span /><span /><span /></div>
        {syncNotice ? <p className="status-note" role="status">{syncNotice}</p> : null}
      </main>
    );
  }

  if (!questions.length) {
    return (
      <main className="status-page">
        <div className="status-card">
          <p className="eyebrow">Assignments</p>
          <h1>No queries are assigned</h1>
          <p>{assignmentError || (remainingQueries ? "Queries are available to claim." : "This dataset already has the required review coverage.")}</p>
          {remainingQueries ? <button className="button button--primary" disabled={isClaiming} onClick={claimMore}>{isClaiming ? "Assigning…" : hasClaimedInitial ? `Assign ${ADDITIONAL_ASSIGNMENT_COUNT} more queries` : `Claim initial ${INITIAL_ASSIGNMENT_COUNT} queries`}</button> : null}
          <button className="button button--quiet" onClick={() => router.push("/")}>Return home</button>
        </div>
      </main>
    );
  }

  const groupIndex = TAXONOMY_GROUPS.findIndex((item) => item.id === activeGroup);
  const lastGroup = groupIndex === TAXONOMY_GROUPS.length - 1;
  const lastQuestion = questionIndex === questions.length - 1;
  const forwardDisabled = lastGroup && !currentProgress.isComplete;
  const overallPercent = questions.length ? Math.round((completedQueries / questions.length) * 100) : 0;
  const unsyncedLabel = `${pendingCount} unsynced ${pendingCount === 1 ? "change" : "changes"}`;
  const saveLabel =
    session.mode === "local" || saveStatus === "local"
      ? "Saved on this device"
      : pendingCount === 0
        ? saveStatus === "idle"
          ? "Autosave ready"
          : "All changes saved"
        : saveStatus === "retrying"
          ? `${unsyncedLabel} · retrying`
          : saveStatus === "error"
            ? `${unsyncedLabel} · saved on this device`
            : "Saving…";
  const saveStateClass =
    pendingCount === 0 && saveStatus !== "idle" && saveStatus !== "local" && session.mode !== "local"
      ? "saved"
      : saveStatus;

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">{STUDY_MARK}</span>
          <div><strong>Clinical Query Taxonomy</strong><span>Codebook {CODEBOOK_VERSION}</span></div>
        </div>
        <div className="header-progress" aria-label={`${completedQueries} of ${questions.length} queries complete`}>
          <div className="progress-copy"><span>Assigned progress</span><strong>{completedQueries} / {questions.length}</strong></div>
          <div className="progress-track"><span style={{ width: `${overallPercent}%` }} /></div>
        </div>
        <div className="header-actions">
          <div className={`save-state save-state--${saveStateClass}`} role="status"><span />{saveLabel}</div>
          <button
            ref={shortcutTriggerRef}
            className="button button--secondary button--compact shortcut-trigger"
            aria-keyshortcuts="?"
            onClick={openShortcuts}
          >
            Shortcuts <kbd aria-hidden="true">?</kbd>
          </button>
          <button className="button button--secondary button--compact" aria-keyshortcuts="B" onClick={() => setCodebookOpen(true)}>Open codebook</button>
          <button className="user-chip" onClick={endSession} title="End this browser session"><span>{session.name.slice(0, 1).toUpperCase()}</span><span>{session.name}<small>End session</small></span></button>
        </div>
      </header>

      {dataset.isExample ? <div className="demo-banner"><strong>Example dataset</strong> · Replace it with the approved de-identified study file before data collection.</div> : null}
      {assignmentError ? <div className="sync-banner" role="status">{assignmentError}</div> : null}
      {syncNotice ? <div className="sync-banner sync-banner--warning" role="status">{syncNotice}</div> : null}

      <div className="workspace-body">
        <aside className="query-rail" aria-label="Assigned queries">
          <div className="query-rail__header">
            <div><p className="eyebrow">Work queue</p><h2>Assigned queries</h2></div>
            <span>{questions.length}</span>
          </div>
          <div className="query-list">
            {questions.map((question, index) => {
              const progress = recordProgress(annotations[String(question.id)]);
              const active = index === questionIndex;
              return (
                <button
                  className={`query-list__item ${active ? "query-list__item--active" : ""} ${progress.isComplete ? "query-list__item--complete" : ""}`}
                  key={question.id}
                  onClick={() => selectQuestion(index)}
                  aria-current={active ? "step" : undefined}
                >
                  <span className="query-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="query-list__copy"><strong>{question.id}</strong><small>{question.question}</small></span>
                  <span className="query-state" aria-label={progress.isComplete ? "Complete" : `${progress.completed} of ${progress.total} fields`}>{progress.isComplete ? "✓" : progress.completed}</span>
                </button>
              );
            })}
          </div>
          {completedQueries === questions.length && session.mode !== "local" ? (
            <div className="more-work">
              <strong>Batch complete</strong>
              <span>{remainingQueries ? "More queries are available." : "Required coverage is complete."}</span>
              {remainingQueries ? <button className="button button--secondary button--full" disabled={isClaiming} onClick={claimMore}>{isClaiming ? "Assigning…" : `Add ${ADDITIONAL_ASSIGNMENT_COUNT} more queries`}</button> : null}
            </div>
          ) : null}
        </aside>

        <main className="annotation-main" ref={mainRef}>
          <div className="annotation-content">
            <section className="query-card" aria-labelledby="query-heading">
              <div className="query-card__meta">
                <div><span>Query {questionIndex + 1} of {questions.length}</span><strong id="query-heading">{currentQuestion.id}</strong></div>
                <div className="query-card__badges">
                  <button aria-keyshortcuts="C" onClick={copyQuery}>{copyStatus || "Copy query"}</button>
                </div>
              </div>
              <blockquote>{currentQuestion.question}</blockquote>
              <p className="literal-reminder"><span aria-hidden="true">i</span>Use only the query above. Do not infer unstated facts or intent.</p>
            </section>

            <nav className="group-tabs" aria-label="Annotation sections">
              {TAXONOMY_GROUPS.map((item, index) => {
                const fields = TAXONOMY_FIELDS.filter((field) => field.group === item.id);
                const count = fields.filter((field) => currentRecord.labels[field.key] != null).length;
                const complete = count === fields.length;
                return (
                  <button
                    key={item.id}
                    className={`${activeGroup === item.id ? "group-tab--active" : ""} ${complete ? "group-tab--complete" : ""}`}
                    onClick={() => { setActiveGroup(item.id); setOpenHelp(null); }}
                  >
                    <span>{complete ? "✓" : index + 1}</span>
                    <span><strong>{item.shortLabel}</strong><small>{count}/{fields.length}</small></span>
                  </button>
                );
              })}
            </nav>

            <section className="annotation-section" aria-labelledby="group-heading">
              <div className="section-heading">
                <div><p className="eyebrow">Section {groupIndex + 1} of {TAXONOMY_GROUPS.length}</p><h2 id="group-heading">{group.label}</h2><p>{group.description}</p></div>
                <div className="section-count"><strong>{groupCompleted}</strong><span>of {groupFields.length}<br />answered</span></div>
              </div>

              {group.id === "surface" ? (
                <div className="rule-callout"><strong>Literal text only</strong><span>Absence of a cue means No, even when that cue seems clinically probable.</span></div>
              ) : null}
              {group.id === "classification" ? (
                <div className="rule-callout"><strong>Start with the deliverable</strong><span>What single task, if performed, would satisfy the request?</span></div>
              ) : null}

              <div className="taxonomy-fields">
                {groupFields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={currentRecord.labels[field.key]}
                    labels={currentRecord.labels}
                    onChange={(value) => updateLabel(field.key, value)}
                    helpOpen={openHelp === field.key}
                    onToggleHelp={() => setOpenHelp((current) => current === field.key ? null : field.key)}
                  />
                ))}
              </div>

              {lastGroup ? (
                <div className="notes-block">
                  <div><label htmlFor="annotator-notes">Optional adjudication note</label><span>{currentRecord.notes.length}/4000</span></div>
                  <p>Use only to record genuine ambiguity or a codebook issue. Never add patient identifiers.</p>
                  <textarea
                    id="annotator-notes"
                    maxLength={4000}
                    value={currentRecord.notes}
                    onChange={(event) => updateCurrent((record) => ({ ...record, notes: event.target.value }))}
                    placeholder="Example: Two task categories remained plausible; chose the most literal deliverable because…"
                  />
                </div>
              ) : null}

              {lastGroup && !currentProgress.isComplete ? (
                <div className="completion-warning" role="status">
                  <div>
                    <strong>{currentProgress.total - currentProgress.completed} fields remain.</strong>
                    <span>Finish the unanswered fields before moving to the next query.</span>
                  </div>
                  <button type="button" aria-keyshortcuts="U" onClick={goToFirstUnanswered}>Go to first unanswered</button>
                </div>
              ) : null}

              {lastGroup && currentProgress.isComplete ? (
                <div className="completion-success" role="status"><span>✓</span><div><strong>Annotation complete</strong><p>All {currentProgress.total} required fields are valid and autosaved.</p></div></div>
              ) : null}
            </section>

            <div className="section-navigation">
              <button className="button button--secondary" aria-keyshortcuts="[" onClick={stepBack} disabled={groupIndex === 0 && questionIndex === 0}>← Back</button>
              <div><span>Query completeness</span><strong>{currentProgress.completed} / {currentProgress.total}</strong></div>
              <button className="button button--primary" aria-keyshortcuts="]" onClick={stepForward} disabled={forwardDisabled || (lastGroup && lastQuestion)}>
                {!lastGroup ? "Next section →" : !currentProgress.isComplete ? "Complete required fields" : lastQuestion ? "Final query complete" : "Next query →"}
              </button>
            </div>
          </div>
        </main>
      </div>

      <CodebookDrawer open={codebookOpen} onClose={() => setCodebookOpen(false)} session={session} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
