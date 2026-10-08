import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  checkShopifyHealth,
  cleanupImportRun,
  cleanupQaCustomers,
  fetchImportFeedback,
  fetchLatestImportForValidation,
  fetchBusyStores,
  fetchShopifyStores,
  fetchStoreCustomerStats,
  getImportReportDownloadUrl,
  runBatchImport,
  runImport,
} from '../api/validationApi';
import { describeCleanup } from '../api/cleanupPoller';
import { isTerminal, useImportRunPoll } from '../hooks/useImportRunPoll';
import {
  CleanupStoreOutcome,
  ImportFeedback,
  ShopifyHealth,
  ShopifyStore,
  StoreCustomerStats,
  ValidationResult,
} from '../types';
import { resolveRunStoreIds } from '../utils/runStores';
import { rowsSent } from '../utils/rowsSent';
import { shopifyAdminUrl } from '../utils/shopifyAdmin';

interface Props {
  result: ValidationResult;
}

// How long Shopify's tag-filtered counts take to catch up with a create or delete
// (seen: several seconds). One re-read after this settles the store card.
const STATS_SETTLE_MS = 6000;
// How often the picker re-asks which stores are busy.
const BUSY_POLL_MS = 15000;

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
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // storeId → what holds it ("a product import"). Shown on the picker so nobody
  // picks a busy store and only finds out from the 409. (TODOS §1 follow-up)
  const [storesInUse, setStoresInUse] = useState<Record<string, string>>({});

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
  // The run on screen right now, for discarding answers that arrive after the
  // user opened a different one (this component is reused across runs).
  const validationIdRef = useRef(result.validationId);
  validationIdRef.current = result.validationId;

  const storeLabel = (storeId: string): string =>
    stores.find((s) => s.id === storeId)?.label ?? storeId;
  // A cleanup outcome's display name: the store's label where we know it.
  const storeLabelFor = (storeId: string | null, shop: string): string =>
    stores.find((s) => (storeId ? s.id === storeId : s.shop === shop))?.label ?? shop;

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
      // The server's own reason + hint (e.g. "no stores configured — set
      // SHOPIFY_TEST_STORES …"), not a generic line with no way forward.
      .catch((err) => active && setError(errMessage(err, 'Could not load Shopify test stores.')));
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

  // ── which stores are busy (any flow, any colleague) ──────────────────────────
  // Polled while the panel is open: a lock appears and clears on someone else's
  // schedule, not on anything this page does.
  useEffect(() => {
    let active = true;
    const load = () =>
      fetchBusyStores()
        .then(
          (busy) =>
            active && setStoresInUse(Object.fromEntries(busy.map((b) => [b.storeId, b.operation]))),
        )
        // Decoration only: a server that is down must not raise an unhandled
        // rejection every BUSY_POLL_MS. Keep the last known state.
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), BUSY_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  // ── restore the latest import when (re)opening a validation run ───────────────
  useEffect(() => {
    let active = true;
    setFeedback(null);
    setError('');
    setRestoring(true);
    fetchLatestImportForValidation(result.validationId)
      .then((f) => active && f && setFeedback(f))
      .catch(() => undefined)
      .finally(() => active && setRestoring(false));
    return () => {
      active = false;
    };
  }, [result.validationId]);

  // ── reconcile-on-poll while non-terminal ──────────────────────────────────────
  // A failed poll is retried with backoff (see useImportRunPoll) — it used to end
  // polling for good and strand the panel on "Importing…" until a reload.
  const pollError = useImportRunPoll({
    runId: feedback?.importRunId,
    status: feedback?.status,
    fetchFeedback: fetchImportFeedback,
    onUpdate: setFeedback,
    // Deliberately not gated on the poll still being active: the update above
    // flips the status to terminal, React tears the poll down, and a gated
    // refresh was silently dropped — the card kept the pre-import counts.
    onTerminal: () => {
      for (const id of displayedRef.current) void refreshStoreStats(id);
    },
    describeError: (err) => errMessage(err, 'no response'),
  });

  // ── point selection at the run reopened from History ──────────────────────────
  // See resolveRunStoreIds: a RUNNING parallel run has no perStore yet, so its
  // stores come from the batch jobs. Keyed on the resolved ids so the per-poll
  // feedback refresh does not re-fire this.
  const runStoreKey = resolveRunStoreIds(feedback, stores).join(',');
  useEffect(() => {
    if (!runStoreKey) return;
    const ids = runStoreKey.split(',');
    if (ids.length > 1) {
      setSelectedStoreIds(ids);
      setImportMode('parallel');
      setParallelPhase('review');
    } else {
      setSelectedStoreIds(ids);
      setImportMode('single');
      setParallelPhase('select');
    }
  }, [runStoreKey]);

  // ── derived flags ─────────────────────────────────────────────────────────────
  const polling = !!feedback && !isTerminal(feedback.status);
  const completed = feedback?.status === 'COMPLETED';
  const failed = !!feedback && isTerminal(feedback.status) && !completed;
  const busy = running || polling;
  const showResults = !!feedback && isTerminal(feedback.status) && feedback.totalRows > 0;
  // What the import actually sends (and splits across stores): the template
  // dataset after merges and blank-line removal, not the raw file's row count.
  const sendRows = rowsSent(result);

  // Only a store whose health check said ok. A health answer still pending, or
  // one without `ok` (a 500, a proxy's HTML 502), is not "ready".
  const primaryHealthOk = primaryStoreId ? storeHealth[primaryStoreId]?.ok === true : false;
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
    const startedFor = result.validationId;
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
      // This panel is not keyed by run: if another run was opened while the
      // POST was in flight, this answer belongs to a run no longer on screen.
      if (data.validationId !== validationIdRef.current) return;
      setFeedback(data);
    } catch (err) {
      if (startedFor !== validationIdRef.current) return;
      setError(errMessage(err, 'Import failed.'));
    } finally {
      setRunning(false);
    }
  };

  const handleDownloadReport = () => {
    if (!feedback) return;
    window.open(getImportReportDownloadUrl(feedback.importRunId), '_blank');
  };

  // Every caller runs right after an import or a cleanup changed the store, and
  // Shopify's counts lag its own writes by a few seconds — the card could read
  // "Total: 0 · QA imports: 5". Read now, then once more after the lag. (TODOS §4c)
  const refreshStoreStats = async (storeId: string) => {
    const read = async () => {
      const st = await fetchStoreCustomerStats(storeId).catch(() => null);
      if (st) setStoreStats((m) => ({ ...m, [storeId]: st }));
    };
    await read();
    window.setTimeout(() => void read(), STATS_SETTLE_MS);
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
      // Per-store wording: "still deleting in the background" when the client
      // stopped watching before the server finished, never "failed".
      const { notice: n, error: e } = describeCleanup(res.stores, 'customer', storeLabelFor);
      setNotice(n);
      setError(e);
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
    // Every store at once, like the product twin: each is a separate shop with
    // its own lock, so there is no reason to clean them one after another.
    setCleaningStores((prev) => new Set([...prev, ...ids]));
    const outcomes = await Promise.all(
      ids.map(async (id): Promise<CleanupStoreOutcome[]> => {
        try {
          const res = await cleanupQaCustomers(id);
          await refreshStoreStats(id);
          return res.stores;
        } catch (err) {
          // Busy store (409), all-failed run, unreachable server: this store's
          // own failure, reported next to the stores that did get cleaned.
          return [
            {
              storeId: id,
              shop: storeLabel(id),
              status: 'failed',
              found: 0,
              deleted: 0,
              error: errMessage(err, 'cleanup failed.'),
            },
          ];
        } finally {
          setCleaningStores((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }),
    );
    const { notice: n, error: e } = describeCleanup(outcomes.flat(), 'customer', storeLabelFor);
    setNotice(n);
    setError(e);
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
      // One run per store the import touched: say which were cleaned, which are
      // still deleting, and which failed (with the server's reason).
      const { notice: n, error: e } = describeCleanup(res.stores, 'customer', storeLabelFor);
      setNotice(n);
      setError(e);
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
    const adminUrl = shopifyAdminUrl(store?.shop, 'customers');
    // The server splits the rows it SENDS (merged duplicates and blank lines
    // already gone), so the plan must split the same number.
    const batch = inParallelReview
      ? batchSizeFor(index, sendRows, selectedStoreIds.length)
      : null;
    const pct =
      batch !== null && sendRows > 0 ? Math.round((batch / sendRows) * 100) : null;

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
        <div className="store-card-actions">
          {adminUrl && (
            <a
              className="btn btn-outline btn-sm"
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open customers ↗
            </a>
          )}
          {/* Not disabled on a zero count. Shopify's tag-filtered count lags a
              few seconds behind creation, so right after an import — exactly when
              you want to clean up — the count still reads 0 and the button was
              dead for the rest of the session. cleanStore re-reads the store to
              find what to delete and is confirm-gated, so a no-op click is cheap;
              a stranded user is not. It IS disabled while an import is running:
              it deletes by tag across the whole store, including what the
              running import is creating right now. */}
          <button
            className="btn btn-outline btn-sm"
            onClick={() => cleanStore(storeId)}
            disabled={cleaning || busy}
          >
            {cleaning ? 'Cleaning…' : 'Clean QA'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="import-panel">
      <div className="import-header">
        <div>
          <h2 className="summary-title">Test-store import</h2>
          <p className="muted">
            Imports these rows into a Shopify test store and reports, row by row, what
            Shopify accepted and what it rejected (with Shopify&apos;s own reason).
          </p>
        </div>
        {inParallelSelect ? (
          <button
            className="btn btn-primary"
            onClick={confirmSelection}
            disabled={busy || restoring || selectedStoreIds.length < 2}
          >
            Confirm selection{selectedStoreIds.length >= 2 ? ` (${selectedStoreIds.length})` : ''}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleRun}
            disabled={busy || restoring || !canImportNow}
          >
            {busy
              ? 'Importing… (running in Shopify)'
              : importMode === 'parallel'
                ? `Import to ${selectedStoreIds.length} stores in parallel`
                : 'Import to test store'}
          </button>
        )}
      </div>

      {/* Until the "has this already been imported?" probe answers, we do not
          know which store this run belongs to — and selectedStoreIds is still
          sitting on the DEFAULT store. Rendering the cards during that window
          put a live Clean QA in front of a store the run may never have
          touched. Hold the picker until we know. */}
      {restoring && <p className="muted">Checking for an earlier import of this file&hellip;</p>}

      {!restoring && stores.length > 0 && (
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
                    {storesInUse[store.id] && (
                      <small className="store-chip-busy">In use: {storesInUse[store.id]}</small>
                    )}
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
                {sendRows} rows to send
              </span>
              <div className="toolbar-actions">
                <button className="btn btn-outline btn-sm" onClick={editSelection} disabled={busy}>
                  Edit selection
                </button>
                {displayedStoreIds.length > 1 && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={cleanAllSelected}
                    disabled={cleaningStores.size > 0 || busy}
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
          ⚠ This run has {result.errors} error(s). You can import anyway to see what
          Shopify does with those rows.
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {/* Kept apart from `error`: it clears itself on the next good poll. */}
      {polling && pollError && <div className="warning-banner">{pollError}</div>}
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

      {showResults && (
        <div className="import-results">
          <div className="import-toolbar">
            <span className="muted">
              Import {feedback.importRunId.slice(0, 8)} · {feedback.status} ·{' '}
              {feedback.successCount} accepted / {feedback.errorCount} rejected of{' '}
              {feedback.totalRows}
            </span>
            <div className="toolbar-actions">
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

          {/* Total / accepted / rejected — the same three numbers the products
              side shows. The rejected card is gray at 0 (colour only when > 0)
              so a clean run doesn't read as alarming. */}
          <div className="cards-grid">
            <div className="card card-neutral">
              <span className="card-label">Total rows</span>
              <span className="card-value">{feedback.totalRows}</span>
            </div>
            <div className="card card-info">
              <span className="card-label">Accepted</span>
              <span className="card-value">{feedback.successCount}</span>
            </div>
            <div className={`card ${feedback.errorCount > 0 ? 'card-error' : 'card-zero'}`}>
              <span className="card-label">Rejected</span>
              <span className="card-value">{feedback.errorCount}</span>
            </div>
          </div>

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
        </div>
      )}
    </div>
  );
}
