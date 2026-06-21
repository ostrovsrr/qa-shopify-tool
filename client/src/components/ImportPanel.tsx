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
  getImportReportDownloadUrl,
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
  const [selectedStoreId, setSelectedStoreId] = useState<string | undefined>();
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
        setSelectedStoreId((current) => current ?? data[0]?.id);
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
    checkShopifyHealth(selectedStoreId)
      .then((h) => active && setHealth(h))
      .catch(() => active && setHealth({ ok: false, error: 'Could not reach the server.' }));
    if (selectedStoreId) {
      fetchStoreCustomerStats(selectedStoreId)
        .then((data) => active && setStats(data))
        .catch(() => active && setError('Could not load test-store customer counts.'));
    }
    return () => {
      active = false;
    };
  }, [selectedStoreId]);

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
          if (selectedStoreId) {
            fetchStoreCustomerStats(selectedStoreId)
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
  }, [pollRunId, pollStatus, selectedStoreId]);

  // When a run is opened from History, point the store selector at the store the
  // import actually used (by storeId; fall back to matching the shop domain for
  // legacy runs) instead of leaving it on the default first chip.
  const feedbackStoreId = feedback?.storeId ?? null;
  const feedbackShopDomain = feedback?.shopDomain;
  useEffect(() => {
    if (!feedbackShopDomain && !feedbackStoreId) return;
    const target =
      feedbackStoreId ?? stores.find((s) => s.shop === feedbackShopDomain)?.id;
    if (target) setSelectedStoreId(target);
  }, [feedbackStoreId, feedbackShopDomain, stores]);

  const handleRun = async () => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      // Returns immediately with status RUNNING; the poll effect drives it to a
      // terminal state and refreshes store stats once finished.
      const data = await runImport(result.validationId, selectedStoreId);
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
    if (selectedStoreId) {
      setStats(await fetchStoreCustomerStats(selectedStoreId));
    }
  };

  const handleDownloadReport = () => {
    if (!feedback) return;
    window.open(getImportReportDownloadUrl(feedback.importRunId), '_blank');
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
      if (selectedStoreId) {
        setStats(await fetchStoreCustomerStats(selectedStoreId));
      }
    } catch (err) {
      setError(errMessage(err, 'Cleanup failed.'));
    } finally {
      setCleaning(false);
    }
  };

  const handleCleanupAllQa = () => {
    if (!selectedStoreId || !stats) return;
    if (
      !window.confirm(
        `Delete all ${stats.qaImportCustomers} customer(s) tagged qa-import from this test store?`,
      )
    ) {
      return;
    }
    void applyCleanupResult(cleanupQaCustomers(selectedStoreId));
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
    void applyCleanupResult(cleanupImportRun(feedback.importRunId, selectedStoreId));
  };

  const s = feedback?.summary;
  const polling = !!feedback && !isTerminal(feedback.status);
  const completed = feedback?.status === 'COMPLETED';
  const failed = !!feedback && isTerminal(feedback.status) && !completed;

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
          disabled={running || polling || health?.ok === false || !selectedStoreId}
        >
          {running || polling
            ? 'Importing… (running in Shopify)'
            : 'Import to test store'}
        </button>
      </div>

      {stores.length > 0 && (
        <div className="store-selector">
          {stores.map((store) => (
            <button
              key={store.id}
              className={`store-chip ${selectedStoreId === store.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedStoreId(store.id);
                setFeedback(null);
                setError('');
              }}
              type="button"
            >
              <span>{store.label}</span>
              <small>{store.shop}</small>
            </button>
          ))}
        </div>
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

      {completed && s && (
        <div className="import-results">
          <div className="import-toolbar">
            <span className="muted">
              Import {feedback.importRunId.slice(0, 8)} · {feedback.status} ·{' '}
              {feedback.successCount} accepted / {feedback.errorCount} rejected of{' '}
              {feedback.totalRows}
            </span>
            <div className="toolbar-actions">
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
