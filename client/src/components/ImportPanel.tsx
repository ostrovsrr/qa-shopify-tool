import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  checkShopifyHealth,
  cleanupImportRun,
  cleanupQaCustomers,
  fetchImportFeedback,
  fetchLatestImportForValidation,
  fetchShopifyStores,
  fetchStoreCustomerStats,
  getImportReportDownloadUrl,
  runBatchImport,
  runImport,
} from '../api/validationApi';
import {
  ImportFeedback,
  ShopifyHealth,
  ShopifyStore,
  StoreCustomerStats,
  ValidationResult,
} from '../types';

interface Props {
  result: ValidationResult;
}

// Shopify bulk-op statuses that mean the import has stopped advancing.
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];
const isTerminal = (status: string): boolean => TERMINAL_STATUSES.includes(status);

const POLL_INTERVAL_MS = 3000;

function errMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; hint?: string } | undefined;
    if (data?.error) return data.hint ? `${data.error} — ${data.hint}` : data.error;
  }
  return err instanceof Error ? err.message : fallback;
}

// Contiguous balanced split — mirrors the server's splitIntoBatches sizing so the
// previewed batch sizes match what each store actually receives.
function batchSizeFor(index: number, total: number, n: number): number {
  if (n <= 0) return 0;
  const base = Math.floor(total / n);
  const remainder = total % n;
  return base + (index < remainder ? 1 : 0);
}

// RuleGapList renders the per-run rule-gap backlog. Hidden from the UI for now
// (see the commented section in the results panel); restore the `RuleGap` import
// and the JSX below if we bring the backlog table back.
//
// function RuleGapList({ gaps }: { gaps: RuleGap[] }) { ... }

export function ImportPanel({ result }: Props) {
  const [stores, setStores] = useState<ShopifyStore[]>([]);
  // Two explicit flows. Parallel has a lock-in step: 'select' (pick stores) →
  // 'review' (locked, shows the per-store batch plan) → import.
  const [importMode, setImportMode] = useState<'single' | 'parallel'>('single');
  const [parallelPhase, setParallelPhase] = useState<'select' | 'review'>('select');
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  // Per-store health/stats (one entry per displayed store) and independent
  // per-store cleanup spinners.
  const [storeHealth, setStoreHealth] = useState<Record<string, ShopifyHealth>>({});
  const [storeStats, setStoreStats] = useState<Record<string, StoreCustomerStats>>({});
  const [cleaningStores, setCleaningStores] = useState<Set<string>>(new Set());
  const [cleaningRun, setCleaningRun] = useState(false);
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const primaryStoreId = selectedStoreIds[0];
  const inParallelSelect = importMode === 'parallel' && parallelPhase === 'select';
  const inParallelReview = importMode === 'parallel' && parallelPhase === 'review';

  // Stores whose cards we render: the one selected store in single mode, or every
  // selected store once the parallel selection is locked into review.
  const displayedStoreIds =
    importMode === 'single'
      ? primaryStoreId
        ? [primaryStoreId]
        : []
      : inParallelReview
        ? selectedStoreIds
        : [];
  // Avoid stale closures / interval churn when refreshing stats on terminal poll.
  const displayedRef = useRef<string[]>(displayedStoreIds);
  displayedRef.current = displayedStoreIds;

  const storeLabel = (storeId: string): string =>
    stores.find((s) => s.id === storeId)?.label ?? storeId;

  // ── load stores ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    fetchShopifyStores()
      .then((data) => {
        if (!active) return;
        setStores(data);
        setSelectedStoreIds((current) =>
          current.length > 0 ? current : data[0] ? [data[0].id] : [],
        );
      })
      .catch(() => active && setError('Could not load Shopify test stores.'));
    return () => {
      active = false;
    };
  }, []);

  // ── health + stats for EVERY store, as soon as we know the stores ────────────
  //
  // This used to fetch only for the SELECTED store, which meant the store picker
  // told you nothing: to find out whether a store was clean you had to select it,
  // wait, and then select the next one. You were choosing blind.
  //
  // It was that way for a reason — counting qa customers took 68 SECONDS per store
  // (Shopify's customersCount ignores tag:, so the server had to page 110k customers
  // 250 at a time). Doing that for five stores was unthinkable.
  //
  // The count is capped server-side now, so it is ~2s per store and they run in
  // parallel. Fetching all of them up front is what makes the picker useful.
  useEffect(() => {
    if (stores.length === 0) return;
    let active = true;
    for (const store of stores) {
      const id = store.id;
      checkShopifyHealth(id)
        .then((h) => active && setStoreHealth((m) => ({ ...m, [id]: h })))
        .catch(
          () =>
            active &&
            setStoreHealth((m) => ({
              ...m,
              [id]: { ok: false, error: 'Could not reach the server.' },
            })),
        );
      fetchStoreCustomerStats(id)
        .then((st) => active && setStoreStats((m) => ({ ...m, [id]: st })))
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores]);

  // ── restore the latest import when (re)opening a validation run ───────────────
  useEffect(() => {
    let active = true;
    setFeedback(null);
    setError('');
    fetchLatestImportForValidation(result.validationId)
      .then((f) => active && f && setFeedback(f))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [result.validationId]);

  // ── reconcile-on-poll while non-terminal ──────────────────────────────────────
  const pollStatus = feedback?.status;
  const pollRunId = feedback?.importRunId;
  useEffect(() => {
    if (!pollRunId || !pollStatus || isTerminal(pollStatus)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchImportFeedback(pollRunId);
        if (!active) return;
        setFeedback(next);
        if (isTerminal(next.status)) {
          for (const id of displayedRef.current) {
            fetchStoreCustomerStats(id)
              .then((st) => active && setStoreStats((m) => ({ ...m, [id]: st })))
              .catch(() => undefined);
          }
        } else {
          // Schedule only after this request finishes. setInterval could overlap
          // slow Shopify reconciliations and advance the same run concurrently.
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!active) return;
        setError(errMessage(err, 'Failed to check import status.'));
      }
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollRunId, pollStatus]);

  // ── point selection at a single-store run reopened from History ───────────────
  const feedbackStoreId = feedback?.storeId ?? null;
  const feedbackShopDomain = feedback?.shopDomain;
  useEffect(() => {
    if (!feedbackStoreId && !feedbackShopDomain) return;
    const target =
      feedbackStoreId ?? stores.find((s) => s.shop === feedbackShopDomain)?.id;
    if (target) {
      setSelectedStoreIds([target]);
      setImportMode('single');
      setParallelPhase('select');
    }
  }, [feedbackStoreId, feedbackShopDomain, stores]);

  // ── derived flags ─────────────────────────────────────────────────────────────
  const s = feedback?.summary;
  const polling = !!feedback && !isTerminal(feedback.status);
  const completed = feedback?.status === 'COMPLETED';
  const failed = !!feedback && isTerminal(feedback.status) && !completed;
  const busy = running || polling;
  const showResults = !!feedback && isTerminal(feedback.status) && feedback.totalRows > 0;

  const primaryHealthOk = primaryStoreId ? storeHealth[primaryStoreId]?.ok !== false : false;
  const canImportNow = inParallelReview
    ? selectedStoreIds.length >= 2
    : importMode === 'single' && selectedStoreIds.length === 1 && primaryHealthOk;

  // ── actions ───────────────────────────────────────────────────────────────────
  const switchMode = (mode: 'single' | 'parallel') => {
    setImportMode(mode);
    setParallelPhase('select');
    setError('');
    if (mode === 'single') setSelectedStoreIds((prev) => prev.slice(0, 1));
  };

  const toggleStore = (storeId: string) => {
    setSelectedStoreIds((prev) => {
      if (importMode === 'single') return [storeId];
      return prev.includes(storeId)
        ? prev.filter((id) => id !== storeId)
        : [...prev, storeId];
    });
    setFeedback(null);
    setError('');
  };

  const confirmSelection = () => {
    if (selectedStoreIds.length < 2) return;
    setParallelPhase('review');
    setError('');
  };

  const editSelection = () => {
    setParallelPhase('select');
    setError('');
  };

  const handleRun = async () => {
    if (!canImportNow) return;
    setRunning(true);
    setError('');
    setNotice('');
    try {
      // Returns immediately with status RUNNING; the poll effect drives it to a
      // terminal state. 2+ stores → rows split and imported in parallel, merged.
      const data =
        importMode === 'parallel'
          ? await runBatchImport(result.validationId, selectedStoreIds)
          : await runImport(result.validationId, selectedStoreIds[0]);
      setFeedback(data);
    } catch (err) {
      setError(errMessage(err, 'Import failed.'));
    } finally {
      setRunning(false);
    }
  };

  const handleDownloadReport = () => {
    if (!feedback) return;
    window.open(getImportReportDownloadUrl(feedback.importRunId), '_blank');
  };

  // Validator-feedback exports are hidden from the UI for now. Restore these
  // (and the toolbar buttons) along with the getValidatorFeedbackReportUrl /
  // fetchValidatorFeedbackMarkdown imports to bring them back.
  //
  // const handleDownloadFeedbackReport = () => {
  //   if (!feedback) return;
  //   window.open(getValidatorFeedbackReportUrl(feedback.importRunId), '_blank');
  // };
  //
  // const handleCopyForClaude = async () => {
  //   if (!feedback) return;
  //   setError('');
  //   setNotice('');
  //   try {
  //     const markdown = await fetchValidatorFeedbackMarkdown(feedback.importRunId);
  //     await navigator.clipboard.writeText(markdown);
  //     setNotice('Copied — paste into Claude to fix the validators.');
  //   } catch (err) {
  //     setError(errMessage(err, 'Could not copy the validator report.'));
  //   }
  // };

  const refreshStoreStats = async (storeId: string) => {
    const st = await fetchStoreCustomerStats(storeId).catch(() => null);
    if (st) setStoreStats((m) => ({ ...m, [storeId]: st }));
  };

  const cleanStore = async (storeId: string) => {
    // The count may still be loading, and that is fine — the cleanup re-reads the
    // store to find what to delete. Say "all" rather than block on a number.
    const st = storeStats[storeId];
    const howMany = st
      ? `${st.qaImportCustomers.toLocaleString()}${st.qaImportCapped ? '+' : ''} customer(s)`
      : 'every customer';
    if (
      !window.confirm(
        `Delete ${howMany} tagged qa-import from ${storeLabel(storeId)}?\n\n` +
          'This deletes by tag across the whole store and cannot be undone.',
      )
    ) {
      return;
    }
    setCleaningStores((prev) => new Set(prev).add(storeId));
    setError('');
    setNotice('');
    try {
      const res = await cleanupQaCustomers(storeId);
      setNotice(`Cleaned ${res.deleted} of ${res.found} qa-import customer(s) from ${res.shop}.`);
      await refreshStoreStats(storeId);
    } catch (err) {
      setError(errMessage(err, 'Cleanup failed.'));
    } finally {
      setCleaningStores((prev) => {
        const next = new Set(prev);
        next.delete(storeId);
        return next;
      });
    }
  };

  const cleanAllSelected = async () => {
    const ids = [...displayedStoreIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete all qa-import customers from ${ids.length} store(s)?`)) return;
    setError('');
    setNotice('');
    let totalDeleted = 0;
    for (const id of ids) {
      setCleaningStores((prev) => new Set(prev).add(id));
      try {
        const res = await cleanupQaCustomers(id);
        totalDeleted += res.deleted;
        await refreshStoreStats(id);
      } catch (err) {
        setError(errMessage(err, `Cleanup failed for ${storeLabel(id)}.`));
      } finally {
        setCleaningStores((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
    setNotice(`Cleaned ${totalDeleted} qa-import customer(s) across ${ids.length} store(s).`);
  };

  const handleCleanupImportRun = async () => {
    if (!feedback) return;
    if (
      !window.confirm(
        `Delete customers created by import ${feedback.importRunId.slice(0, 8)} (across all its stores)?`,
      )
    ) {
      return;
    }
    setCleaningRun(true);
    setError('');
    setNotice('');
    try {
      const res = await cleanupImportRun(feedback.importRunId, primaryStoreId);
      setNotice(`Deleted ${res.deleted} of ${res.found} customer(s) for this import (${res.shop}).`);
      await Promise.all(displayedStoreIds.map((id) => refreshStoreStats(id)));
    } catch (err) {
      setError(errMessage(err, 'Cleanup failed.'));
    } finally {
      setCleaningRun(false);
    }
  };

  // ── per-store card ─────────────────────────────────────────────────────────────
  const renderStoreCard = (storeId: string, index: number) => {
    const store = stores.find((s2) => s2.id === storeId);
    const h = storeHealth[storeId];
    const st = storeStats[storeId];
    const cleaning = cleaningStores.has(storeId);
    const batch = inParallelReview
      ? batchSizeFor(index, result.totalRows, selectedStoreIds.length)
      : null;
    const pct =
      batch !== null && result.totalRows > 0
        ? Math.round((batch / result.totalRows) * 100)
        : null;

    return (
      <div className="store-card" key={storeId}>
        <div className="store-card-head">
          <div>
            <div className="store-card-name">{store?.label ?? storeId}</div>
            <div className="store-card-shop">{store?.shop ?? ''}</div>
          </div>
          <span
            className={`store-card-badge ${h ? (h.ok ? 'ok' : 'bad') : 'pending'}`}
          >
            {h ? (h.ok ? 'connected' : 'not ready') : 'checking…'}
          </span>
        </div>

        {h && !h.ok && (
          <div className="store-card-error">
            {h.error ?? 'unknown'}
            {h.hint ? ` — ${h.hint}` : ''}
            {h.missingScopes && h.missingScopes.length > 0
              ? ` (missing scopes: ${h.missingScopes.join(', ')})`
              : ''}
          </div>
        )}

        <div className="store-card-stats">
          {batch !== null && (
            <span>
              Batch:{' '}
              <strong>
                {batch} row{batch === 1 ? '' : 's'}
              </strong>
              {pct !== null ? ` (${pct}%)` : ''}
              {batch === 0 ? ' — skipped' : ''}
            </span>
          )}
          {/* Counting the QA customers means paging Shopify (see the server —
              customersCount ignores tag:), so it takes a moment. SAY that, instead
              of showing a bare "—" that looks like the store is empty or broken. */}
          <span>
            Total customers:{' '}
            <strong>{st ? st.totalCustomers.toLocaleString() : 'counting…'}</strong>
          </span>
          <span>
            QA imports:{' '}
            <strong>
              {st
                ? `${st.qaImportCustomers.toLocaleString()}${st.qaImportCapped ? '+' : ''}`
                : 'counting…'}
            </strong>
          </span>
        </div>

        {/* Not disabled while the count is still loading. The cleanup re-reads the
            store itself, so it never needed the count to be on screen first — and
            gating it meant the button sat dead for a minute on a big store. */}
        <button
          className="btn btn-outline btn-sm"
          onClick={() => cleanStore(storeId)}
          disabled={cleaning || (st != null && st.qaImportCustomers === 0)}
        >
          {cleaning ? 'Cleaning…' : 'Clean QA'}
        </button>
      </div>
    );
  };

  return (
    <div className="import-panel">
      <div className="import-header">
        <div>
          <h2 className="summary-title">Test-store import</h2>
          <p className="muted">
            Imports these rows into the Shopify test store and diffs Shopify&apos;s per-row
            result against our validator to surface missing / over-strict rules.
          </p>
        </div>
        {inParallelSelect ? (
          <button
            className="btn btn-primary"
            onClick={confirmSelection}
            disabled={busy || selectedStoreIds.length < 2}
          >
            Confirm selection{selectedStoreIds.length >= 2 ? ` (${selectedStoreIds.length})` : ''}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleRun} disabled={busy || !canImportNow}>
            {busy
              ? 'Importing… (running in Shopify)'
              : importMode === 'parallel'
                ? `Import to ${selectedStoreIds.length} stores in parallel`
                : 'Import to test store'}
          </button>
        )}
      </div>

      {stores.length > 0 && (
        <>
          {stores.length > 1 && (
            <div className="import-mode-toggle" role="tablist" aria-label="Import mode">
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'single'}
                className={`mode-tab ${importMode === 'single' ? 'active' : ''}`}
                onClick={() => switchMode('single')}
                disabled={busy}
              >
                Single store import
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'parallel'}
                className={`mode-tab ${importMode === 'parallel' ? 'active' : ''}`}
                onClick={() => switchMode('parallel')}
                disabled={busy}
              >
                Parallel import
              </button>
            </div>
          )}

          {/* Store picker — hidden once a parallel selection is locked for review. */}
          {!inParallelReview && (
            <>
              <p className="muted store-selector-hint">
                {importMode === 'parallel'
                  ? 'Select two or more stores, then confirm to see how the file splits across them.'
                  : 'Select the test store to import into.'}
              </p>
              <div className="store-selector">
                {stores.map((store) => (
                  <button
                    key={store.id}
                    className={`store-chip ${selectedStoreIds.includes(store.id) ? 'active' : ''}`}
                    onClick={() => toggleStore(store.id)}
                    disabled={busy}
                    type="button"
                  >
                    <span>{store.label}</span>
                    <small>{store.shop}</small>
                    {/* The whole point of the picker: see which store is dirty
                        BEFORE you commit an import to it. */}
                    <small className="store-chip-stats">
                      {storeStats[store.id]
                        ? `${storeStats[store.id].totalCustomers.toLocaleString()} customers · ` +
                          `${storeStats[store.id].qaImportCustomers.toLocaleString()}` +
                          `${storeStats[store.id].qaImportCapped ? '+' : ''} QA`
                        : storeHealth[store.id]?.ok === false
                          ? 'unreachable'
                          : 'counting…'}
                    </small>
                  </button>
                ))}
              </div>
              {inParallelSelect && selectedStoreIds.length < 2 && (
                <p className="muted">Select at least 2 stores to import in parallel.</p>
              )}
            </>
          )}

          {/* Review bar for a locked parallel selection. */}
          {inParallelReview && (
            <div className="review-bar">
              <span className="muted">
                Parallel import · <strong>{selectedStoreIds.length}</strong> stores ·{' '}
                {result.totalRows} rows total
              </span>
              <div className="toolbar-actions">
                <button className="btn btn-outline btn-sm" onClick={editSelection} disabled={busy}>
                  Edit selection
                </button>
                {displayedStoreIds.length > 1 && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={cleanAllSelected}
                    disabled={cleaningStores.size > 0}
                  >
                    Clean QA on all selected
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Per-store cards (single: one card; parallel review: one per store). */}
          {displayedStoreIds.length > 0 && (
            <div className="store-cards">
              {displayedStoreIds.map((id, i) => renderStoreCard(id, i))}
            </div>
          )}
        </>
      )}

      {result.errors > 0 && !feedback && (
        <div className="warning-banner">
          ⚠ This run has {result.errors} error(s). Importing anyway will test whether
          Shopify actually rejects them (catches over-strict rules).
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {/* Transient status (cleanup results etc.) — kept lighter than the success
          headline so it doesn't compete with the run's hero number. Dismissible. */}
      {notice && (
        <div className="inline-notice">
          <span>{notice}</span>
          <button
            className="inline-notice-close"
            onClick={() => setNotice('')}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {failed && (
        <div className="error-banner">
          Import {feedback.importRunId.slice(0, 8)} {feedback.status.toLowerCase()}
          {feedback.error ? `: ${feedback.error}` : '.'}
        </div>
      )}

      {polling && (
        <div className="import-results">
          <div className="import-toolbar">
            <span className="muted">
              <span className="spinner" /> Import {feedback.importRunId.slice(0, 8)} ·
              running in Shopify… polling for results
            </span>
            {/* No Refresh button. Polling is already re-fetching this exact
                feedback (see the polling effect), so the button did nothing the app
                was not doing anyway — it just implied the user had to act. */}
          </div>
        </div>
      )}

      {showResults && s && (
        <div className="import-results">
          <div className="import-toolbar">
            <span className="muted">
              Import {feedback.importRunId.slice(0, 8)} · {feedback.status} ·{' '}
              {feedback.successCount} accepted / {feedback.errorCount} rejected of{' '}
              {feedback.totalRows}
            </span>
            <div className="toolbar-actions">
              {/* Validator-feedback exports hidden for now — restore the buttons
                  plus handleCopyForClaude/handleDownloadFeedbackReport if needed.
              <button className="btn btn-primary btn-sm" onClick={handleCopyForClaude}>
                Copy for Claude
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleDownloadFeedbackReport}>
                Download .md
              </button>
              */}
              <button className="btn btn-outline" onClick={handleDownloadReport}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download verification report
              </button>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleCleanupImportRun}
                disabled={cleaningRun}
              >
                {cleaningRun ? 'Cleaning...' : 'Clean this import'}
              </button>
              {/* Refresh removed here: the run is already terminal in this view,
                  so re-fetching can't change the result. */}
            </div>
          </div>

          {/* Prominent outcome headline — the number that matters most. */}
          <div
            className={`import-headline ${
              feedback.errorCount > 0 ? 'import-headline-rejects' : 'import-headline-clean'
            }`}
          >
            <span className="import-headline-icon" aria-hidden="true">
              {feedback.errorCount > 0 ? '⚠' : '✓'}
            </span>
            <div className="import-headline-counts">
              <span className="import-headline-numbers">
                <strong className="import-num-accepted">{feedback.successCount}</strong> accepted
                {' · '}
                <strong className="import-num-rejected">{feedback.errorCount}</strong> rejected
              </span>
              <span className="import-headline-sub">
                of {feedback.totalRows} row(s) imported to {feedback.shopDomain}
              </span>
            </div>
          </div>

          {/* Buckets are gray at 0 (color only when > 0) so a clean run doesn't
              read as alarming, and grouped so the meaning is obvious. */}
          <h3 className="subsection-title">Rejections</h3>
          <div className="cards-grid">
            <div className={`card ${s.missingRule.count > 0 ? 'card-error' : 'card-zero'}`}>
              <span className="card-label">Missing rule (rejected, not flagged)</span>
              <span className="card-value">{s.missingRule.count}</span>
            </div>
            <div className={`card ${s.confirmedReject.count > 0 ? 'card-neutral' : 'card-zero'}`}>
              <span className="card-label">Confirmed reject (rejected &amp; flagged)</span>
              <span className="card-value">{s.confirmedReject.count}</span>
            </div>
          </div>

          <h3 className="subsection-title">Validator accuracy</h3>
          <div className="cards-grid">
            <div className={`card ${s.falsePositive.count > 0 ? 'card-warning' : 'card-zero'}`}>
              <span className="card-label">False positive (flagged, accepted)</span>
              <span className="card-value">{s.falsePositive.count}</span>
            </div>
            <div className={`card ${s.confirmedClean.count > 0 ? 'card-info' : 'card-zero'}`}>
              <span className="card-label">Confirmed clean (accepted, not flagged)</span>
              <span className="card-value">{s.confirmedClean.count}</span>
            </div>
          </div>

          {/* Detail path for the false-positive (over-strict) count, so the
              number isn't a dead end. Collapsed by default. */}
          {s.falsePositive.count > 0 && (
            <details className="bucket-details">
              <summary>
                Show {s.falsePositive.count} over-strict row(s) — we flagged, Shopify
                accepted
              </summary>
              <table className="issues-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Field</th>
                    <th>Our flag</th>
                  </tr>
                </thead>
                <tbody>
                  {s.falsePositive.rows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.shopifyField ?? '—'}</td>
                      <td className="cell-message">{r.message ?? 'flagged by validator'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.falsePositive.count > s.falsePositive.rows.length && (
                <p className="muted">
                  Showing first {s.falsePositive.rows.length} of {s.falsePositive.count}.
                </p>
              )}
            </details>
          )}

          {feedback.perStore.length > 1 && (
            <>
              <h3 className="subsection-title">Per-store results</h3>
              <table className="issues-table">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Rows</th>
                    <th>Accepted</th>
                    <th>Rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {feedback.perStore.map((ps) => (
                    <tr key={ps.storeId ?? ps.shopDomain}>
                      <td>
                        {stores.find((st) => st.shop === ps.shopDomain)?.label ?? ps.shopDomain}
                      </td>
                      <td>{ps.total}</td>
                      <td>{ps.accepted}</td>
                      <td>{ps.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* What Shopify rejected, and why — the detail that matters most. */}
          {feedback.rejectedRows.length > 0 ? (
            <>
              <h3 className="subsection-title">
                Rejected by Shopify — {feedback.errorCount} row(s)
              </h3>
              <table className="issues-table rejected-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Field</th>
                    <th>Code</th>
                    <th>Why Shopify rejected it</th>
                    <th>Caught by our rules?</th>
                  </tr>
                </thead>
                <tbody>
                  {feedback.rejectedRows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.shopifyField ?? '—'}</td>
                      <td>
                        {r.shopifyCode ? (
                          <span className="reject-code">{r.shopifyCode}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="cell-message">{r.message ?? 'Rejected by Shopify.'}</td>
                      <td>
                        {r.flaggedByValidator ? (
                          <span className="reject-flagged-yes">✓ flagged</span>
                        ) : (
                          <span className="reject-flagged-no">✗ rule gap</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {feedback.errorCount > feedback.rejectedRows.length && (
                <p className="muted">
                  Showing first {feedback.rejectedRows.length} of {feedback.errorCount} rejections.
                </p>
              )}
            </>
          ) : (
            <p className="muted import-no-rejects">
              ✓ No rejections — Shopify accepted every imported row.
            </p>
          )}

          {/* Rule-gap backlog hidden for now — restore the RuleGap import and the
              RuleGapList helper to bring it back.
          <h3 className="subsection-title">Rule-gap backlog (this run)</h3>
          <RuleGapList gaps={feedback.ruleGaps} />
          */}
        </div>
      )}
    </div>
  );
}
