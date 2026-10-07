// Coordinates autosave requests for many independent records (one per query).
//
// Guarantees, per record key:
//   - edits are debounced, and only the latest snapshot is ever sent;
//   - at most one save request is in flight, so requests can never commit out
//     of order on the server;
//   - a snapshot edited again while its save is in flight is reported as
//     `isLatest: false`, so callers must not mark the record as clean;
//   - retryable failures (network errors, 5xx, 408, 429) are retried with
//     backoff for as long as the record remains unsaved; permanent failures
//     (400, 401, 403) stop and are reported once.
//
// The queue is deliberately independent of React so it can be unit tested.

export const DEFAULT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

export function isRetryableSaveError(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status <= 0) return true; // network failure, timeout
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export function createSaveQueue({
  save,
  onSaved = () => {},
  onError = () => {},
  onSaving = () => {},
  debounceMs = 450,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  isRetryable = isRetryableSaveError,
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
} = {}) {
  if (typeof save !== "function") throw new TypeError("save must be a function.");

  const entries = new Map();

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        version: 0,
        savedVersion: 0,
        snapshot: null,
        timer: null,
        inFlight: false,
        attempts: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function clearTimer(entry) {
    if (entry.timer != null) {
      clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
  }

  function isDirty(entry) {
    return entry.version !== entry.savedVersion;
  }

  function scheduleFlush(key, delay) {
    const entry = entryFor(key);
    clearTimer(entry);
    entry.timer = setTimeoutFn(() => {
      entry.timer = null;
      flush(key);
    }, delay);
  }

  function enqueue(key, snapshot, { immediate = false } = {}) {
    const entry = entryFor(key);
    entry.version += 1;
    entry.snapshot = snapshot;
    entry.attempts = 0;
    if (immediate) flush(key);
    else scheduleFlush(key, debounceMs);
    return entry.version;
  }

  function flush(key) {
    const entry = entries.get(key);
    if (!entry) return;
    clearTimer(entry);
    if (entry.inFlight || !isDirty(entry)) return;

    const version = entry.version;
    const snapshot = entry.snapshot;
    entry.inFlight = true;
    onSaving(key, { snapshot, version });

    Promise.resolve()
      .then(() => save(key, snapshot))
      .then(
        (data) => {
          entry.inFlight = false;
          entry.attempts = 0;
          if (entry.savedVersion < version) entry.savedVersion = version;
          const isLatest = entry.version === version;
          onSaved(key, { data, snapshot, version, isLatest });
          // Edited while the request was in flight: send the newest snapshot
          // as soon as the debounce for that edit has elapsed.
          if (!isLatest && entry.timer == null) flush(key);
        },
        (error) => {
          entry.inFlight = false;
          entry.attempts += 1;
          const retryable = isRetryable(error);
          const stillDirty = entry.version !== entry.savedVersion;
          onError(key, error, { snapshot, version, attempt: entry.attempts, retryable, isLatest: entry.version === version });
          if (!stillDirty) return;
          if (retryable) {
            const delay = retryDelaysMs[Math.min(entry.attempts - 1, retryDelaysMs.length - 1)];
            scheduleFlush(key, delay);
          } else if (entry.timer == null && entry.version !== version) {
            // A newer edit arrived during the failed request; try that one.
            flush(key);
          }
        },
      );
  }

  function flushAll() {
    for (const [key, entry] of entries) {
      if (!isDirty(entry) || entry.inFlight) continue;
      entry.attempts = 0;
      flush(key);
    }
  }

  function cancel(key) {
    const entry = entries.get(key);
    if (!entry) return;
    clearTimer(entry);
    entries.delete(key);
  }

  function pendingKeys() {
    return [...entries.entries()].filter(([, entry]) => isDirty(entry)).map(([key]) => key);
  }

  function inFlightCount() {
    let count = 0;
    for (const entry of entries.values()) if (entry.inFlight) count += 1;
    return count;
  }

  function dispose() {
    for (const entry of entries.values()) clearTimer(entry);
    entries.clear();
  }

  return { enqueue, flush, flushAll, cancel, pendingKeys, inFlightCount, dispose };
}
