import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  checkShopifyHealth,
  fetchImportFeedback,
  runImport,
} from '../api/validationApi';
import { ImportFeedback, RuleGap, ShopifyHealth, ValidationResult } from '../types';

interface Props {
  result: ValidationResult;
}

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
  const [feedback, setFeedback] = useState<ImportFeedback | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    checkShopifyHealth()
      .then((h) => active && setHealth(h))
      .catch(() => active && setHealth({ ok: false, error: 'Could not reach the server.' }));
    return () => {
      active = false;
    };
  }, []);

  // Reset when switching to a different validation run.
  useEffect(() => {
    setFeedback(null);
    setError('');
  }, [result.validationId]);

  const handleRun = async () => {
    setRunning(true);
    setError('');
    try {
      const data = await runImport(result.validationId);
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
  };

  const s = feedback?.summary;

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
          disabled={running || health?.ok === false}
        >
          {running ? 'Importing… (bulk op may take a minute)' : 'Import to test store'}
        </button>
      </div>

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
        <p className="muted">
          Connected to <strong>{health.shop}</strong> (API {health.apiVersion}).
        </p>
      )}

      {result.errors > 0 && !feedback && (
        <div className="warning-banner">
          ⚠ This run has {result.errors} error(s). Importing anyway will test whether
          Shopify actually rejects them (catches over-strict rules).
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {feedback && s && (
        <div className="import-results">
          <div className="import-toolbar">
            <span className="muted">
              Import {feedback.importRunId.slice(0, 8)} · {feedback.status} ·{' '}
              {feedback.successCount} accepted / {feedback.errorCount} rejected of{' '}
              {feedback.totalRows}
            </span>
            <button className="btn btn-outline btn-sm" onClick={handleRefresh}>
              Refresh
            </button>
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
