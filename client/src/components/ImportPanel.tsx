import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  checkShopifyHealth,
  cleanupImportRun,
  cleanupQaCustomers,
  fetchImportFeedback,
  fetchLatestImportForValidation,
  fetchShopifyStores,
  fetchStoreCustomerStats,
  fetchValidatorFeedbackMarkdown,
  getImportReportDownloadUrl,
  getValidatorFeedbackReportUrl,
  runBatchImport,
  runImport,
} from '../api/validationApi';
import {
  CleanupResult,
  ImportFeedback,
  RuleGap,
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

function RuleGapList({ gaps }: { gaps: RuleGap[] }) {
  if (gaps.length === 0) {
    return <p className="muted">No rule gaps — every Shopify rejection was already flagged.</p>;
  }
  return (
    <table className="issues-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Code</th>
          <th>Rows</th>
          <th>Existing validator</th>
          <th>Sample message</th>
        </tr>
      </thead>
      <tbody>
        {gaps.map((g) => (
          <tr key={`${g.shopifyField}|${g.shopifyCode}`}>
            <td>{g.shopifyField ?? '—'}</td>
            <td>{g.shopifyCode ?? '—'}</td>
            <td>{g.count}</td>
            <td>
              {g.existingValidator ? (
                <span title="A validator exists but missed these rows — likely a rule gap/bug.">
                  {g.existingValidator} ⚠
                </span>
              ) : (
                <span className="badge-missing" title="No validator covers this — candidate new rule.">
                  none — new rule
                </span>
              )}
            </td>
            <td className="cell-message">{g.sampleMessages[0] ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ImportPanel({ result }: Props) {
  const [health, setHealth] = useState<ShopifyHealth | null>(null);
  const [stores, setStores] = useState<ShopifyStore[]>([]);
  // Two explicit flows: 'single' (pick one store) or 'parallel' (pick 2+ stores,
  // split the file across them). The first selected store is the "primary" that
  // drives the health/stats panel.
  const [importMode, setImportMode] = useState<'single' | 'parallel'>('single');
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const primaryStoreId = selectedStoreIds[0];
  const [stats, setStats] = useState<StoreCustomerStats | null>(null);
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null);
  const [running, setRunning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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

  useEffect(() => {
    let active = true;
    setHealth(null);
    setStats(null);
    checkShopifyHealth(primaryStoreId)
      .then((h) => active && setHealth(h))
      .catch(() => active && setHealth({ ok: false, error: 'Could not reach the server.' }));
    if (primaryStoreId) {
      fetchStoreCustomerStats(primaryStoreId)
        .then((data) => active && setStats(data))
        .catch(() => active && setError('Could not load test-store customer counts.'));
    }
    return () => {
      active = false;
    };
  }, [primaryStoreId]);

  // On a different validation run (incl. reopening one from History), load its
  // most recent import so status / verification report / cleanup are available
  // again. If that import is still RUNNING, the poll effect below resumes it.
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

  // Reconcile-on-poll: while the run is non-terminal, poll GET /:id (which pokes
  // Shopify and finalizes when the bulk op is done). The dependency on `status`
  // (not the whole object) keeps one interval alive across same-status polls and
  // tears it down once the run reaches a terminal state.
  const pollStatus = feedback?.status;
  const pollRunId = feedback?.importRunId;
  useEffect(() => {
    if (!pollRunId || !pollStatus || isTerminal(pollStatus)) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await fetchImportFeedback(pollRunId);
        if (!active) return;
        setFeedback(next);
        if (isTerminal(next.status)) {
          clearInterval(timer);
          if (primaryStoreId) {
            fetchStoreCustomerStats(primaryStoreId)
              .then((d) => active && setStats(d))
              .catch(() => undefined);
          }
        }
      } catch (err) {
        if (!active) return;
        clearInterval(timer);
        setError(errMessage(err, 'Failed to check import status.'));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollRunId, pollStatus, primaryStoreId]);

  // When a run is opened from History, point the store selector at the store the
  // import actually used (by storeId; fall back to matching the shop domain for
  // legacy runs) instead of leaving it on the default first chip.
  // Only meaningful for a single-store run (a batch parent has storeId null and a
  // joined shopDomain that won't match a single chip — selection is left as-is).
  const feedbackStoreId = feedback?.storeId ?? null;
  const feedbackShopDomain = feedback?.shopDomain;
  useEffect(() => {
    if (!feedbackStoreId && !feedbackShopDomain) return;
    const target =
      feedbackStoreId ?? stores.find((s) => s.shop === feedbackShopDomain)?.id;
    if (target) setSelectedStoreIds([target]);
  }, [feedbackStoreId, feedbackShopDomain, stores]);

  const handleRun = async () => {
    if (selectedStoreIds.length === 0) return;
    setRunning(true);
    setError('');
    setNotice('');
    try {
      // Returns immediately with status RUNNING; the poll effect drives it to a
      // terminal state and refreshes store stats once finished. 2+ stores → the
      // rows are split and imported in parallel, then merged into one report.
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

  const handleRefresh = async () => {
    if (!feedback) return;
    setFeedback(await fetchImportFeedback(feedback.importRunId));
    if (primaryStoreId) {
      setStats(await fetchStoreCustomerStats(primaryStoreId));
    }
  };

  const handleDownloadReport = () => {
    if (!feedback) return;
    window.open(getImportReportDownloadUrl(feedback.importRunId), '_blank');
  };

  const handleDownloadFeedbackReport = () => {
    if (!feedback) return;
    window.open(getValidatorFeedbackReportUrl(feedback.importRunId), '_blank');
  };

  const handleCopyForClaude = async () => {
    if (!feedback) return;
    setError('');
    setNotice('');
    try {
      const markdown = await fetchValidatorFeedbackMarkdown(feedback.importRunId);
      await navigator.clipboard.writeText(markdown);
      setNotice('Copied — paste into Claude to fix the validators.');
    } catch (err) {
      setError(errMessage(err, 'Could not copy the validator report.'));
    }
  };

  const applyCleanupResult = async (cleanup: Promise<CleanupResult>) => {
    setCleaning(true);
    setError('');
    setNotice('');
    try {
      const result = await cleanup;
      setNotice(
        `Cleanup complete: deleted ${result.deleted} of ${result.found} customer(s) tagged "${result.tag}".`,
      );
      if (primaryStoreId) {
        setStats(await fetchStoreCustomerStats(primaryStoreId));
      }
    } catch (err) {
      setError(errMessage(err, 'Cleanup failed.'));
    } finally {
      setCleaning(false);
    }
  };

  const handleCleanupAllQa = () => {
    if (!primaryStoreId || !stats) return;
    if (
      !window.confirm(
        `Delete all ${stats.qaImportCustomers} customer(s) tagged qa-import from this test store?`,
      )
    ) {
      return;
    }
    void applyCleanupResult(cleanupQaCustomers(primaryStoreId));
  };

  const handleCleanupImportRun = () => {
    if (!feedback) return;
    if (
      !window.confirm(
        `Delete customers created by import ${feedback.importRunId.slice(0, 8)} only?`,
      )
    ) {
      return;
    }
    void applyCleanupResult(cleanupImportRun(feedback.importRunId, primaryStoreId));
  };

  const s = feedback?.summary;
  const polling = !!feedback && !isTerminal(feedback.status);
  const completed = feedback?.status === 'COMPLETED';
  const failed = !!feedback && isTerminal(feedback.status) && !completed;
  const busy = running || polling;
  // Show the merged results (cards + report buttons) whenever the run is terminal
  // and produced rows — including a FAILED batch where some stores still imported.
  const showResults = !!feedback && isTerminal(feedback.status) && feedback.totalRows > 0;

  // Single needs exactly one store; parallel needs at least two.
  const canImport =
    importMode === 'parallel' ? selectedStoreIds.length >= 2 : selectedStoreIds.length === 1;

  const switchMode = (mode: 'single' | 'parallel') => {
    setImportMode(mode);
    setError('');
    // Collapse to a single selection when leaving parallel mode.
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
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running || polling || health?.ok === false || !canImport}
        >
          {running || polling
            ? 'Importing… (running in Shopify)'
            : importMode === 'parallel'
              ? selectedStoreIds.length >= 2
                ? `Import to ${selectedStoreIds.length} stores in parallel`
                : 'Import in parallel'
              : 'Import to test store'}
        </button>
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
                disabled={running || polling}
              >
                Single store import
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importMode === 'parallel'}
                className={`mode-tab ${importMode === 'parallel' ? 'active' : ''}`}
                onClick={() => switchMode('parallel')}
                disabled={running || polling}
              >
                Parallel import
              </button>
            </div>
          )}

          <p className="muted store-selector-hint">
            {importMode === 'parallel'
              ? 'Select two or more stores — the file is split evenly across them and the results merge into one report.'
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

          {importMode === 'parallel' && (
            <p className="muted">
              {selectedStoreIds.length >= 2
                ? `Parallel import across ${selectedStoreIds.length} stores selected.`
                : 'Select at least 2 stores to import in parallel.'}
            </p>
          )}
        </>
      )}

      {health && !health.ok && (
        <div className="error-banner">
          Shopify not ready: {health.error ?? 'unknown'}
          {health.hint ? ` — ${health.hint}` : ''}
          {health.missingScopes && health.missingScopes.length > 0
            ? ` (missing scopes: ${health.missingScopes.join(', ')})`
            : ''}
        </div>
      )}
      {health?.ok && (
        <div className="store-status">
          <p className="muted">
            Connected to <strong>{health.label ?? health.shop}</strong>
            {health.shop ? ` (${health.shop})` : ''} on API {health.apiVersion}.
          </p>
          {stats && (
            <div className="store-stats">
              <span>Total customers: <strong>{stats.totalCustomers}</strong></span>
              <span>QA imports: <strong>{stats.qaImportCustomers}</strong></span>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleCleanupAllQa}
                disabled={cleaning || stats.qaImportCustomers === 0}
              >
                {cleaning ? 'Cleaning...' : 'Clean all QA imports'}
              </button>
            </div>
          )}
        </div>
      )}

      {result.errors > 0 && !feedback && (
        <div className="warning-banner">
          ⚠ This run has {result.errors} error(s). Importing anyway will test whether
          Shopify actually rejects them (catches over-strict rules).
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

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
            <div className="toolbar-actions">
              <button className="btn btn-outline btn-sm" onClick={handleRefresh}>
                Refresh
              </button>
            </div>
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
              <button className="btn btn-primary btn-sm" onClick={handleCopyForClaude}>
                Copy for Claude
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleDownloadFeedbackReport}>
                Download .md
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleDownloadReport}>
                Download verification report
              </button>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleCleanupImportRun}
                disabled={cleaning}
              >
                {cleaning ? 'Cleaning...' : 'Clean this import'}
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleRefresh}>
                Refresh
              </button>
            </div>
          </div>

          <div className="cards-grid">
            <div className="card card-error">
              <span className="card-label">Missing rule (rejected, not flagged)</span>
              <span className="card-value">{s.missingRule.count}</span>
            </div>
            <div className="card card-warning">
              <span className="card-label">False positive (flagged, accepted)</span>
              <span className="card-value">{s.falsePositive.count}</span>
            </div>
            <div className="card card-neutral">
              <span className="card-label">Confirmed reject</span>
              <span className="card-value">{s.confirmedReject.count}</span>
            </div>
            <div className="card card-info">
              <span className="card-label">Confirmed clean</span>
              <span className="card-value">{s.confirmedClean.count}</span>
            </div>
          </div>

          <h3 className="subsection-title">Rule-gap backlog (this run)</h3>
          <RuleGapList gaps={feedback.ruleGaps} />

          {s.falsePositive.count > 0 && (
            <>
              <h3 className="subsection-title">
                Over-strict — we flagged, Shopify accepted
              </h3>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
