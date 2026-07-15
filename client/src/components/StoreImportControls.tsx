import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  checkShopifyHealth,
  cleanupImportRun,
  cleanupQaProducts,
  fetchImportFeedback,
  fetchLatestImportForUpload,
  fetchShopifyStores,
  fetchStoreProductStats,
  getImportReportDownloadUrl,
  runBatchImport,
  runImport,
} from '../api/productApi';
import {
  ProductImportFeedback,
  ShopifyHealth,
  ShopifyStore,
  StoreProductStats,
} from '../types';
import { ProductResultsView } from './ProductResultsView';

interface Props {
  uploadId: string;
  productCount: number;
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
// previewed batch sizes (in products) match what each store actually receives.
function batchSizeFor(index: number, total: number, n: number): number {
  if (n <= 0) return 0;
  const base = Math.floor(total / n);
  const remainder = total % n;
  return base + (index < remainder ? 1 : 0);
}

export function StoreImportControls({ uploadId, productCount }: Props) {
  const [stores, setStores] = useState<ShopifyStore[]>([]);
  // Two explicit flows. Parallel has a lock-in step: 'select' (pick stores) →
  // 'review' (locked, shows the per-store batch plan) → import.
  const [importMode, setImportMode] = useState<'single' | 'parallel'>('single');
  const [parallelPhase, setParallelPhase] = useState<'select' | 'review'>('select');
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [storeHealth, setStoreHealth] = useState<Record<string, ShopifyHealth>>({});
  const [storeStats, setStoreStats] = useState<Record<string, StoreProductStats>>({});
  const [cleaningStores, setCleaningStores] = useState<Set<string>>(new Set());
  const [cleaningRun, setCleaningRun] = useState(false);
  const [feedback, setFeedback] = useState<ProductImportFeedback | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const primaryStoreId = selectedStoreIds[0];
  const inParallelSelect = importMode === 'parallel' && parallelPhase === 'select';
  const inParallelReview = importMode === 'parallel' && parallelPhase === 'review';

  const displayedStoreIds =
    importMode === 'single'
      ? primaryStoreId
        ? [primaryStoreId]
        : []
      : inParallelReview
        ? selectedStoreIds
        : [];
  const displayKey = displayedStoreIds.join(',');
  const displayedRef = useRef<string[]>(displayedStoreIds);
  displayedRef.current = displayedStoreIds;

  const storeLabel = (storeId: string): string =>
    stores.find((s) => s.id === storeId)?.label ?? storeId;

  // ── load stores ────────────────────────────────────────────────────────────
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

  // ── health + stats for the displayed stores ──────────────────────────────────
  useEffect(() => {
    if (displayedStoreIds.length === 0) return;
    let active = true;
    for (const id of displayedStoreIds) {
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
      fetchStoreProductStats(id)
        .then((st) => active && setStoreStats((m) => ({ ...m, [id]: st })))
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayKey]);

  // ── restore the latest import when (re)opening an upload ──────────────────────
  useEffect(() => {
    let active = true;
    setFeedback(null);
    setError('');
    fetchLatestImportForUpload(uploadId)
      .then((f) => active && f && setFeedback(f))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [uploadId]);

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
            fetchStoreProductStats(id)
              .then((st) => active && setStoreStats((m) => ({ ...m, [id]: st })))
              .catch(() => undefined);
          }
        } else {
          // Schedule only after this request finishes so a slow reconcile never
          // overlaps another request for the same import run.
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
    const target = feedbackStoreId ?? stores.find((s) => s.shop === feedbackShopDomain)?.id;
    if (target) {
      setSelectedStoreIds([target]);
      setImportMode('single');
      setParallelPhase('select');
    }
  }, [feedbackStoreId, feedbackShopDomain, stores]);

  // ── derived flags ─────────────────────────────────────────────────────────────
  const polling = !!feedback && !isTerminal(feedback.status);
  const completed = feedback?.status === 'COMPLETED';
  const failed = !!feedback && isTerminal(feedback.status) && !completed;
  const busy = running || polling;
  const showResults = !!feedback && isTerminal(feedback.status) && feedback.totalProducts > 0;

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
      // terminal state. 2+ stores → products split and imported in parallel.
      const data =
        importMode === 'parallel'
          ? await runBatchImport(uploadId, selectedStoreIds)
          : await runImport(uploadId, selectedStoreIds[0]);
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

  const refreshStoreStats = async (storeId: string) => {
    const st = await fetchStoreProductStats(storeId).catch(() => null);
    if (st) setStoreStats((m) => ({ ...m, [storeId]: st }));
  };

  const cleanStore = async (storeId: string) => {
    // The count may still be loading, and that is fine — the cleanup re-reads the
    // store to find what to delete. Say "every" rather than block on a number.
    const st = storeStats[storeId];
    const howMany = st ? `${st.qaImportProducts.toLocaleString()} product(s)` : 'every product';
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
      const res = await cleanupQaProducts(storeId);
      setNotice(`Cleaned ${res.deleted} of ${res.found} qa-import product(s) from ${res.shop}.`);
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
    if (!window.confirm(`Delete all qa-import products from ${ids.length} store(s)?`)) return;
    setError('');
    setNotice('');
    // Mark every store as cleaning up front, then delete them all in parallel —
    // each store is a separate shop, so their (bulk) deletes run concurrently
    // instead of store-after-store.
    setCleaningStores((prev) => new Set([...prev, ...ids]));
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await cleanupQaProducts(id);
          await refreshStoreStats(id);
          return { deleted: res.deleted, error: null as string | null };
        } catch (err) {
          return { deleted: 0, error: errMessage(err, `Cleanup failed for ${storeLabel(id)}.`) };
        } finally {
          setCleaningStores((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }),
    );
    const totalDeleted = results.reduce((n, r) => n + r.deleted, 0);
    const failures = results.map((r) => r.error).filter((e): e is string => e !== null);
    if (failures.length > 0) setError(failures.join(' | '));
    setNotice(`Cleaned ${totalDeleted} qa-import product(s) across ${ids.length} store(s).`);
  };

  const handleCleanupImportRun = async () => {
    if (!feedback) return;
    if (
      !window.confirm(
        `Delete products created by import ${feedback.importRunId.slice(0, 8)} (across all its stores)?`,
      )
    ) {
      return;
    }
    setCleaningRun(true);
    setError('');
    setNotice('');
    try {
      const res = await cleanupImportRun(feedback.importRunId, primaryStoreId);
      setNotice(`Deleted ${res.deleted} of ${res.found} product(s) for this import (${res.shop}).`);
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
      ? batchSizeFor(index, productCount, selectedStoreIds.length)
      : null;
    const pct =
      batch !== null && productCount > 0 ? Math.round((batch / productCount) * 100) : null;

    return (
      <div className="store-card" key={storeId}>
        <div className="store-card-head">
          <div>
            <div className="store-card-name">{store?.label ?? storeId}</div>
            <div className="store-card-shop">{store?.shop ?? ''}</div>
          </div>
          <span className={`store-card-badge ${h ? (h.ok ? 'ok' : 'bad') : 'pending'}`}>
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
                {batch} product{batch === 1 ? '' : 's'}
              </strong>
              {pct !== null ? ` (${pct}%)` : ''}
              {batch === 0 ? ' — skipped' : ''}
            </span>
          )}
          <span>
            Total products:{' '}
            <strong>{st ? st.totalProducts.toLocaleString() : 'counting…'}</strong>
          </span>
          <span>
            QA imports:{' '}
            <strong>{st ? st.qaImportProducts.toLocaleString() : 'counting…'}</strong>
          </span>
        </div>

        <button
          className="btn btn-outline btn-sm"
          onClick={() => cleanStore(storeId)}
          disabled={cleaning || (st != null && st.qaImportProducts === 0)}
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
            Imports these products into the Shopify test store(s) and reports what Shopify
            accepted or rejected, grouped by (field, code).
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
                  ? 'Select two or more stores, then confirm to see how the products split across them.'
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
                {productCount} products total
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
              <span className="spinner" /> Import {feedback.importRunId.slice(0, 8)} · running in
              Shopify… polling for results
            </span>
            {/* No Refresh button. Polling is already re-fetching this exact
                feedback (see the polling effect), so the button did nothing the app
                was not doing anyway — it just implied the user had to act. */}
          </div>
        </div>
      )}

      {showResults && (
        <ProductResultsView
          feedback={feedback}
          stores={stores}
          cleaningRun={cleaningRun}
          onDownloadReport={handleDownloadReport}
          onCleanupRun={handleCleanupImportRun}
        />
      )}
    </div>
  );
}
